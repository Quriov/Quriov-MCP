// 命令行各模块共用的小东西：版本号、服务地址、报错类型、原子写文件。
// 版本号只写在 package.json 一处，这里读出来。

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const ORIGIN = "https://quriovai.com";
export const MCP_ENDPOINT = `${ORIGIN}/mcp/v1`;
export const API_BASE = `${ORIGIN}/api/v1/mcp`;
export const UPLOAD_ENDPOINT = `${API_BASE}/uploads`;
export const USER_AGENT = `quriov-cli/${VERSION} (+https://github.com/Quriov/Quriov-MCP)`;
export const INSTALL_DOC_URL = `${ORIGIN}/install.md`;
export const KEYS_PAGE_URL = `${ORIGIN}/me/access-keys`;

export class CliError extends Error {
  constructor(
    code,
    message,
    { exitCode = 1, retryAfterSeconds = null, fatal = true, requestId = null, httpStatus = null, details = null } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.retryAfterSeconds = retryAfterSeconds;
    this.fatal = fatal;
    this.requestId = requestId; // 服务端给的请求编号（报障用）
    this.httpStatus = httpStatus;
    this.details = details; // 服务端报错里的其余字段（required / available / fields …）
  }
}

// --json 模式下报错也给机器读的形状（钥匙永远不在里面：消息本身就不含钥匙）。
export function errorPayload(error) {
  if (error instanceof CliError) {
    return {
      error: {
        error_code: error.code,
        reason: error.message,
        request_id: error.requestId ?? null,
        http_status: error.httpStatus ?? null,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  return { error: { error_code: "internal_error", reason: "命令行内部出错", request_id: null, http_status: null } };
}

// 报错尾巴：「（错误码 X，请求编号 Y）」。两样都没有就是空串。
export function errorTail(code, requestId) {
  const parts = [];
  if (code) parts.push(`错误码 ${code}`);
  if (requestId) parts.push(`请求编号 ${requestId}`);
  return parts.length ? `（${parts.join("，")}）` : "";
}

// 服务端对外错误码 → 中文说明。每一条都说清「是什么原因」和「下一步做什么」。
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
  insufficient_scope: `这把钥匙没有权限做这件事（HTTP 403）。到 ${KEYS_PAGE_URL} 看看钥匙状态，或新建一把后重跑 quriov setup。`,
  unauthorized: "钥匙没通过验证。",
  idempotency_conflict:
    "同一个任务编号被用在了内容不同的请求上（多半是状态文件被手改过）。用 --retry-failed 会换新编号重交。",
  lost_from_history:
    "在服务端最近的出图记录里找不到这条（同一把钥匙在别处提交得太多把它挤出去了）。结果如已生成，可在网页出图记录里找到。",
  download_failed: "图已生成、已扣点，但下载失败。稍后运行 resume 会自动重下（结果云端只留 1 天）。",
});

export function describeError(code, fallback) {
  return ERROR_MESSAGES[code] ?? fallback ?? `服务端返回错误：${code}`;
}

// 401 只表示钥匙本身不行（服务端不再有限流）。source：这把钥匙从哪来（「环境变量 QURIOV_API_KEY 的钥匙」
// /「quriov setup 保存的钥匙」…）；detail / requestId：服务端给的中文原因和请求编号。都不含钥匙本身。
export function unauthorizedError(source = null, { detail = null, requestId = null, errorCode = "unauthorized" } = {}) {
  const from = source ? `（正在用${source}）` : "";
  return new CliError(
    "unauthorized",
    [
      `钥匙没通过验证（HTTP 401）${from}${detail ? `：${detail}` : "。"}${errorTail(errorCode, requestId)}`,
      "常见原因：钥匙填错或复制不全；钥匙已在网页上撤销或过期；shell 里留着一个旧的环境变量，里面是另一把钥匙。",
      `到 ${KEYS_PAGE_URL} 检查或新建一把，再运行 quriov setup；有旧环境变量就把它删掉。`,
    ].join("\n"),
    { requestId, httpStatus: 401 },
  );
}

export const EXT_BY_TYPE = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
});

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

export function writeAtomic(file, content, { mode } = {}) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
  renameSync(tmp, file);
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export const realSleep = (ms) => new Promise((done) => setTimeout(done, ms));
