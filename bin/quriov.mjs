#!/usr/bin/env node
// Quriov 官方命令行。零依赖（Node 20+ 自带的 fetch / FormData / fs）。
//
// 它和 Quriov MCP 用同一把钥匙、打同一个后端：出图 / 查询 / 估价 / 账户走公开的
// MCP 入口（下面 MCP_ENDPOINT），本地参考图上传走 UPLOAD_ENDPOINT。
// 扣点、失败退款、限流、出图记录全部在服务端，这里只做本机的事：读图上传、按表提交、
// 控速、轮询、下载到文件夹、写出每张花了多少点、断了能接着跑。
//
// 安全边界（见 AGENTS.md）：钥匙永远不从命令行参数读、不打印、不写进日志和状态文件；
// 下载结果图时【不带】钥匙；只连上面两个固定地址和它们返回的 https 结果链接。

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  chmodSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PROTOCOL_VERSION, runDoctor } from "./quriov-mcp-doctor.mjs";

export const VERSION = "1.1.0";
export const ORIGIN = "https://quriovai.com";
export const MCP_ENDPOINT = `${ORIGIN}/mcp/v1`;
export const UPLOAD_ENDPOINT = `${ORIGIN}/api/v1/mcp/uploads`;
export const USER_AGENT = `quriov-cli/${VERSION} (+https://github.com/Quriov/Quriov-MCP)`;

// 同一把钥匙在不同地方出现过三个名字（网页手工配置 / 网页「复制给 AI」/ 旧自检 skill）。
// 第一个是正式名字；另外两个照认，已经配好的人不用重配。
export const KEY_ENV_NAMES = Object.freeze([
  "QURIOV_MCP_ACCESS_KEY",
  "QURIOV_MCP_KEY",
  "QURIOV_ACCESS_KEY",
]);

// 服务端现状（后端未改）：每把钥匙每分钟 30 次请求；MCP 每调一次工具，服务端要先验钥匙
// 再干活 = 算 2 次。这里默认只用 26 次/分，给同一把钥匙在别处的零星调用留余量。
export const DEFAULT_REQUESTS_PER_MINUTE = 26;
export const DEFAULT_CONCURRENCY = 4; // 每个组织同时出图 4 张，再多只是在服务端排队
export const DEFAULT_POLL_SECONDS = 15;
export const MAX_IMAGES_PER_SUBMIT = 4;
export const MAX_PROMPT_CHARS = 8000;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_REUSE_MARGIN_MS = 2 * 3600 * 1000; // 参考图链接 24 小时有效；剩不到 2 小时就重传
const UNKNOWN_GIVE_UP_MS = 10 * 60 * 1000;
const MISSING_GIVE_UP_POLLS = 8;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const STATE_DIR = ".quriov";
const IMAGE_EXTENSIONS = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});
const EXT_BY_TYPE = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
});
const TERMINAL_OK = new Set(["succeeded", "partial"]);

// ---------------------------------------------------------------------------
// 报错：每一条都说清「到底是什么原因」和「下一步做什么」。
// ---------------------------------------------------------------------------

export class CliError extends Error {
  constructor(code, message, { exitCode = 1, retryAfterSeconds = null, fatal = true } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.retryAfterSeconds = retryAfterSeconds;
    this.fatal = fatal;
  }
}

// 服务端对外错误码（backend public_mcp.py _PUBLIC_ERRORS 白名单 + MCP 门面的状态码映射）。
export const ERROR_MESSAGES = Object.freeze({
  content_rejected: "内容审核没通过：提示词或参考图触发了内容政策，换个说法或换张图再试。",
  insufficient_credits: "余额不足：账户点数不够这次出图，充值或换组织钱包后再跑。",
  service_unavailable: "出图服务暂时不可用（服务端临时故障），稍后续跑即可，已提交的不会重复扣钱。",
  generation_failed: "这次生成失败了（服务端没给更细的原因），可以用 --retry-failed 重试。",
  invalid_request:
    "请求被拒：模型、提示词或选项有一项不被接受（服务端目前不告诉具体是哪一项，常见原因：提示词为空或超过 8000 字）。",
  invalid_media_encoding: "有一张参考图解不开（文件损坏或不是图片）。",
  unsupported_media_format: "参考图格式不支持：只收 JPG、PNG、WebP。",
  media_too_large: "参考图太大：单张不能超过 10 MB。",
  invalid_media_reference: "参考图链接取不到了（上传链接 24 小时有效）。用 --retry-failed 重试会自动重新上传。",
  too_many_media: "参考图张数超过这个模型的上限，减少几张再试。",
  missing_required_media: "这个模型必须带参考图。",
  invalid_options: "有选项这个模型不接受（比如画幅比例写法不对，应该像 1:1、3:4、9:16）。",
  unknown_template: "模板编号不存在。用 quriov models 看这把钥匙能用的模板编号。",
  invalid_batch_size: "张数只能是 1 到 4 的整数。",
  unsupported_model: "模型不可用（可能写错或已下架）。用 quriov models 看现在能用的模型。",
  validation_error: "请求参数不对（服务端没说是哪一项）。",
  insufficient_scope: "这把钥匙用途不对：命令行要网页上用途为「MCP」的钥匙，不是「API 调用」钥匙。",
  unauthorized: "钥匙没通过验证。",
  idempotency_conflict:
    "同一个任务编号被用在了内容不同的请求上（多半是状态文件被手改过）。用 --retry-failed 会换新编号重交。",
  lost_from_history:
    "在最近 50 条出图记录里找不到这条（同一把钥匙在别处提交得太多把它挤出去了；服务端暂时只能查最近 50 条）。结果如已生成，可在网页出图记录里找到。",
  download_failed: "图已生成、已扣点，但下载失败。稍后运行 resume 会自动重下（结果云端只留 1 天）。",
});

export function describeError(code, fallback) {
  return ERROR_MESSAGES[code] ?? fallback ?? `服务端返回错误：${code}`;
}

