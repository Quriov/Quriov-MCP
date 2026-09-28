// 和服务端说话的唯一出口（传输层）：MCP JSON-RPC + 参考图上传 + 下载结果图。
//
// 命令行其余部分只通过 QuriovClient 的这几个方法和服务端打交道：
//   listTools / capabilities / account / estimate / generateImage / listGenerations / upload / download
// 以后改成直接调 /api/v1/mcp/* 时，只换这个文件，方法签名和返回形状保持不变。
//
// 安全边界：钥匙只放在 Authorization 头里；下载结果图【不带】钥匙；只连 common.mjs 里的固定地址
// 和服务端返回的 https 结果链接。

import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

import {
  CliError,
  MCP_ENDPOINT,
  ORIGIN,
  UPLOAD_ENDPOINT,
  USER_AGENT,
  VERSION,
  describeError,
  realSleep,
  sha256,
  unauthorizedError,
  writeAtomic,
} from "./common.mjs";

export const PROTOCOL_VERSION = "2025-06-18";
// 服务端现状：每把钥匙每分钟有请求上限，MCP 每调一次工具服务端算 2 次，所以这里自己控速。
// 服务端撤掉限流、命令行改直连接口后，RequestBudget 和 401 当限流的重试一起删掉。
export const DEFAULT_REQUESTS_PER_MINUTE = 26;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const IMAGE_EXTENSIONS = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

export class RequestBudget {
  constructor({ perMinute = DEFAULT_REQUESTS_PER_MINUTE, now = Date.now, sleep = realSleep } = {}) {
    this.perMinute = perMinute;
    this.now = now;
    this.sleep = sleep;
    this.stamps = [];
  }

  async take(cost) {
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < 60_000);
      if (this.stamps.length + cost <= this.perMinute) {
        for (let i = 0; i < cost; i += 1) this.stamps.push(t);
        return;
      }
      const waitMs = 60_000 - (t - this.stamps[0]) + 50;
      await this.sleep(Math.max(waitMs, 50));
    }
  }
}

function parseRpcBody(text, contentType) {
  if (contentType.includes("text/event-stream") || text.startsWith("event:") || text.startsWith("data:")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        return JSON.parse(data);
      } catch {
        // 下一行
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// MCP 工具出错时，结果是 isError + 一段文字，文字里嵌着服务端的公开错误 JSON：
//   Error executing tool generate_image: {"code":"rate_limited",...}
export function parseToolError(result) {
  const text = (result?.content ?? [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start));
      if (parsed && typeof parsed.code === "string") return parsed;
    } catch {
      // 落到下面
    }
  }
  return { code: "service_unavailable", message: "unparseable tool error", retryable: true };
}

export class QuriovClient {
  // keys：按优先级排好的候选钥匙 [{ key, source }]。第一把没通过验证（从没成功过就 401）时，
  // 自动换下一把并提示用户删掉失效的那个来源；只在还没成功过任何请求时换，换过就不再换回。
  constructor({
    key,
    keySource = null,
    fallbacks = [],
    fetchImpl = globalThis.fetch,
    sleep = realSleep,
    now = Date.now,
    requestsPerMinute = DEFAULT_REQUESTS_PER_MINUTE,
    log = () => {},
  }) {
    if (!key) throw new CliError("missing_key", "内部错误：没有钥匙。", { exitCode: 2 });
    this.key = key;
    this.keySource = keySource;
    this.fallbacks = fallbacks.filter((f) => f?.key && f.key !== key);
    this.rejectedSources = [];
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
    this.log = log;
    this.budget = new RequestBudget({ perMinute: requestsPerMinute, now, sleep });
    this.everSucceeded = false;
    this.initialized = false;
    this.rpcId = 0;
  }

