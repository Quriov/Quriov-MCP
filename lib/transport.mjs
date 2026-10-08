// 和服务端说话的唯一出口（传输层）：MCP JSON-RPC + 直连接口（批量提交 / 批次 / 任务）+ 参考图上传 + 下载结果图。
//
// 命令行其余部分只通过 QuriovClient 的这几个方法和服务端打交道：
//   MCP：listTools / capabilities / account / estimate / generateImage / listGenerations
//   直连接口：submitBatch / getBatch / queryJobs / getJob / listJobs / cancelJob / upload / download
//   详情套图（/api/v1/aplus/*）：aplusModules / aplusSubmit / aplusJob / aplusJobs
// 以后改成直接调 /api/v1/mcp/* 时，只换这个文件，方法签名和返回形状保持不变。
//
// 安全边界：钥匙只放在 Authorization 头里；下载结果图【不带】钥匙；只连 common.mjs 里的固定地址
// 和服务端返回的 https 结果链接。

import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

import {
  CliError,
  MCP_ENDPOINT,
  API_BASE,
  APLUS_BASE,
  ORIGIN,
  UPLOAD_ENDPOINT,
  USER_AGENT,
  VERSION,
  describeError,
  errorTail,
  realSleep,
  serverReason,
  sha256,
  unauthorizedError,
  writeAtomic,
} from "./common.mjs";

export const PROTOCOL_VERSION = "2025-06-18";
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const IMAGE_EXTENSIONS = Object.freeze({
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
});

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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readJson(response) {
  return parseJson(await response.text().catch(() => ""));
}

function firstString(...values) {
  return values.find((v) => typeof v === "string" && v.trim()) ?? null;
}

// 新接口（/api/v1/mcp/batches、/jobs…）的 4xx：{error_code, reason, request_id, …其余字段}。
// 详情套图接口的 4xx 是 {detail: …}：原因在 detail 里，两种都认。
// 报错一律带中文原因 + 错误码 + 请求编号；4xx 不重试。
export function apiError(status, body, response, label) {
  const code = firstString(body?.error_code, body?.code) ?? (status === 404 ? "not_found" : "http_error");
  const rid = requestIdOf(response, body);
  const reason = serverReason(body) ?? describeError(code, `服务端返回 HTTP ${status}（${label}）`);
  const { error_code: _c, reason: _r, request_id: _i, detail: _d, ...details } = body && typeof body === "object" ? body : {};
  const extra = [];
  if (details.required !== undefined || details.available !== undefined) {
    extra.push(`这次要 ${details.required ?? "?"} 点，可用 ${details.available ?? "?"} 点`);
  }
  if (Array.isArray(details.fields) && details.fields.length) extra.push(`有问题的字段：${details.fields.join("、")}`);
  if (Array.isArray(details.duplicated_idempotency_keys) && details.duplicated_idempotency_keys.length) {
    extra.push(`重复的 idempotency_key：${details.duplicated_idempotency_keys.join("、")}`);
  }
  return new CliError(code, `${reason}${extra.length ? `（${extra.join("；")}）` : ""}${errorTail(code, rid)}`, {
    exitCode: code === "insufficient_credits" ? 4 : 1,
    requestId: rid,
    httpStatus: status,
    details: Object.keys(details).length ? details : null,
    fatal: true,
  });
}

function requestIdOf(response, body) {
  const fromBody = typeof body?.request_id === "string" ? body.request_id : null;
  return fromBody ?? response.headers.get("x-request-id") ?? null;
}