function unauthorizedError(everSucceeded) {
  if (everSucceeded) {
    return new CliError(
      "rate_limited_as_401",
      "服务端回了 401「需要登录」，但这把钥匙刚才还能用 —— 最可能是触发了每分钟请求上限（服务端目前把限流也报成 401）。已自动等过一分钟仍不行，请过几分钟再运行 resume。",
      { exitCode: 4 },
    );
  }
  return new CliError(
    "unauthorized",
    [
      "钥匙没通过验证（HTTP 401）。服务端不区分具体原因，常见的有三种：",
      "  1. 钥匙填错了或复制不全；",
      "  2. 钥匙已在网页上撤销；",
      "  3. 钥匙用途选成了「API 调用」—— 命令行和 MCP 要用途为「MCP」的钥匙。",
      `到 ${ORIGIN}/me/access-keys 检查或新建一把，再运行 quriov login。`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// 钥匙：环境变量（三个名字）→ quriov login 存下的文件。永远不从命令行参数读。
// ---------------------------------------------------------------------------

export function configDir({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (platform === "win32") {
    return join(env.APPDATA || join(home, "AppData", "Roaming"), "quriov");
  }
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "quriov");
}

export function credentialsPath(options) {
  return join(configDir(options), "credentials.json");
}

export function resolveKey({ env = process.env, readFile = readFileSync, path } = {}) {
  for (const name of KEY_ENV_NAMES) {
    const value = (env[name] ?? "").trim();
    if (value) return { key: value, source: `环境变量 ${name}` };
  }
  const file = path ?? credentialsPath({ env });
  try {
    const stored = JSON.parse(readFile(file, "utf8"));
    if (typeof stored?.key === "string" && stored.key.trim()) {
      return { key: stored.key.trim(), source: "quriov login 保存的钥匙" };
    }
  } catch {
    // 没登录过：落到下面的报错
  }
  return null;
}

export function requireKey(options) {
  const found = resolveKey(options);
  if (!found) {
    throw new CliError(
      "missing_key",
      [
        "没找到钥匙。二选一：",
        "  1. 运行 quriov login，粘贴网页上建的「MCP」钥匙（隐藏输入，存在本机用户目录）；",
        "  2. 设置环境变量 QURIOV_MCP_ACCESS_KEY（旧名字 QURIOV_MCP_KEY / QURIOV_ACCESS_KEY 也认）。",
        `钥匙在 ${ORIGIN}/me/access-keys 创建。出于安全，钥匙不能写在命令参数里。`,
      ].join("\n"),
      { exitCode: 2 },
    );
  }
  return found;
}

export function saveKey(key, { path, env = process.env } = {}) {
  const file = path ?? credentialsPath({ env });
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify({ key, savedAt: new Date().toISOString() })}\n`);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 不生效，文件本来就在当前用户目录下
  }
  return file;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const realSleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Windows 文件名里不能有的字符、结尾不能是点或空格、不能叫 CON 之类。
export function safeName(raw) {
  let name = String(raw ?? "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!name) name = "_";
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = `_${name}`;
  return name.slice(0, 120);
}

function formatCredits(value) {
  if (value === null || value === undefined || value === "") return "";
  return String(value);
}

function addDecimal(a, b) {
  // 点数是十进制字符串；用放大到整数的方式相加，避免 0.1 + 0.2 这类浮点误差。
  const scale = 1_000_000n;
  const toInt = (v) => {
    const [whole, frac = ""] = String(v).split(".");
    const sign = whole.startsWith("-") ? -1n : 1n;
    const w = BigInt(whole.replace("-", "") || "0");
    const f = BigInt((frac + "000000").slice(0, 6));
    return sign * (w * scale + f);
  };
  const total = toInt(a) + toInt(b);
  const sign = total < 0n ? "-" : "";
  const abs = total < 0n ? -total : total;
  const frac = (abs % scale).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${abs / scale}${frac ? `.${frac}` : ""}`;
}

export function sumCredits(values) {
  return values.filter((v) => v !== null && v !== undefined && v !== "").reduce(addDecimal, "0");
}

// ---------------------------------------------------------------------------
// 和服务端说话：MCP JSON-RPC（固定 8 个工具）+ 参考图上传。
// ---------------------------------------------------------------------------

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
  constructor({
    key,
    fetchImpl = globalThis.fetch,
    sleep = realSleep,
    now = Date.now,
    requestsPerMinute = DEFAULT_REQUESTS_PER_MINUTE,
    log = () => {},
  }) {
    if (!key) throw new CliError("missing_key", "内部错误：没有钥匙。", { exitCode: 2 });
    this.key = key;
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
          this.log("  服务端回 401（钥匙刚才还能用，多半是每分钟请求数到上限），等 65 秒后重试…");
          await this.sleep(65_000);
          continue;
        }
        throw unauthorizedError(this.everSucceeded);
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
            "今天的提交次数用完了（每人每天 100 次，按提交次数算，不按张数）。",
            { exitCode: 4, retryAfterSeconds: retryAfter },
          );
        }
        if (attempt < 4) {
          const waitS = retryAfter ?? 60;
          this.log(`  每分钟请求数到上限，${waitS} 秒后自动重试…`);
          await this.sleep(waitS * 1000);
          continue;
        }
        throw new CliError("rate_limited", "连续触发每分钟请求上限（每把钥匙 30 次/分）。几分钟后运行 resume。", {
          exitCode: 4,
        });
      }
      if (error.code === "service_unavailable" && attempt < 3) {
        this.log(`  出图服务暂时不可用（${name}），${attempt * 15} 秒后重试…`);
        await this.sleep(attempt * 15_000);
        continue;
      }
      if (error.code === "unauthorized") throw unauthorizedError(false);
      if (error.code === "insufficient_scope") throw new CliError("insufficient_scope", describeError("insufficient_scope"));
      throw new CliError(error.code, describeError(error.code), { fatal: error.code === "insufficient_credits" });
    }
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

// ---------------------------------------------------------------------------
// 任务表：CSV（每行一个商品）或文件夹（每个子文件夹一个商品）。
// ---------------------------------------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const COLUMN_ALIASES = Object.freeze({
  sku: ["sku", "货号", "商品", "商品编号"],
  refs: ["refs", "ref", "参考图", "images"],
  templates: ["templates", "template", "模板", "图位"],
  prompt: ["prompt", "提示词", "说明", "补充说明"],
  model: ["model", "模型"],
  aspect_ratio: ["aspect_ratio", "aspect", "比例", "画幅"],
  n: ["n", "张数", "count"],
});

function columnIndex(header) {
  const normalized = header.map((h) => h.trim().toLowerCase());
  const index = {};
  for (const [name, aliases] of Object.entries(COLUMN_ALIASES)) {
    const found = normalized.findIndex((h) => aliases.includes(h));
    if (found >= 0) index[name] = found;
  }
  return index;
}