  async _post(url, init, { cost, label }) {
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt += 1) {
      await this.budget.take(cost);
      let response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${this.key}`, "User-Agent": USER_AGENT },
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        if (attempt < maxAttempts) {
          this.log(`  网络请求失败（${label}），${attempt * 5} 秒后重试…`);
          await this.sleep(attempt * 5000);
          continue;
        }
        throw new CliError(
          "network_error",
          `连不上 ${ORIGIN}（${label}，已重试 ${maxAttempts} 次）。检查网络 / 代理后运行 resume 接着跑。`,
          { exitCode: 4 },
        );
      }

      if (response.status === 401) {
        // 服务端把「钥匙无效」和「每分钟限流」都报成 401。钥匙之前用过 ⇒ 按限流等一分钟再试。
        if (this.everSucceeded && attempt < 3) {
          this.log("  服务端回 401（钥匙刚才还能用，多半是请求太密被限流），等 65 秒后重试…");
          await this.sleep(65_000);
          continue;
        }
        if (this._switchKey()) continue;
        throw unauthorizedError(this.everSucceeded, this.keySource);
      }
      if (response.status === 403) {
        const body = await response.text().catch(() => "");
        if (/error code:\s*1010/i.test(body)) {
          throw new CliError(
            "blocked_by_firewall",
            "请求被网站防火墙拦下（Cloudflare 1010，按请求特征拦的，不是钥匙问题）。请把完整报错发给 Quriov 管理员。",
          );
        }
        throw new CliError("insufficient_scope", describeError("insufficient_scope"));
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxAttempts) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const waitS = Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 120 ? retryAfter : attempt * 10;
          this.log(`  服务端忙（HTTP ${response.status}，${label}），${waitS} 秒后重试…`);
          await this.sleep(waitS * 1000);
          continue;
        }
        throw new CliError(
          "service_unavailable",
          `服务端连续返回 HTTP ${response.status}（${label}）。${describeError("service_unavailable")}`,
          { exitCode: 4 },
        );
      }
      return response;
    }
  }

  _switchKey() {
    if (this.everSucceeded || !this.fallbacks.length) return false;
    const next = this.fallbacks.shift();
    this.log(`  ${this.keySource ?? "当前钥匙"}没通过验证，改用${next.source}再试…`);
    this.rejectedSources.push(this.keySource);
    this.key = next.key;
    this.keySource = next.source;
    this.initialized = false;
    return true;
  }

  async rpc(method, params) {
    const id = (this.rpcId += 1);
    const response = await this._post(
      MCP_ENDPOINT,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": PROTOCOL_VERSION,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      },
      // 每个打到 /mcp/v1 的请求服务端都先验一次钥匙；tools/call 另外再干一次活。
      { cost: method === "tools/call" ? 2 : 1, label: params?.name ?? method },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new CliError("http_error", `服务端返回 HTTP ${response.status}（${params?.name ?? method}）。`);
    }
    const body = parseRpcBody(text, response.headers.get("content-type") ?? "");
    if (!body) throw new CliError("invalid_response", `服务端的回应看不懂（${params?.name ?? method}）。`);
    if (body.error) {
      throw new CliError(
        "protocol_error",
        `MCP 协议错误 ${body.error.code ?? ""}（${params?.name ?? method}）。可能是命令行版本太旧，升级后再试。`,
      );
    }
    this.everSucceeded = true;
    return body.result;
  }

  async initialize() {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "quriov-cli", version: VERSION },
    });
    this.initialized = true;
  }

  async callTool(name, args = {}) {
    await this.initialize();
    for (let attempt = 1; ; attempt += 1) {
      const result = await this.rpc("tools/call", { name, arguments: args });
      if (result?.isError !== true) {
        if (result?.structuredContent && typeof result.structuredContent === "object") {
          return result.structuredContent;
        }
        const text = (result?.content ?? []).find((c) => c?.type === "text")?.text;
        try {
          return JSON.parse(text);
        } catch {
          throw new CliError("invalid_response", `服务端的回应看不懂（${name}）。`);
        }
      }
      const error = parseToolError(result);
      const retryAfter = Number.isFinite(error.retry_after_seconds) ? error.retry_after_seconds : null;
      if (error.code === "rate_limited") {
        // 同一个码既表示「每分钟上限」（等 60 秒）也表示「今天的提交次数用完」（等到零点 UTC）。
        if (retryAfter !== null && retryAfter > 120) {
          throw new CliError(
            "daily_quota_exhausted",
            "今天的提交次数用完了（服务端的每日提交上限）。",
            { exitCode: 4, retryAfterSeconds: retryAfter },
          );
        }
        if (attempt < 4) {
          const waitS = retryAfter ?? 60;
          this.log(`  请求太密被服务端限流，${waitS} 秒后自动重试…`);
          await this.sleep(waitS * 1000);
          continue;
        }
        throw new CliError("rate_limited", "连续被服务端限流。几分钟后运行 resume。", {
          exitCode: 4,
        });
      }
      if (error.code === "service_unavailable" && attempt < 3) {
        this.log(`  出图服务暂时不可用（${name}），${attempt * 15} 秒后重试…`);
        await this.sleep(attempt * 15_000);
        continue;
      }
      if (error.code === "unauthorized") {
        if (this._switchKey()) continue;
        throw unauthorizedError(false, this.keySource);
      }
      if (error.code === "insufficient_scope") throw new CliError("insufficient_scope", describeError("insufficient_scope"));
      throw new CliError(error.code, describeError(error.code), { fatal: error.code === "insufficient_credits" });
    }
  }

  // 自检用：服务端公开的工具名单（只看名字）。
  async listTools() {
    await this.initialize();
    const result = await this.rpc("tools/list", {});
    if (!Array.isArray(result?.tools)) throw new CliError("invalid_response", "服务端没返回工具清单。");
    return result.tools.map((tool) => tool?.name).filter((name) => typeof name === "string");
  }

  capabilities() {
    return this.callTool("list_capabilities");
  }

  account() {
    return this.callTool("get_account");
  }

  estimate({ modelId, pricingUnit, units }) {
    return this.callTool("estimate_cost", { model_id: modelId, pricing_unit: pricingUnit, units });
  }

  generateImage(args) {
    return this.callTool("generate_image", args);
  }

  listGenerations() {
    return this.callTool("list_generations");
  }

  async upload(filePath, { readFile = readFileSync } = {}) {
    const type = IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
    if (!type) {
      throw new CliError("unsupported_media_format", `参考图 ${filePath} 不是 JPG / PNG / WebP。`, { fatal: false });
    }
    let bytes;
    try {
      bytes = readFile(filePath);
    } catch {
      throw new CliError("missing_reference", `读不到参考图 ${filePath}（路径不对或没有权限）。`, { fatal: false });
    }
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new CliError("media_too_large", `参考图 ${filePath} 有 ${(bytes.length / 1048576).toFixed(1)} MB，超过 10 MB 上限。`, {
        fatal: false,
      });
    }
    const form = new FormData();
    form.append("file", new Blob([bytes], { type }), basename(filePath));
    const response = await this._post(UPLOAD_ENDPOINT, { method: "POST", body: form }, { cost: 1, label: "上传参考图" });
    if (response.status === 413) {
      throw new CliError("media_too_large", `参考图 ${filePath} 超过 10 MB 上限。`, { fatal: false });
    }
    if (response.status === 415) {
      throw new CliError("unsupported_media_format", `参考图 ${filePath} 不是真正的 JPG / PNG / WebP（按文件内容判断，改扩展名没用）。`, {
        fatal: false,
      });
    }
    if (!response.ok) {
      throw new CliError("upload_failed", `参考图 ${filePath} 上传失败（HTTP ${response.status}）。`, { fatal: false });
    }
    const body = await response.json().catch(() => null);
    if (typeof body?.url !== "string" || !body.url.startsWith("https://")) {
      throw new CliError("invalid_response", "上传接口的回应看不懂。");
    }
    this.everSucceeded = true;
    return { url: body.url, expiresIn: Number(body.expires_in) || 86400, sha256: sha256(bytes) };
  }

  // 下载结果图：只接受 https；【不带】钥匙（链接本身已签名）；只用 GET（链接按 GET 签名，HEAD 会 403）。
  async download(url, destPath) {
    if (typeof url !== "string" || !url.startsWith("https://")) {
      throw new CliError("download_failed", "结果链接不是 https，拒绝下载。", { fatal: false });
    }
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(300_000),
      });
    } catch {
      throw new CliError("download_failed", "下载结果图时网络出错。", { fatal: false });
    }
    if (!response.ok) {
      throw new CliError("download_failed", `下载结果图失败（HTTP ${response.status}，链接可能过期，会重新取链接）。`, {
        fatal: false,
      });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new CliError("download_failed", "下载到的文件是空的。", { fatal: false });
    mkdirSync(dirname(destPath), { recursive: true });
    writeAtomic(destPath, bytes);
    return bytes.length;
  }
}