// MCP 工具出错时，结果是 isError + 一段文字，文字里嵌着服务端的公开错误 JSON：
//   Error executing tool generate_image: {"code":"insufficient_credits",...}
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
    this.everSucceeded = false;
    this.initialized = false;
    this.rpcId = 0;
  }

  // noRetry：这次请求重发会重复扣钱（没有去重键的提交），所以断网 / 503 都不自动重试，原样报给上层。
  async _post(url, init, { label, timeoutMs = 120_000, noRetry = false }) {
    const maxAttempts = noRetry ? 1 : 4;
    for (let attempt = 1; ; attempt += 1) {
      if (!/^[\x21-\x7e]+$/.test(this.key)) {
        // 带空格 / 换行 / 中文的「钥匙」放不进请求头，fetch 会直接抛错；别把它当成网络问题去重试。
        if (this._switchKey()) continue;
        throw new CliError(
          "invalid_key_format",
          `${this.keySource ?? "钥匙"}格式不对：里面有空格、换行或中文等字符（多半是把整段说明一起粘进去了）。只要钥匙本身那一串。`,
          { exitCode: 2 },
        );
      }
      let response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${this.key}`, "User-Agent": USER_AGENT },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt < maxAttempts) {
          this.log(`  网络请求失败（${label}），${attempt * 5} 秒后重试…`);
          await this.sleep(attempt * 5000);
          continue;
        }
        if (noRetry) {
          throw new CliError("network_error", `请求没有收到回应（${label}：断网或超时；没有自动重试）。`, { exitCode: 4 });
        }
        throw new CliError(
          "network_error",
          `连不上 ${ORIGIN}（${label}，已重试 ${maxAttempts} 次）。检查网络 / 代理后再运行同一条命令。`,
          { exitCode: 4 },
        );
      }

      if (response.status === 401) {
        // 401 只表示钥匙本身不行（钥匙无效 / 过期 / 格式不对 / 账户停用），服务端给中文原因和请求编号。
        const body = await readJson(response);
        if (this._switchKey()) continue;
        throw unauthorizedError(this.keySource, {
          detail: serverReason(body),
          requestId: requestIdOf(response, body),
          errorCode: firstString(body?.error_code, body?.code) ?? "unauthorized",
        });
      }
      if (response.status === 403) {
        const text = await response.text().catch(() => "");
        if (/error code:\s*1010/i.test(text)) {
          throw new CliError(
            "blocked_by_firewall",
            "请求被网站防火墙拦下（Cloudflare 1010，按请求特征拦的，不是钥匙问题）。请把完整报错发给 Quriov 管理员。",
            { httpStatus: 403 },
          );
        }
        const body = parseJson(text);
        const rid = requestIdOf(response, body);
        if (!body && /<html/i.test(text)) {
          // 网关（nginx）直接回的 HTML 403：请求根本没到应用，钥匙没被看过。
          throw new CliError(
            "endpoint_blocked",
            `服务端网关拒绝了这个地址（HTTP 403，${label}；不是钥匙问题，请求没到应用）。多半是这个接口线上还没开放，请把这行报错发给 Quriov 管理员。${errorTail("endpoint_blocked", rid)}`,
            { requestId: rid, httpStatus: 403 },
          );
        }
        throw new CliError("insufficient_scope", `${describeError("insufficient_scope")}${errorTail(body?.error_code ?? "insufficient_scope", rid)}`, {
          requestId: rid,
          httpStatus: 403,
        });
      }
      if (response.status === 503) {
        // 服务端临时故障，会带 Retry-After：只有这种才自动重试（有上限）。
        if (attempt < maxAttempts) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const waitS = Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 120 ? retryAfter : attempt * 10;
          this.log(`  服务端暂时不可用（HTTP 503，${label}），${waitS} 秒后重试…`);
          await this.sleep(waitS * 1000);
          continue;
        }
        const body = await readJson(response);
        const rid = requestIdOf(response, body);
        throw new CliError(
          "service_unavailable",
          `服务端${noRetry ? "" : "连续"}返回 HTTP 503（${label}，${noRetry ? "没有自动重试" : `已重试 ${maxAttempts - 1} 次`}）：${serverReason(body) ?? describeError("service_unavailable")}${errorTail(body?.error_code ?? "service_unavailable", rid)}`,
          { exitCode: 4, requestId: rid, httpStatus: 503 },
        );
      }
      if (response.status >= 500) {
        const body = await readJson(response);
        const rid = requestIdOf(response, body);
        if (noRetry) {
          // 这类提交不去重：不能说「重跑同一条命令不会重复扣钱」。
          const why = serverReason(body);
          throw new CliError("server_error", `服务端出错了（HTTP ${response.status}，${label}）${why ? `：${why}` : ""}${errorTail(firstString(body?.error_code), rid)}`, {
            exitCode: 4,
            requestId: rid,
            httpStatus: response.status,
          });
        }
        throw new CliError(
          "server_error",
          `服务端出错了（HTTP ${response.status}，${label}）${errorTail(firstString(body?.error_code), rid)}。已提交的任务不会重复扣钱，稍后再运行同一条命令接着来；一直这样请把请求编号发给 Quriov 管理员。`,
          { exitCode: 4, requestId: rid, httpStatus: response.status },
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
      { label: params?.name ?? method },
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
      if (error.code === "service_unavailable" && attempt < 3) {
        this.log(`  出图服务暂时不可用（${name}），${attempt * 15} 秒后重试…`);
        await this.sleep(attempt * 15_000);
        continue;
      }
      const rid = typeof error.request_id === "string" ? `（请求编号 ${error.request_id}）` : "";
      if (error.code === "unauthorized") {
        if (this._switchKey()) continue;
        throw unauthorizedError(this.keySource, { requestId: error.request_id ?? null });
      }
      if (error.code === "insufficient_scope") throw new CliError("insufficient_scope", `${describeError("insufficient_scope")}${rid}`);
      throw new CliError(error.code, `${describeError(error.code, error.message)}${rid}`, { fatal: error.code === "insufficient_credits" });
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

  // ---- 新接口 /api/v1/mcp/*（批量提交 / 批次 / 任务）：普通 JSON，不走 MCP 协议 ----

  async api(method, path, { query = null, body = undefined, form = null, label = path, timeoutMs, base = API_BASE, noRetry = false, provesKey = true } = {}) {
    let url = `${base}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const init = { method, headers: { Accept: "application/json" } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    } else if (form) {
      init.body = form; // multipart：边界由 fetch 自己写进 Content-Type
    }
    const response = await this._post(url, init, { label, timeoutMs, noRetry });
    const text = await response.text().catch(() => "");
    const parsed = parseJson(text);
    if (!response.ok) throw apiError(response.status, parsed, response, label);
    if (!parsed || typeof parsed !== "object") {
      throw new CliError("invalid_response", `服务端的回应看不懂（${label}）。${errorTail(null, requestIdOf(response, null))}`, {
        requestId: requestIdOf(response, null),
        httpStatus: response.status,
      });
    }
    // 不用登录的接口成功不代表钥匙对：不能因此关掉「第一把钥匙不行就换下一把」。
    if (provesKey) this.everSucceeded = true;
    return parsed;
  }

  // 一次提交的条目别太多（建议 ≤ 50）：服务端逐条同步交给出图后端，太长会撞代理超时。
  submitBatch({ items, batchKey = null, dryRun = false }) {
    const body = { items, dry_run: Boolean(dryRun) };
    if (batchKey) body.batch_key = batchKey;
    return this.api("POST", "/batches", { body, label: dryRun ? "批量估价" : "批量提交", timeoutMs: 300_000 });
  }

  getBatch(batchId) {
    return this.api("GET", `/batches/${encodeURIComponent(batchId)}`, { label: "查批次" });
  }

  queryJobs(jobIds) {
    return this.api("POST", "/jobs/query", { body: { job_ids: jobIds }, label: "按编号查任务" });
  }

  getJob(jobId) {
    return this.api("GET", `/jobs/${encodeURIComponent(jobId)}`, { label: "查任务" });
  }

  listJobs(filters = {}) {
    return this.api("GET", "/jobs", { query: filters, label: "历史任务" });
  }

  cancelJob(jobId) {
    return this.api("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, { label: "取消任务" });
  }

  // ---- 详情套图 /api/v1/aplus/*：同一把钥匙；报错在 detail 里（apiError 两种都认）----

  aplusModules() {
    // 这个接口不用登录就能看 ⇒ 它成功不能算「钥匙验证过了」。
    return this.api("GET", "/templates", { base: APLUS_BASE, label: "详情模块清单", provesKey: false });
  }

  // 提交一组详情模块。服务端要的 module_ids / selling_points / size_chart_data 是「JSON 字符串」，
  // 编码只在这里做一次：卖点不是合法 JSON 数组时服务端不报错、直接当没给，所以绝不能让调用方自己拼。
  // 这个接口没有去重键，重发 = 再建一个任务再扣一次钱 ⇒ noRetry，断网 / 超时 / 5xx 都交给上层按「结果不确定」处理。
  async aplusSubmit({ moduleIds, referencePath, sellingPoints, modelId, fields = {}, sizeChart = null }, { readFile = readFileSync } = {}) {
    const type = IMAGE_EXTENSIONS[extname(referencePath).toLowerCase()];
    if (!type) throw new CliError("unsupported_media_format", `参考图 ${referencePath} 不是 JPG / PNG / WebP。`, { exitCode: 2 });
    let bytes;
    try {
      bytes = readFile(referencePath);
    } catch {
      throw new CliError("missing_reference", `读不到参考图 ${referencePath}（路径不对或没有权限）。`, { exitCode: 2 });
    }
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new CliError("media_too_large", `参考图 ${referencePath} 有 ${(bytes.length / 1048576).toFixed(1)} MB，超过 10 MB 上限。`, { exitCode: 2 });
    }
    if (!Array.isArray(moduleIds) || !Array.isArray(sellingPoints)) {
      throw new CliError("invalid_request", "内部错误：模块和卖点要是数组。", { exitCode: 2 });
    }
    const form = new FormData();
    form.append("module_ids", JSON.stringify(moduleIds.map(String)));
    form.append("selling_points", JSON.stringify(sellingPoints.map(String)));
    form.append("model_id", modelId);
    for (const [name, value] of Object.entries(fields)) {
      if (typeof value === "string" && value.trim()) form.append(name, value);
    }
    if (sizeChart) form.append("size_chart_data", JSON.stringify(sizeChart));
    form.append("reference_image", new Blob([bytes], { type }), basename(referencePath));
    return this.api("POST", "/generate", { base: APLUS_BASE, form, label: "提交详情套图", timeoutMs: 300_000, noRetry: true });
  }

  aplusJob(jobId) {
    return this.api("GET", `/jobs/${encodeURIComponent(jobId)}`, { base: APLUS_BASE, label: "查详情套图任务" });
  }

  aplusJobs({ limit, cursor } = {}) {
    return this.api("GET", "/jobs", { base: APLUS_BASE, query: { limit, cursor }, label: "详情套图任务列表" });
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
    const response = await this._post(UPLOAD_ENDPOINT, { method: "POST", body: form }, { label: "上传参考图" });
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