function splitList(value) {
  return String(value ?? "")
    .split(/[;；|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseCount(raw, where, errors) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < 1 || n > MAX_IMAGES_PER_SUBMIT) {
    errors.push(`${where}：张数「${raw}」不对，只能是 1 到 4 的整数（一次提交最多 4 张）。`);
    return null;
  }
  return n;
}

function checkReference(path, where, errors, statFn) {
  const ext = extname(path).toLowerCase();
  if (!IMAGE_EXTENSIONS[ext]) {
    errors.push(`${where}：参考图 ${path} 不是 JPG / PNG / WebP。`);
    return;
  }
  let info;
  try {
    info = statFn(path);
  } catch {
    errors.push(`${where}：找不到参考图 ${path}。`);
    return;
  }
  if (!info.isFile()) errors.push(`${where}：参考图 ${path} 不是文件。`);
  else if (info.size > MAX_UPLOAD_BYTES) {
    errors.push(`${where}：参考图 ${path} 有 ${(info.size / 1048576).toFixed(1)} MB，超过 10 MB 上限。`);
  }
}

function buildJobs(products, defaults, errors, statFn) {
  const jobs = [];
  const seen = new Set();
  for (const product of products) {
    const { where, sku } = product;
    const model = product.model || defaults.model;
    const prompt = product.prompt || defaults.prompt || "";
    const aspectRatio = product.aspectRatio || defaults.aspectRatio || null;
    const n = product.n ?? defaults.n ?? 1;
    const templates = product.templates.length ? product.templates : (defaults.templates ?? []);
    if (!sku) errors.push(`${where}：缺货号（sku）。`);
    if (!model) errors.push(`${where}：没指定模型。在表里加 model 列，或命令加 -m（quriov models 看能用的）。`);
    if (!prompt.trim()) {
      errors.push(`${where}：没有提示词。模板会接在你的提示词前面，但至少要写一句商品描述（商品名、颜色、材质）。`);
    } else if (prompt.length > MAX_PROMPT_CHARS) {
      errors.push(`${where}：提示词 ${prompt.length} 字，超过 ${MAX_PROMPT_CHARS} 字上限，服务端会拒绝。`);
    }
    for (const ref of product.refs) checkReference(ref, where, errors, statFn);
    const slots = templates.length ? templates : [null];
    for (const templateId of slots) {
      const slot = templateId ?? "image";
      const key = `${sku}/${slot}`;
      if (seen.has(key)) {
        errors.push(`${where}：货号 ${sku} 的图位 ${slot} 重复了。`);
        continue;
      }
      seen.add(key);
      jobs.push({
        key,
        sku,
        slot,
        model,
        prompt,
        templateId,
        aspectRatio,
        n,
        refs: product.refs,
      });
    }
  }
  return jobs;
}

export function loadSpec(specPath, defaults = {}, { readFile = readFileSync, statFn = statSync, readDir = readdirSync } = {}) {
  const errors = [];
  const absolute = resolve(specPath);
  let info;
  try {
    info = statFn(absolute);
  } catch {
    throw new CliError("spec_missing", `找不到任务表 ${specPath}。`, { exitCode: 2 });
  }
  const products = [];
  let specHash;
  if (info.isDirectory()) {
    // 文件夹模式：每个子文件夹 = 一个商品（文件夹名当货号），里面的图当参考图，可选 prompt.txt。
    const entries = readDir(absolute, { withFileTypes: true }).filter((e) => e.isDirectory());
    const hashParts = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = join(absolute, entry.name);
      const files = readDir(dir, { withFileTypes: true }).filter((e) => e.isFile());
      const refs = files
        .filter((f) => IMAGE_EXTENSIONS[extname(f.name).toLowerCase()])
        .map((f) => join(dir, f.name))
        .sort();
      let prompt = "";
      const promptFile = files.find((f) => f.name.toLowerCase() === "prompt.txt");
      if (promptFile) prompt = readFile(join(dir, promptFile.name), "utf8").trim();
      hashParts.push(entry.name, ...refs.map((r) => basename(r)), prompt);
      products.push({ where: `文件夹 ${entry.name}`, sku: entry.name.trim(), refs, prompt, templates: [], model: "", aspectRatio: "", n: null });
    }
    if (!products.length) errors.push(`${specPath} 里没有子文件夹。文件夹模式下每个子文件夹是一个商品。`);
    if (!defaults.templates?.length) {
      errors.push("文件夹模式要用 --templates 指定图位模板（逗号分隔，quriov models 看能用的编号）。");
    }
    specHash = sha256(hashParts.join("\u0000"));
  } else {
    const text = readFile(absolute, "utf8");
    specHash = sha256(text);
    const rows = parseCsv(text);
    if (!rows.length) throw new CliError("spec_empty", `任务表 ${specPath} 是空的。`, { exitCode: 2 });
    const index = columnIndex(rows[0]);
    if (index.sku === undefined) {
      throw new CliError(
        "spec_header",
        `任务表第一行要是表头，至少有 sku 列。能用的列：sku,refs,templates,prompt,model,aspect_ratio,n（也认中文：货号,参考图,模板,提示词,模型,比例,张数）。`,
        { exitCode: 2 },
      );
    }
    const base = dirname(absolute);
    rows.slice(1).forEach((row, i) => {
      const cell = (name) => (index[name] === undefined ? "" : (row[index[name]] ?? "").trim());
      const where = `第 ${i + 2} 行`;
      products.push({
        where,
        sku: cell("sku"),
        refs: splitList(cell("refs")).map((r) => (isAbsolute(r) ? r : resolve(base, r))),
        templates: splitList(cell("templates")),
        prompt: cell("prompt"),
        model: cell("model"),
        aspectRatio: cell("aspect_ratio"),
        n: parseCount(cell("n"), where, errors),
      });
    });
  }
  const jobs = buildJobs(products, defaults, errors, statFn);
  return { specPath: absolute, specHash, jobs, errors, products: products.length };
}

export function summarizePlan(jobs) {
  const images = jobs.reduce((sum, job) => sum + job.n, 0);
  const products = new Set(jobs.map((j) => j.sku)).size;
  const refs = new Set(jobs.flatMap((j) => j.refs)).size;
  const byModel = {};
  for (const job of jobs) byModel[job.model] = (byModel[job.model] ?? 0) + job.n;
  return { products, submissions: jobs.length, images, uniqueReferences: refs, imagesByModel: byModel };
}

export function renderPlan(jobs, { estimate = null } = {}) {
  const s = summarizePlan(jobs);
  const lines = [];
  lines.push(`计划：${s.products} 个商品，${s.submissions} 次提交，共 ${s.images} 张；要上传的参考图 ${s.uniqueReferences} 张。`);
  lines.push("");
  lines.push("  #    货号 / 图位                              模型                  张数  参考图");
  jobs.forEach((job, i) => {
    const label = `${job.sku} / ${job.slot}`;
    lines.push(
      `  ${String(i + 1).padEnd(4)} ${label.padEnd(40)} ${String(job.model).padEnd(21)} ${String(job.n).padEnd(5)} ${job.refs.length}`,
    );
  });
  lines.push("");
  if (estimate) {
    for (const row of estimate.rows) {
      lines.push(`  估价：${row.model} × ${row.images} 张 = ${row.credits} 点（服务端按这把钥匙所属账号估算）`);
    }
    lines.push(`  合计约 ${estimate.total} 点；当前余额 ${estimate.balance ?? "未知"} 点。`);
    if (estimate.quota) {
      lines.push(
        `  今天还能提交 ${estimate.quota.daily_generation_remaining} 次（上限 ${estimate.quota.daily_generation_limit} 次/天，${estimate.quota.resets_at} 重置）。`,
      );
    }
  } else {
    lines.push("  没有联网估价。加 --estimate 可以联网估价（免费，不出图）。");
  }
  if (s.submissions > 100) {
    lines.push(`  注意：这批要提交 ${s.submissions} 次，超过每人每天 100 次的上限；用完会自动暂停，第二天运行 resume 接着跑。`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 批次状态：每一步都先落盘，断了能接着跑，已提交的不会重复扣钱。
// ---------------------------------------------------------------------------

export function newBatchId(now = Date.now()) {
  const d = new Date(now);
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${randomBytes(2).toString("hex")}`;
}

export function statePathFor(outDir, batchId) {
  return join(outDir, STATE_DIR, `${batchId}.json`);
}

export function createState({ kind, batchId, specPath = null, specHash = null, outDir, jobs, now = Date.now() }) {
  return {
    version: 1,
    kind,
    batchId,
    createdAt: new Date(now).toISOString(),
    specPath,
    specHash,
    outDir: resolve(outDir),
    costFile: kind === "batch" ? "cost.csv" : `cost-${batchId}.csv`,
    uploads: {},
    pausedUntil: null,
    jobs: jobs.map((job, index) => ({
      ...job,
      index,
      attempt: 1,
      status: "pending",
      idempotencyKey: null,
      args: null,
      requestId: null,
      generationId: null,
      serverStatus: null,
      credits: null,
      billingStatus: null,
      errorCode: null,
      errorMessage: null,
      files: [],
      mediaCount: 0,
      downloadAttempts: 0,
      missingPolls: 0,
      submittedAt: null,
    })),
  };
}

export function saveState(state) {
  const file = statePathFor(state.outDir, state.batchId);
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

function batchIndexPath(options) {
  return join(configDir(options), "batches.json");
}

export function rememberBatch(state, options) {
  const file = batchIndexPath(options);
  let index = {};
  try {
    index = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // 第一次
  }
  index[state.batchId] = statePathFor(state.outDir, state.batchId);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify(index, null, 2)}\n`);
  } catch {
    // 记不下索引也不影响：还能用输出目录找到批次
  }
}

export function listStatesIn(outDir) {
  const dir = join(resolve(outDir), STATE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function findState(ref, options) {
  // 可以给批次号、输出目录或状态文件路径。
  if (ref && existsSync(ref)) {
    const info = statSync(ref);
    if (info.isFile()) return JSON.parse(readFileSync(ref, "utf8"));
    const batches = listStatesIn(ref).filter((s) => s.kind === "batch");
    if (batches.length === 1) return batches[0];
    if (batches.length > 1) {
      throw new CliError(
        "ambiguous_batch",
        `目录 ${ref} 里有 ${batches.length} 个批次：${batches.map((b) => b.batchId).join("、")}。请直接给批次号。`,
        { exitCode: 2 },
      );
    }
  }
  try {
    const index = JSON.parse(readFileSync(batchIndexPath(options), "utf8"));
    if (index[ref] && existsSync(index[ref])) return JSON.parse(readFileSync(index[ref], "utf8"));
  } catch {
    // 落到下面
  }
  throw new CliError("batch_not_found", `找不到批次「${ref}」。可以给批次号，或者给当时的输出目录（-o 那个）。`, {
    exitCode: 2,
  });
}

export function isUnfinished(job) {
  return !["done", "failed"].includes(job.status);
}

export function statusCounts(state) {
  const counts = { pending: 0, submitting: 0, running: 0, download_retry: 0, done: 0, failed: 0 };
  for (const job of state.jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
  return counts;
}

function outputFiles(state, job, count, contentTypes) {
  const folder = state.kind === "batch" ? join(state.outDir, safeName(job.sku)) : state.outDir;
  const stem = state.kind === "batch" ? safeName(job.slot) : `quriov-${state.batchId}`;
  return contentTypes.slice(0, count).map((type, i) => {
    const ext = EXT_BY_TYPE[type] ?? ".png";
    const suffix = count > 1 || state.kind !== "batch" ? `-${i + 1}` : "";
    return join(folder, `${stem}${suffix}${ext}`);
  });
}

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const STATUS_LABELS = Object.freeze({
  pending: "待提交",
  submitting: "提交中",
  running: "生成中",
  download_retry: "待下载",
  done: "完成",
  failed: "失败",
});

// 每张图花了多少点：只写服务端在结果里返回的数，不按价目表推算。
export function renderCostCsv(state) {
  const header = ["货号", "图位", "模板", "模型", "请求张数", "拿到张数", "点数(服务端返回)", "扣费状态", "状态", "文件", "请求编号", "原因"];
  const lines = [header.join(",")];
  for (const job of state.jobs) {
    lines.push(
      [
        job.sku,
        job.slot,
        job.templateId ?? "",
        job.model,
        job.n,
        job.status === "done" || job.status === "download_retry" ? job.mediaCount : 0,
        formatCredits(job.credits),
        job.billingStatus ?? "",
        STATUS_LABELS[job.status] ?? job.status,
        job.files.map((f) => f.replace(`${state.outDir}`, ".").replace(/\\/g, "/")).join(" "),
        job.requestId ?? "",
        job.errorMessage ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const reported = state.jobs.map((j) => j.credits).filter((c) => c !== null && c !== "");
  const missing = state.jobs.filter((j) => j.requestId && (j.credits === null || j.credits === "")).length;
  lines.push(
    [
      "合计",
      "",
      "",
      "",
      state.jobs.reduce((s, j) => s + j.n, 0),
      state.jobs.reduce((s, j) => s + (j.status === "done" || j.status === "download_retry" ? j.mediaCount : 0), 0),
      sumCredits(reported),
      "",
      "",
      "",
      "",
      missing ? `${missing} 条已提交但服务端还没返回点数` : "",
    ]
      .map(csvCell)
      .join(","),
  );
  // 带 BOM：Windows 上用 Excel 直接打开中文不乱码。
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function writeCostCsv(state) {
  const file = join(state.outDir, state.costFile);
  mkdirSync(state.outDir, { recursive: true });
  writeAtomic(file, renderCostCsv(state));
  return file;
}

// ---------------------------------------------------------------------------
// 执行：控并发、控速、轮询、下载、落盘。
// ---------------------------------------------------------------------------

export function retryFailedJobs(state) {
  let count = 0;
  for (const job of state.jobs) {
    if (job.status !== "failed") continue;
    job.attempt += 1;
    Object.assign(job, {
      status: "pending",
      idempotencyKey: null,
      args: null,
      requestId: null,
      generationId: null,
      serverStatus: null,
      credits: null,
      billingStatus: null,
      errorCode: null,
      errorMessage: null,
      files: [],
      mediaCount: 0,
      downloadAttempts: 0,
      missingPolls: 0,
      submittedAt: null,
    });
    count += 1;
  }
  return count;
}

export async function runBatch(state, client, {
  concurrency = DEFAULT_CONCURRENCY,
  pollSeconds = DEFAULT_POLL_SECONDS,
  sleep = realSleep,
  now = Date.now,
  log = () => {},
  templateAspect = {},
  shouldStop = () => false,
} = {}) {
  const save = () => {
    saveState(state);
    writeCostCsv(state);
  };
  const total = state.jobs.length;
  let paused = null;
  let fatal = null;
  const label = (job) => `[${job.index + 1}/${total}] ${state.kind === "batch" ? `${job.sku} / ${job.slot}` : "出图"}`;

  const failJob = (job, code, message) => {
    job.status = "failed";
    job.errorCode = code;
    job.errorMessage = message ?? describeError(code);
    log(`${label(job)} 失败：${job.errorMessage}`);
  };

  const ensureUpload = async (path) => {
    const cached = state.uploads[path];
    if (cached && cached.expiresAt - now() > UPLOAD_REUSE_MARGIN_MS) return cached.url;
    const uploaded = await client.upload(path);
    state.uploads[path] = {
      url: uploaded.url,
      sha256: uploaded.sha256,
      expiresAt: now() + uploaded.expiresIn * 1000,
    };
    saveState(state);
    return uploaded.url;
  };

  const applyResult = async (job, item) => {
    if (item.generation_id) job.generationId = item.generation_id;
    if (item.credits !== undefined && item.credits !== null) job.credits = String(item.credits);
    if (item.billing_status) job.billingStatus = item.billing_status;
    job.serverStatus = item.status ?? null;
    if (item.request_status === "failed" || item.status === "failed") {
      failJob(job, item.error_code ?? "generation_failed");
      return;
    }
    if (item.status === "unknown" || item.request_status === "unknown") {
      if (job.submittedAt && now() - job.submittedAt > UNKNOWN_GIVE_UP_MS) {
        failJob(job, "service_unavailable", "提交后 10 分钟服务端仍说不清结果（服务端临时故障）。已扣的点会按实际出图结算；可 --retry-failed 重交。");
      }
      return;
    }
    if (!TERMINAL_OK.has(item.status)) return; // 还在排队 / 生成中
    const media = (item.media ?? []).filter((m) => m && m.type === "image" && typeof m.url === "string");
    job.mediaCount = media.length;
    const targets = outputFiles(state, job, media.length, media.map((m) => m.content_type));
    const files = [];
    try {
      for (let i = 0; i < media.length; i += 1) {
        await client.download(media[i].url, targets[i]);
        files.push(targets[i]);
      }
    } catch (error) {
      job.downloadAttempts += 1;
      job.status = job.downloadAttempts >= MAX_DOWNLOAD_ATTEMPTS ? "failed" : "download_retry";
      job.errorCode = "download_failed";
      job.errorMessage = describeError("download_failed");
      log(`${label(job)} 下载失败（第 ${job.downloadAttempts} 次）：${error.message}`);
      return;
    }
    job.files = files;
    job.status = "done";
    job.errorCode = null;
    job.errorMessage = item.status === "partial" ? `只出了 ${media.length}/${job.n} 张（其余生成失败，没扣点）` : null;
    const where = files.length ? files.map((f) => f.replace(state.outDir, ".")).join("、") : "（没有图）";
    log(`${label(job)} 完成 ${media.length} 张，${formatCredits(job.credits) || "?"} 点 → ${where}`);
  };

  const submit = async (job) => {
    const firstSend = job.status === "pending";
    if (firstSend) {
      const urls = [];
      for (const ref of job.refs) urls.push(await ensureUpload(ref));
      const options = {};
      const aspect = job.aspectRatio || (job.templateId ? templateAspect[job.templateId] : null);
      if (aspect) options.aspect_ratio = aspect;
      if (job.templateId) options.template_id = job.templateId;
      if (job.n !== 1) options.batch_size = job.n;
      job.idempotencyKey = `qcli-${state.batchId}-${job.index}-a${job.attempt}`;
      job.args = {
        model: job.model,
        prompt: job.prompt,
        idempotency_key: job.idempotencyKey,
        ...(urls.length ? { input_media: urls.map((value) => ({ type: "image_url", value })) } : {}),
        ...(Object.keys(options).length ? { options } : {}),
      };
      job.status = "submitting";
      saveState(state); // 先落盘再提交：崩在这之后，续跑会用同一个编号重交，服务端认出来、不重复扣钱
    }
    log(`${label(job)} 提交${firstSend ? "" : "（续跑，用原任务编号，不会重复扣钱）"}…`);
    let result;
    try {
      result = await client.generateImage(job.args);
    } catch (error) {
      if (error.code === "daily_quota_exhausted") {
        if (firstSend) {
          // 这一下在服务端记账之前就被挡了：退回「待提交」，明天重新上传、重新编号。
          job.status = "pending";
          job.args = null;
          job.idempotencyKey = null;
        }
        throw error;
      }
      if (error.fatal) throw error;
      failJob(job, error.code, error.message);
      return;
    }
    job.requestId = result.request_id ?? null;
    job.submittedAt = now();
    job.status = "running";
    await applyResult(job, result);
  };

  const poll = async () => {
    const watching = state.jobs.filter((j) => j.status === "running" || j.status === "download_retry");
    if (!watching.length) return;
    const { items = [] } = await client.listGenerations();
    const byId = new Map();
    for (const item of items) {
      if (item.request_id) byId.set(item.request_id, item);
      if (item.generation_id) byId.set(item.generation_id, item);
    }
    for (const job of watching) {
      const item = byId.get(job.requestId) ?? (job.generationId ? byId.get(job.generationId) : undefined);
      if (!item) {
        job.missingPolls += 1;
        if (job.missingPolls >= MISSING_GIVE_UP_POLLS) failJob(job, "lost_from_history");
        continue;
      }
      job.missingPolls = 0;
      await applyResult(job, item);
    }
    save();
  };

  const running = () => state.jobs.filter((j) => j.status === "running").length;
  const nextToSubmit = () =>
    state.jobs.find((j) => j.status === "submitting") ?? state.jobs.find((j) => j.status === "pending");

  try {
    for (;;) {
      if (shouldStop()) break;
      while (!paused && !fatal && running() < concurrency && nextToSubmit() && !shouldStop()) {
        const job = nextToSubmit();
        try {
          await submit(job);
        } catch (error) {
          if (error.code === "daily_quota_exhausted") {
            paused = { code: error.code, message: error.message, retryAfterSeconds: error.retryAfterSeconds };
            state.pausedUntil = error.retryAfterSeconds ? new Date(now() + error.retryAfterSeconds * 1000).toISOString() : null;
          } else if (error.code === "insufficient_credits") {
            paused = { code: error.code, message: describeError("insufficient_credits") };
          } else {
            fatal = error;
          }
        }
        save();
      }
      if (fatal) break;
      const watching = state.jobs.some((j) => j.status === "running" || j.status === "download_retry");
      if (!watching) break;
      await sleep(pollSeconds * 1000);
      if (shouldStop()) break;
      await poll();
    }
  } finally {
    save();
  }
  if (fatal) throw fatal;
  if (!paused && !state.jobs.some((j) => j.status === "pending" || j.status === "submitting")) state.pausedUntil = null;
  save();
  return { paused, counts: statusCounts(state), costFile: join(state.outDir, state.costFile) };
}

// 联网校验 + 估价（免费）：模型可用、模板编号存在、按模板默认画幅；返回估价与余额。
export async function preflight(client, jobs, { withAccount = true } = {}) {
  const caps = await client.capabilities();
  const models = new Map((caps.models ?? []).map((m) => [m.id, m]));
  const templates = new Map((caps.templates ?? []).map((t) => [t.id, t]));
  const errors = [];
  for (const job of jobs) {
    const model = models.get(job.model);
    if (!model || !model.available || model.modality !== "image") {
      const usable = [...models.values()].filter((m) => m.available && m.modality === "image").map((m) => m.id);
      errors.push(`${job.sku} / ${job.slot}：模型 ${job.model} 现在不能出图。能用的：${usable.join("、") || "无"}。`);
    }
    if (job.templateId && !templates.has(job.templateId)) {
      errors.push(`${job.sku} / ${job.slot}：模板 ${job.templateId} 不存在（quriov models 看能用的模板编号）。`);
    }
  }
  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length) return { errors: uniqueErrors };
  const imagesByModel = summarizePlan(jobs).imagesByModel;
  const rows = [];
  for (const [modelId, images] of Object.entries(imagesByModel)) {
    const m = models.get(modelId);
    const est = await client.estimate({ modelId, pricingUnit: m.pricing_unit, units: images });
    rows.push({ model: modelId, images, credits: String(est.credits) });
  }
  const estimate = { rows, total: sumCredits(rows.map((r) => r.credits)), balance: null, quota: null };
  if (withAccount) {
    const account = await client.account();
    estimate.balance = account.balance ?? null;
    estimate.quota = account.quota ?? null;
  }
  const templateAspect = Object.fromEntries([...templates.values()].map((t) => [t.id, t.aspect_ratio]));
  return { errors: [], estimate, templateAspect };
}

// ---------------------------------------------------------------------------
// 命令行
// ---------------------------------------------------------------------------

const FLAG_SPEC = Object.freeze({
  "-m": "model",
  "--model": "model",
  "-p": "prompt",
  "--prompt": "prompt",
  "--ref": "ref",
  "-r": "ref",
  "-n": "n",
  "--n": "n",
  "-t": "template",
  "--template": "template",
  "--templates": "templates",
  "--aspect": "aspect",
  "--aspect-ratio": "aspect",
  "-o": "out",
  "--out": "out",
  "--concurrency": "concurrency",
  "--poll-seconds": "pollSeconds",
  "--rpm": "rpm",
});
const BOOLEAN_FLAGS = Object.freeze({
  "--yes": "yes",
  "-y": "yes",
  "--dry-run": "dryRun",
  "--estimate": "estimate",
  "--json": "json",
  "--retry-failed": "retryFailed",
  "--help": "help",
  "-h": "help",
  "--version": "version",
  "-v": "version",
  "--key-stdin": "keyStdin",
});
const FORBIDDEN_FLAGS = /^--?(key|token|api-key|access-key|secret|endpoint|base-url)(=|$)/i;

export function parseArgv(argv) {
  const out = { positional: [], ref: [] };
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    if (FORBIDDEN_FLAGS.test(arg)) {
      throw new CliError(
        "forbidden_argument",
        "出于安全，钥匙和服务地址不能写在命令参数里（会留在命令历史和进程列表里）。用 quriov login 或环境变量 QURIOV_MCP_ACCESS_KEY。",
        { exitCode: 2 },
      );
    }
    let inline = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      inline = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    if (BOOLEAN_FLAGS[arg]) {
      out[BOOLEAN_FLAGS[arg]] = true;
      continue;
    }
    const name = FLAG_SPEC[arg];
    if (name) {
      const value = inline ?? argv[(i += 1)];
      if (value === undefined) throw new CliError("usage", `${arg} 后面要跟一个值。`, { exitCode: 2 });
      if (name === "ref") out.ref.push(value);
      else out[name] = value;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      throw new CliError("usage", `不认识的参数 ${arg}。运行 quriov --help 看用法。`, { exitCode: 2 });
    }
    out.positional.push(arg);
  }
  return out;
}

function intOption(value, name, { min, max, fallback }) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CliError("usage", `${name} 要是 ${min} 到 ${max} 之间的整数。`, { exitCode: 2 });
  }
  return n;
}

export const HELP = `Quriov 官方命令行 ${VERSION} —— 和 Quriov MCP 同一把钥匙、同一个后端，适合批量出图。

一次性准备
  quriov login                   粘贴网页上建的「MCP」钥匙（隐藏输入，存本机用户目录）
                                 也可以直接设环境变量 QURIOV_MCP_ACCESS_KEY
                                 （旧名字 QURIOV_MCP_KEY / QURIOV_ACCESS_KEY 也认）
  quriov logout                  删掉本机保存的钥匙（网页上的钥匙不受影响）
  quriov doctor                  只读自检：连得上、8 个工具齐全、钥匙可用

查看（免费）
  quriov account                 余额、今天还能提交几次
  quriov models                  能用的模型、模板编号、每张多少点

单张 / 小批
  quriov gen -m <模型> -p "<提示词>" [--ref a.jpg --ref b.jpg] [-t <模板>] [-n 1-4]
             [--aspect 3:4] [-o ./out] [--dry-run] [--yes]

批量（一张表，每行一个商品）
  quriov batch plan <表.csv|文件夹> [-m <模型>] [--estimate]
                                 只列计划：不联网、不花钱；--estimate 联网估价（免费）
  quriov batch run  <表.csv|文件夹> -o ./out [-m <模型>] [--yes] [--concurrency 4]
                                 先估价再确认；自动传参考图、提交、等结果、下载、
                                 写 out/cost.csv（每行点数都来自服务端返回）
  quriov batch status <批次号|输出目录> [--json]
  quriov batch resume <批次号|输出目录> [--retry-failed] [--yes]
                                 断了接着跑；已提交的用原任务编号，不会重复扣钱

表格列（第一行是表头；中文表头也认）
  sku 货号 · refs 参考图（分号隔开，相对表格所在文件夹）· templates 模板（分号隔开，
  每个模板 = 一个图位）· prompt 提示词 · model 模型 · aspect_ratio 比例 · n 每个图位几张
  文件夹模式：每个子文件夹是一个商品，里面的图当参考图，可放 prompt.txt；用 --templates 指定图位。

现在的服务端限制（命令行会自动控速）
  每把钥匙每分钟 30 次请求（每次工具调用算 2 次）；每人每天 100 次提交（按次不按张）；
  一次提交最多 4 张、一个模板。

退出码：0 全部完成 · 1 出错 · 2 用法不对 · 3 有任务失败 · 4 暂停（限额 / 网络），可 resume
`;

async function readSecret(prompt, { stdin = process.stdin, stderr = process.stderr, piped = false } = {}) {
  if (piped || !stdin.isTTY) {
    let value = "";
    for await (const chunk of stdin) value += chunk;
    return value.trim();
  }
  stderr.write(prompt);
  return new Promise((done, fail) => {
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stderr.write("\n");
          done(value.trim());
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          stdin.off("data", onData);
          fail(new CliError("cancelled", "已取消。", { exitCode: 1 }));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function confirm(question, { stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY) {
    throw new CliError("needs_confirmation", "这一步要花钱，需要确认。非交互环境请先用 batch plan 看清楚，再加 --yes。", {
      exitCode: 2,
    });
  }
  stderr.write(`${question} 输入 y 继续：`);
  return new Promise((done) => {
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.once("data", (data) => {
      stdin.pause();
      done(/^\s*(y|yes|是|确认)\s*$/i.test(String(data)));
    });
  });
}

function describeFinish(state, result) {
  const c = result.counts;
  const lines = [];
  lines.push(
    `批次 ${state.batchId}：完成 ${c.done}，失败 ${c.failed}，生成中 ${c.running}，待提交 ${c.pending + c.submitting}，待下载 ${c.download_retry}。`,
  );
  const credits = sumCredits(state.jobs.map((j) => j.credits));
  lines.push(`已扣点数（服务端返回）合计 ${credits}；明细：${result.costFile}`);
  if (result.paused) {
    let when = "";
    if (state.pausedUntil) {
      when = `，约 ${new Date(state.pausedUntil).toLocaleString("zh-CN", { hour12: false })}（本机时间）重置`;
    }
    lines.push(`已暂停：${result.paused.message}${when}。`);
  }
  if (c.failed) {
    lines.push("失败的任务：");
    for (const job of state.jobs.filter((j) => j.status === "failed")) {
      lines.push(`  ${job.sku ? `${job.sku} / ${job.slot}` : "出图"}：${job.errorMessage}`);
    }
  }
  if (isUnfinishedState(state) || c.failed) {
    lines.push(`接着跑：quriov batch resume ${state.batchId}${c.failed ? "（加 --retry-failed 重试失败的）" : ""}`);
  }
  return lines.join("\n");
}

function isUnfinishedState(state) {
  return state.jobs.some((j) => ["pending", "submitting", "running", "download_retry"].includes(j.status));
}

function exitCodeFor(state, result) {
  if (result.paused) return 4;
  if (isUnfinishedState(state)) return 4;
  if (result.counts.failed) return 3;
  return 0;
}

export async function main(argv, io = {}) {
  const {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
    fetchImpl = globalThis.fetch,
    sleep = realSleep,
    now = Date.now,
    shouldStop = () => false,
  } = io;
  const print = (text) => stdout.write(`${text}\n`);
  const log = (text) => stderr.write(`${text}\n`);
  const args = parseArgv(argv);
  const [command, sub, ...rest] = args.positional;

  if (args.version) {
    print(VERSION);
    return 0;
  }
  if (!command || args.help || command === "help") {
    print(HELP);
    return 0;
  }

  const makeClient = () => {
    const { key } = requireKey({ env });
    return new QuriovClient({
      key,
      fetchImpl,
      sleep,
      now,
      log,
      requestsPerMinute: intOption(args.rpm, "--rpm", { min: 4, max: 28, fallback: DEFAULT_REQUESTS_PER_MINUTE }),
    });
  };
  const runOptions = () => ({
    concurrency: intOption(args.concurrency, "--concurrency", { min: 1, max: 8, fallback: DEFAULT_CONCURRENCY }),
    pollSeconds: intOption(args.pollSeconds, "--poll-seconds", { min: 5, max: 300, fallback: DEFAULT_POLL_SECONDS }),
    sleep,
    now,
    log,
    shouldStop,
  });

  // 跑批：不管正常结束、暂停还是中途出错，都先把进度和续跑命令说清楚。
  const execute = async (state, client, templateAspect) => {
    let result;
    try {
      result = await runBatch(state, client, { ...runOptions(), templateAspect });
    } catch (error) {
      print(describeFinish(state, { paused: null, counts: statusCounts(state), costFile: join(state.outDir, state.costFile) }));
      throw error;
    }
    print(describeFinish(state, result));
    return exitCodeFor(state, result);
  };

  if (command === "login") {
    const key = await readSecret("粘贴 Quriov MCP 钥匙（输入不显示），回车确认：", { stdin, stderr, piped: args.keyStdin });
    if (!key) throw new CliError("missing_key", "没有输入钥匙。", { exitCode: 2 });
    const client = new QuriovClient({ key, fetchImpl, sleep, now, log });
    const account = await client.account(); // 先验证再保存：错的钥匙不落盘
    const file = saveKey(key, { env });
    print(`钥匙可用（${account.wallet_type === "organization" ? "组织钱包" : "个人账户"}），已保存到 ${file}。`);
    print("下次直接用 quriov 命令即可；要删掉运行 quriov logout。");
    return 0;
  }

  if (command === "logout") {
    const file = credentialsPath({ env });
    if (existsSync(file)) rmSync(file);
    print(`已删除本机保存的钥匙（${file}）。网页上的钥匙不受影响，要作废请到 ${ORIGIN}/me/access-keys 撤销。`);
    return 0;
  }

  if (command === "doctor") {
    const { key } = requireKey({ env });
    const result = await runDoctor({ key, fetchImpl });
    print(`连接正常：${result.endpoint}，工具 ${result.checks.tools.count} 个，钥匙可用。`);
    return 0;
  }

  if (command === "account") {
    const client = makeClient();
    const a = await client.account();
    if (args.json) {
      print(JSON.stringify(a));
      return 0;
    }
    print(`余额：${a.balance} 点（${a.wallet_type === "organization" ? "组织钱包" : "个人账户"}）`);
    if (a.quota) {
      print(`今天：已提交 ${a.quota.daily_generation_used} / ${a.quota.daily_generation_limit} 次，还能提交 ${a.quota.daily_generation_remaining} 次（${a.quota.resets_at} 重置）`);
      print(`每分钟请求上限：${a.quota.requests_per_minute_limit} 次（每次工具调用算 2 次）`);
    }
    return 0;
  }

  if (command === "models") {
    const client = makeClient();
    const caps = await client.capabilities();
    const models = (caps.models ?? []).filter((m) => m.available);
    const priced = [];
    for (const m of models) {
      let credits = null;
      try {
        credits = (await client.estimate({ modelId: m.id, pricingUnit: m.pricing_unit, units: 1 })).credits;
      } catch (error) {
        if (error.fatal) throw error;
      }
      priced.push({ ...m, credits_per_unit: credits });
    }
    if (args.json) {
      print(JSON.stringify({ models: priced, templates: caps.templates ?? [] }));
      return 0;
    }
    print("模型（价格由服务端按这把钥匙所属账号估算）：");
    for (const m of priced) {
      const unit = m.modality === "image" ? "每张" : `每 ${m.pricing_unit}`;
      print(`  ${m.id.padEnd(26)} ${m.modality === "image" ? "图片" : "视频"}  ${unit} ${m.credits_per_unit ?? "?"} 点  ${m.display_name}`);
    }
    print("");
    print("模板（templates 列 / -t 填这里的编号）：");
    for (const t of caps.templates ?? []) {
      print(`  ${t.id.padEnd(26)} ${String(t.aspect_ratio).padEnd(6)} ${t.name}  ${t.description}`);
    }
    print("");
    print("命令行现在只提交图片；视频请用 MCP。");
    return 0;
  }

  if (command === "gen") {
    if (!args.model) throw new CliError("usage", "要用 -m 指定模型（quriov models 看能用的）。", { exitCode: 2 });
    if (!args.prompt) throw new CliError("usage", "要用 -p 写提示词。", { exitCode: 2 });
    const errors = [];
    const n = parseCount(args.n ?? "1", "-n", errors) ?? 1;
    const refs = args.ref.map((r) => resolve(r));
    const jobs = buildJobs(
      [{ where: "参数", sku: "gen", refs, templates: args.template ? [args.template] : [], prompt: args.prompt, model: args.model, aspectRatio: args.aspect ?? "", n }],
      {},
      errors,
      statSync,
    );
    if (errors.length) throw new CliError("invalid_spec", errors.join("\n"), { exitCode: 2 });
    const outDir = resolve(args.out ?? "quriov-out");
    if (args.dryRun) {
      print(renderPlan(jobs));
      print(`（--dry-run：没有联网，没有提交。去掉 --dry-run 才会真出图，输出到 ${outDir}）`);
      return 0;
    }
    const client = makeClient();
    const pre = await preflight(client, jobs);
    if (pre.errors.length) throw new CliError("invalid_spec", pre.errors.join("\n"), { exitCode: 2 });
    print(renderPlan(jobs, { estimate: pre.estimate }));
    if (!args.yes && !(await confirm(`确认出 ${n} 张、约 ${pre.estimate.total} 点？`, { stdin, stderr }))) {
      print("没有提交。");
      return 1;
    }
    const state = createState({ kind: "gen", batchId: newBatchId(now()), outDir, jobs, now: now() });
    saveState(state);
    rememberBatch(state, { env });
    return execute(state, client, pre.templateAspect);
  }

  if (command === "batch") {
    if (sub === "plan" || sub === "run") {
      const specPath = rest[0];
      if (!specPath) throw new CliError("usage", `用法：quriov batch ${sub} <表.csv|文件夹>`, { exitCode: 2 });
      const defaults = {
        model: args.model,
        prompt: args.prompt,
        aspectRatio: args.aspect,
        templates: splitList((args.templates ?? args.template ?? "").replace(/,/g, ";")),
      };
      const errorsBefore = [];
      defaults.n = parseCount(args.n, "-n", errorsBefore);
      const spec = loadSpec(specPath, defaults);
      const errors = [...errorsBefore, ...spec.errors];
      if (errors.length) {
        throw new CliError("invalid_spec", `任务表有 ${errors.length} 处要改（一张都没提交）：\n${errors.map((e) => `  - ${e}`).join("\n")}`, {
          exitCode: 2,
        });
      }
      const offline = sub === "plan" ? !args.estimate : args.dryRun;
      if (offline) {
        if (args.json) print(JSON.stringify({ summary: summarizePlan(spec.jobs), jobs: spec.jobs }));
        else {
          print(renderPlan(spec.jobs));
          print("（只是计划：没有联网，没有提交，没有花钱）");
        }
        return 0;
      }
      const client = makeClient();
      const pre = await preflight(client, spec.jobs);
      if (pre.errors.length) {
        throw new CliError("invalid_spec", `联网校验没通过（一张都没提交）：\n${pre.errors.map((e) => `  - ${e}`).join("\n")}`, {
          exitCode: 2,
        });
      }
      if (sub === "plan") {
        if (args.json) print(JSON.stringify({ summary: summarizePlan(spec.jobs), estimate: pre.estimate, jobs: spec.jobs }));
        else {
          print(renderPlan(spec.jobs, { estimate: pre.estimate }));
          print("（只估价：没有提交，没有花钱）");
        }
        return 0;
      }
      const outDir = resolve(args.out ?? "quriov-out");
      const existing = listStatesIn(outDir).filter((s) => s.kind === "batch");
      if (existing.length) {
        const unfinished = existing.find((s) => s.jobs.some(isUnfinished) || s.jobs.some((j) => j.status === "failed"));
        const target = unfinished ?? existing[0];
        throw new CliError(
          "out_dir_in_use",
          `输出目录 ${outDir} 里已经有批次 ${target.batchId}。接着跑用：quriov batch resume ${target.batchId}；要开新的一批请换一个 -o 目录（避免 cost.csv 被覆盖）。`,
          { exitCode: 2 },
        );
      }
      print(renderPlan(spec.jobs, { estimate: pre.estimate }));
      const s = summarizePlan(spec.jobs);
      if (!args.yes && !(await confirm(`确认提交 ${s.submissions} 次、共 ${s.images} 张、约 ${pre.estimate.total} 点？`, { stdin, stderr }))) {
        print("没有提交。");
        return 1;
      }
      const state = createState({
        kind: "batch",
        batchId: newBatchId(now()),
        specPath: spec.specPath,
        specHash: spec.specHash,
        outDir,
        jobs: spec.jobs,
        now: now(),
      });
      state.templateAspect = pre.templateAspect;
      saveState(state);
      rememberBatch(state, { env });
      print(`批次号 ${state.batchId}（断了用 quriov batch resume ${state.batchId} 接着跑）`);
      return execute(state, client, pre.templateAspect);
    }

    if (sub === "status") {
      const state = findState(rest[0] ?? ".", { env });
      if (args.json) {
        print(JSON.stringify({ batchId: state.batchId, counts: statusCounts(state), credits: sumCredits(state.jobs.map((j) => j.credits)), pausedUntil: state.pausedUntil, jobs: state.jobs.map(({ args: _a, ...job }) => job) }));
        return 0;
      }
      const c = statusCounts(state);
      print(`批次 ${state.batchId}（${state.createdAt}），输出 ${state.outDir}`);
      print(`  完成 ${c.done} · 失败 ${c.failed} · 生成中 ${c.running} · 待提交 ${c.pending + c.submitting} · 待下载 ${c.download_retry}，共 ${state.jobs.length}`);
      print(`  已扣点数（服务端返回）合计 ${sumCredits(state.jobs.map((j) => j.credits))}；明细 ${join(state.outDir, state.costFile)}`);
      for (const job of state.jobs.filter((j) => j.status === "failed")) print(`  失败 ${job.sku} / ${job.slot}：${job.errorMessage}`);
      if (isUnfinishedState(state) || c.failed) print(`  接着跑：quriov batch resume ${state.batchId}${c.failed ? " [--retry-failed]" : ""}`);
      print("  （这是本机记录；要看服务端最新进度请运行 resume）");
      return 0;
    }

    if (sub === "resume") {
      const state = findState(rest[0] ?? ".", { env });
      const retried = args.retryFailed ? retryFailedJobs(state) : 0;
      if (!isUnfinishedState(state)) {
        print(describeFinish(state, { paused: null, counts: statusCounts(state), costFile: join(state.outDir, state.costFile) }));
        return statusCounts(state).failed ? 3 : 0;
      }
      const client = makeClient();
      if (retried) {
        const pending = state.jobs.filter((j) => j.status === "pending");
        const pre = await preflight(client, pending);
        if (pre.errors.length) throw new CliError("invalid_spec", pre.errors.join("\n"), { exitCode: 2 });
        const s = summarizePlan(pending);
        print(`要重新提交 ${s.submissions} 次、共 ${s.images} 张、约 ${pre.estimate.total} 点。`);
        if (!args.yes && !(await confirm("确认重试？", { stdin, stderr }))) {
          print("没有提交。");
          return 1;
        }
      }
      saveState(state);
      rememberBatch(state, { env });
      print(`续跑批次 ${state.batchId}：已提交的会用原任务编号，服务端认得出，不会重复扣钱。`);
      return execute(state, client, state.templateAspect ?? {});
    }

    throw new CliError("usage", "batch 后面要跟 plan / run / status / resume。运行 quriov --help 看用法。", { exitCode: 2 });
  }

  throw new CliError("usage", `不认识的命令 ${command}。运行 quriov --help 看用法。`, { exitCode: 2 });
}

async function cli() {
  let stopRequested = false;
  process.on("SIGINT", () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    process.stderr.write("\n收到中断：进度都已存盘。再按一次 Ctrl+C 立即退出；之后用 quriov batch resume <批次号> 接着跑。\n");
  });
  try {
    process.exitCode = await main(process.argv.slice(2), { shouldStop: () => stopRequested });
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`错误：${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      // 不把原始异常（可能带请求细节）直接甩给用户
      process.stderr.write(`错误：命令行内部出错（${error?.name ?? "Error"}）。请把这行和你运行的命令（去掉钥匙）发给 Quriov 管理员。\n`);
      process.exitCode = 1;
    }
  }
}

// npm 全局安装时 argv[1] 是一个指向本文件的链接，先解析成真实路径再比。
function invokedDirectly() {
  if (!process.argv[1]) return false;
  let target = resolve(process.argv[1]);
  try {
    target = realpathSync(target);
  } catch {
    // 用原路径比
  }
  let self = import.meta.url;
  try {
    self = pathToFileURL(realpathSync(new URL(import.meta.url))).href;
  } catch {
    // 用原地址比
  }
  return pathToFileURL(target).href.toLowerCase() === self.toLowerCase();
}
if (invokedDirectly()) await cli();
