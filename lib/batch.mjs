// 直连批量接口的命令：batch submit / batch status（服务端批次）/ jobs get|list|query|cancel。
//
// 和 bin/quriov.mjs 里的 batch plan/run/resume（本机按表跑、逐张走 MCP）不同，这里一次把多条交给
// 服务端 POST /api/v1/mcp/batches，由服务端逐条提交；进度、结果、实扣都从服务端查。
// 和服务端说话仍然只经过 lib/transport.mjs 的 QuriovClient。

import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { CliError, EXT_BY_TYPE, errorPayload, errorTail, realSleep, safeName, sha256 } from "./common.mjs";

export const MAX_ITEMS_PER_REQUEST = 50; // 服务端逐条同步提交（约 1–2 秒一条），一次太多会撞代理超时
export const MAX_JOB_IDS_PER_QUERY = 200;
export const MAX_TEMPLATES_PER_ITEM = 8;
export const MAX_ITEM_PROMPT_CHARS = 8000;
export const MAX_PAGES = 1000; // --all 翻页的保险上限，防止服务端游标出错时死循环
export const DEFAULT_WAIT_MINUTES = 180;

export const JOB_STATUSES = Object.freeze([
  "submitting",
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "unknown",
  "expired",
]);
const TERMINAL = new Set(["succeeded", "partial", "failed", "cancelled", "unknown", "expired"]);
const NOT_OK = new Set(["partial", "failed", "cancelled", "unknown", "expired"]);

export const STATUS_TEXT = Object.freeze({
  submitting: "提交中",
  queued: "排队中",
  running: "生成中",
  succeeded: "成功",
  partial: "部分成功",
  failed: "失败",
  cancelled: "已取消",
  unknown: "不确定（用同一个 key 重交即可，不会重复扣钱）",
  expired: "已过期（结果取不到了）",
  planned: "待提交",
  duplicate: "已交过（不会重复扣钱）",
});

const ITEM_FIELDS = Object.freeze(["model", "prompt", "template_ids", "reference_urls", "aspect_ratio", "n", "idempotency_key", "tag"]);

// ---------------------------------------------------------------------------
// 读条目：.jsonl（一行一条）、.json（数组，或 {batch_key, items}）、- 从标准输入读（自动判断）
// ---------------------------------------------------------------------------

export function parseItemsText(text, { format = "auto" } = {}) {
  const input = String(text ?? "").replace(/^﻿/, "");
  if (!input.trim()) throw new CliError("spec_empty", "没有读到任何条目（文件或标准输入是空的）。", { exitCode: 2 });

  const fromWhole = (value) => {
    if (Array.isArray(value)) return { rawItems: value, fileBatchKey: null, whereOf: (i) => `第 ${i + 1} 条` };
    if (value && typeof value === "object" && Array.isArray(value.items)) {
      return {
        rawItems: value.items,
        fileBatchKey: typeof value.batch_key === "string" && value.batch_key.trim() ? value.batch_key.trim() : null,
        whereOf: (i) => `第 ${i + 1} 条`,
      };
    }
    if (value && typeof value === "object") return { rawItems: [value], fileBatchKey: null, whereOf: () => "第 1 条" };
    throw new CliError("invalid_spec", "内容要是 JSON 数组、{\"items\": [...]}，或一行一个 JSON 对象（JSONL）。", { exitCode: 2 });
  };

  if (format !== "jsonl") {
    try {
      return fromWhole(JSON.parse(input));
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (format === "json") {
        throw new CliError("invalid_spec", `不是合法的 JSON（${error.message}）。一行一条的请用 .jsonl 扩展名。`, { exitCode: 2 });
      }
    }
  }
  const rawItems = [];
  const lines = [];
  const errors = [];
  input.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rawItems.push(JSON.parse(line));
      lines.push(i + 1);
    } catch {
      errors.push(`第 ${i + 1} 行不是合法的 JSON。`);
    }
  });
  if (errors.length) {
    throw new CliError("invalid_spec", `条目文件有 ${errors.length} 处要改（一条都没提交）：\n${errors.map((e) => `  - ${e}`).join("\n")}`, {
      exitCode: 2,
    });
  }
  return { rawItems, fileBatchKey: null, whereOf: (i) => `第 ${lines[i]} 行` };
}

// 条目的去重键：同一份内容永远得到同一个键 → 同一个文件重跑，服务端认出来，不会重复扣钱。
// 内容 = 除 idempotency_key 以外的全部字段（缺省值先补齐，写不写 n:1 算同一份）。
export function itemIdempotencyKey(item) {
  const canonical = JSON.stringify([
    "v1",
    item.model,
    item.prompt,
    item.template_ids ?? [],
    item.reference_urls ?? [],
    item.aspect_ratio ?? null,
    item.n ?? 1,
    item.tag ?? null,
  ]);
  return `qcli-${sha256(canonical).slice(0, 40)}`;
}

// 没给 batch_key 时用全部条目的键算一个：同一个文件重跑落回同一个批次，分几次交也归在同一个批次下。
export function autoBatchKey(items) {
  return `qcli-batch-${sha256(items.map((i) => i.idempotency_key).join("\n")).slice(0, 40)}`;
}

// 校验并补齐。问题一次全报出来；有问题就一条都不交。
export function prepareItems(rawItems, whereOf = (i) => `第 ${i + 1} 条`) {
  const items = [];
  const errors = [];
  const firstSeen = new Map();
  rawItems.forEach((raw, i) => {
    const where = whereOf(i);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${where}：要是一个 JSON 对象。`);
      return;
    }
    const unknown = Object.keys(raw).filter((k) => !ITEM_FIELDS.includes(k));
    if (unknown.length) errors.push(`${where}：不认识的字段 ${unknown.join("、")}（能用的：${ITEM_FIELDS.join("、")}）。`);
    const item = {};
    const str = (name, { required = false, max = null } = {}) => {
      const v = raw[name];
      if (v === undefined || v === null || v === "") {
        if (required) errors.push(`${where}：缺 ${name}。`);
        return;
      }
      if (typeof v !== "string" || !v.trim()) {
        errors.push(`${where}：${name} 要是非空字符串。`);
        return;
      }
      if (max && v.length > max) errors.push(`${where}：${name} 有 ${v.length} 字，超过 ${max} 字上限。`);
      item[name] = v;
    };
    const list = (name, max) => {
      const v = raw[name];
      if (v === undefined || v === null) return;
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) {
        errors.push(`${where}：${name} 要是字符串数组。`);
        return;
      }
      if (max && v.length > max) errors.push(`${where}：${name} 最多 ${max} 个，这里有 ${v.length} 个。`);
      if (v.length) item[name] = v;
    };
    str("model", { required: true, max: 128 });
    str("prompt", { required: true, max: MAX_ITEM_PROMPT_CHARS });
    list("template_ids", MAX_TEMPLATES_PER_ITEM);
    list("reference_urls", null);
    for (const url of item.reference_urls ?? []) {
      if (!/^https:\/\//i.test(url)) {
        errors.push(`${where}：参考图 ${url} 不是 https 链接。本地图先用 quriov upload 换成链接（或改用 quriov batch run 按表自动上传）。`);
      }
    }
    str("aspect_ratio", { max: 16 });
    if (raw.n !== undefined && raw.n !== null) {
      if (!Number.isInteger(raw.n) || raw.n < 1 || raw.n > 4) errors.push(`${where}：n 只能是 1 到 4 的整数。`);
      else item.n = raw.n;
    }
    str("tag", { max: 200 });
    str("idempotency_key", { max: 128 });
    if (!item.idempotency_key) item.idempotency_key = itemIdempotencyKey(item);
    const earlier = firstSeen.get(item.idempotency_key);
    if (earlier !== undefined) {
      errors.push(
        raw.idempotency_key
          ? `${where}：idempotency_key「${item.idempotency_key}」和${earlier}重复了。`
          : `${where}：和${earlier}内容完全一样（会得到同一个任务）。真要两份请改 n，或给两条不同的 idempotency_key。`,
      );
    } else firstSeen.set(item.idempotency_key, where);
    items.push(item);
  });
  return { items, errors };
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// 点数是十进制字符串，放大成整数再算，避免浮点误差。
const SCALE = 10_000n;
function toScaled(v) {
  const [whole, frac = ""] = String(v ?? "0").trim().split(".");
  const negative = whole.startsWith("-");
  const n = BigInt(whole.replace("-", "") || "0") * SCALE + BigInt((frac + "0000").slice(0, 4));
  return negative ? -n : n;
}

function fromScaled(n) {
  const abs = n < 0n ? -n : n;
  return `${n < 0n ? "-" : ""}${abs / SCALE}.${(abs % SCALE).toString().padStart(4, "0")}`;
}

function sum(values) {
  return fromScaled(values.filter((v) => v !== null && v !== undefined && v !== "").reduce((acc, v) => acc + toScaled(v), 0n));
}

function exceeds(a, b) {
  return toScaled(a) > toScaled(b);
}

// 分组提交（或估价）。某一组失败时把已经交完的部分挂在 error.partial 上再抛出。
export async function submitItems(client, items, { batchKey = null, dryRun = false, chunkSize = MAX_ITEMS_PER_REQUEST, log = () => {} } = {}) {
  const groups = chunk(items, chunkSize);
  const result = {
    dry_run: dryRun,
    batch_key: batchKey,
    batch_ids: [],
    request_ids: [],
    chunks: { total: groups.length, done: 0, size: chunkSize },
    items: [],
    summary: null,
  };
  for (const [gi, group] of groups.entries()) {
    if (groups.length > 1) log(`  ${dryRun ? "估价" : "提交"}第 ${gi + 1}/${groups.length} 组（${group.length} 条）…`);
    let res;
    try {
      res = await client.submitBatch({ items: group, batchKey, dryRun });
    } catch (error) {
      result.summary = summarizeSubmit(result.items, null);
      error.partial = result;
      throw error;
    }
    const offset = gi * chunkSize;
    if (res.batch_id && !result.batch_ids.includes(res.batch_id)) result.batch_ids.push(res.batch_id);
    if (res.request_id) result.request_ids.push(res.request_id);
    for (const item of res.items ?? []) result.items.push({ ...item, index: offset + (Number(item.index) || 0) });
    result.balance = res.summary?.balance ?? result.balance ?? null;
    result.chunks.done += 1;
  }
  result.summary = summarizeSubmit(result.items, result.balance ?? null);
  return result;
}

export function summarizeSubmit(items, balance) {
  const s = {
    items: items.length,
    submitted: 0,
    deduplicated: 0,
    rejected: 0,
    estimated_images: 0,
    estimated_credits: sum(items.map((i) => i.estimated_credits)),
    new_items: 0,
    new_credits: "0.0000",
    balance,
  };
  const fresh = [];
  for (const item of items) {
    s.estimated_images += Number(item.estimated_images) || 0;
    if (item.error_code || item.status === "failed") s.rejected += 1;
    else if (item.deduplicated || item.status === "duplicate") s.deduplicated += 1;
    else {
      s.submitted += 1;
      fresh.push(item.estimated_credits);
    }
  }
  s.new_items = s.submitted;
  s.new_credits = sum(fresh);
  return s;
}

// ---------------------------------------------------------------------------
// 显示
// ---------------------------------------------------------------------------

function reasonText(obj) {
  if (!obj?.error_code && !obj?.reason) return "";
  return `${obj.reason ?? ""}${errorTail(obj.error_code, null)}`;
}

export function renderSubmit(result, { heading = null } = {}) {
  const lines = [];
  if (heading) lines.push(heading);
  const ids = result.batch_ids.length ? result.batch_ids.join("、") : "（估价不生成批次号）";
  lines.push(`批次 ${ids}${result.batch_key ? `（batch_key ${result.batch_key}）` : ""}`);
  for (const item of result.items) {
    const label = item.tag ?? item.idempotency_key;
    const status = STATUS_TEXT[item.status] ?? item.status;
    const parts = [`  #${item.index + 1}`, label, item.model];
    if (item.job_id) parts.push(`任务 ${item.job_id}`);
    parts.push(status);
    if (result.dry_run) parts.push(`${item.estimated_images} 张 约 ${item.estimated_credits ?? "?"} 点`);
    const why = reasonText(item);
    if (why) parts.push(`原因：${why}`);
    lines.push(parts.join("  "));
  }
  const s = result.summary;
  if (result.dry_run) {
    lines.push(
      `合计 ${s.items} 条：要新交 ${s.new_items} 条、约 ${s.new_credits} 点；已交过 ${s.deduplicated} 条（不会重复扣钱）；会被拒 ${s.rejected} 条。当前余额 ${s.balance ?? "未知"} 点。`,
    );
    lines.push("（只是估价：没有提交，没有花钱。实扣只按真正出来的图算。）");
  } else {
    lines.push(
      `合计 ${s.items} 条：新交 ${s.submitted} 条，已交过 ${s.deduplicated} 条（没重复扣钱），被拒 ${s.rejected} 条；共约 ${s.estimated_images} 张。实扣看结果（只扣真正出来的图）。`,
    );
    if (result.batch_ids.length) lines.push(`看进度 / 下载：quriov batch status ${result.batch_ids[0]} --wait --download ./out`);
  }
  return lines.join("\n");
}

function jobLine(job) {
  const img = job.images ?? {};
  const parts = [`  ${job.job_id}`, STATUS_TEXT[job.status] ?? job.status];
  if (job.tag) parts.push(job.tag);
  if (job.model) parts.push(job.model);
  if (img.total !== undefined) parts.push(`图 ${img.completed ?? 0}/${img.total}${img.failed ? `（失败 ${img.failed}）` : ""}`);
  if (job.settled_credits !== null && job.settled_credits !== undefined) parts.push(`实扣 ${job.settled_credits} 点`);
  const why = reasonText(job);
  if (why) parts.push(`原因：${why}`);
  return parts.join("  ");
}

export function renderJobs(items) {
  return items.map(jobLine).join("\n");
}

export function renderJob(job) {
  const lines = [jobLine(job).trim()];
  if (job.batch_id) lines.push(`  批次 ${job.batch_id}`);
  if (job.idempotency_key) lines.push(`  idempotency_key ${job.idempotency_key}`);
  if (job.created_at) lines.push(`  提交于 ${job.created_at}`);
  for (const m of job.media ?? []) lines.push(`  ${m.template_id ? `[${m.template_id}] ` : ""}${m.url}`);
  if ((job.media ?? []).length) lines.push("  （链接 24 小时有效，尽快下载）");
  return lines.join("\n");
}

export function renderBatchStatus(status) {
  const s = status.summary ?? {};
  const by = Object.entries(s.by_status ?? {})
    .map(([k, v]) => `${STATUS_TEXT[k] ?? k} ${v}`)
    .join(" · ");
  const lines = [
    `批次 ${status.batch_id}：${s.done ? "全部结束" : "还没全部结束"}；${s.jobs ?? 0} 条（${by || "无"}）`,
    `  图 ${s.images_completed ?? 0}/${s.images_total ?? 0}${s.images_failed ? `，失败 ${s.images_failed}` : ""}；已结算 ${s.settled_jobs ?? 0} 条，实扣 ${s.settled_credits ?? "0"} 点`,
  ];
  if ((status.items ?? []).length) lines.push(renderJobs(status.items));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 查询 / 等待 / 下载
// ---------------------------------------------------------------------------

export async function listAllJobs(client, filters, { all = false, maxPages = MAX_PAGES } = {}) {
  const items = [];
  let cursor = filters.cursor ?? null;
  let pages = 0;
  let requestId = null;
  for (;;) {
    const page = await client.listJobs({ ...filters, cursor });
    pages += 1;
    requestId = page.request_id ?? requestId;
    items.push(...(page.items ?? []));
    cursor = page.next_cursor ?? null;
    if (!all || !cursor || pages >= maxPages) break;
  }
  return { items, next_cursor: cursor, pages, request_id: requestId };
}

export async function queryJobsChunked(client, ids) {
  const items = [];
  const missing = [];
  for (const group of chunk([...new Set(ids)], MAX_JOB_IDS_PER_QUERY)) {
    const res = await client.queryJobs(group);
    items.push(...(res.items ?? []));
    missing.push(...(res.missing ?? []));
  }
  return { items, missing };
}

export async function waitForBatch(client, batchId, {
  pollSeconds = 15,
  timeoutMinutes = DEFAULT_WAIT_MINUTES,
  sleep = realSleep,
  now = Date.now,
  log = () => {},
  shouldStop = () => false,
} = {}) {
  let status = await client.getBatch(batchId);
  const deadline = now() + timeoutMinutes * 60_000;
  let polls = 0;
  while (!status.summary?.done) {
    if (shouldStop()) return { status, stopped: true, timedOut: false, polls };
    if (now() >= deadline) return { status, stopped: false, timedOut: true, polls };
    const s = status.summary ?? {};
    log(`  进度：结束 ${(s.jobs ?? 0) - countUnfinished(s)}/${s.jobs ?? 0} 条，图 ${s.images_completed ?? 0}/${s.images_total ?? 0}；${pollSeconds} 秒后再查…`);
    await sleep(pollSeconds * 1000);
    if (shouldStop()) return { status, stopped: true, timedOut: false, polls };
    status = await client.getBatch(batchId);
    polls += 1;
  }
  return { status, stopped: false, timedOut: false, polls };
}

function countUnfinished(summary) {
  return Object.entries(summary.by_status ?? {})
    .filter(([k]) => !TERMINAL.has(k))
    .reduce((n, [, v]) => n + (Number(v) || 0), 0);
}

// 结果图按「标记 / 模板」命名：<目录>/<tag 或任务号>/<模板或 image>[-序号].<扩展名>。已存在的不重下。
export async function downloadJobs(client, jobs, dir, { log = () => {} } = {}) {
  const root = resolve(dir);
  const used = new Set();
  const results = [];
  for (const job of jobs) {
    const media = (job.media ?? []).filter((m) => m && typeof m.url === "string");
    if (!media.length) continue;
    const folder = join(root, safeName(job.tag || job.job_id));
    const perSlot = new Map();
    for (const m of media) {
      const slot = m.template_id || "image";
      perSlot.set(slot, (perSlot.get(slot) ?? 0) + 1);
    }
    const seen = new Map();
    for (const m of media) {
      const slot = m.template_id || "image";
      const k = (seen.get(slot) ?? 0) + 1;
      seen.set(slot, k);
      const ext = EXT_BY_TYPE[m.content_type] ?? (extname(new URL(m.url).pathname) || ".png");
      let stem = `${safeName(slot)}${perSlot.get(slot) > 1 ? `-${k}` : ""}`;
      let target = join(folder, `${stem}${ext}`);
      if (used.has(target)) {
        stem = `${stem}-${safeName(String(job.job_id).slice(0, 8))}`;
        target = join(folder, `${stem}${ext}`);
      }
      used.add(target);
      const entry = { job_id: job.job_id, tag: job.tag ?? null, template_id: m.template_id ?? null, file: target };
      if (existsSync(target)) {
        results.push({ ...entry, status: "exists" });
        continue;
      }
      try {
        await client.download(m.url, target);
        results.push({ ...entry, status: "downloaded" });
        log(`  已下载 ${target}`);
      } catch (error) {
        results.push({ ...entry, status: "failed", reason: error.message });
        log(`  下载失败 ${target}：${error.message}`);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

function intArg(value, name, { min, max, fallback }) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError("usage", `${name} 要是 ${min} 到 ${max} 之间的整数。`, { exitCode: 2 });
  return n;
}

async function readAll(stdin) {
  if (!stdin || typeof stdin[Symbol.asyncIterator] !== "function") {
    throw new CliError("usage", "没有可读的标准输入。", { exitCode: 2 });
  }
  let text = "";
  for await (const piece of stdin) text += piece;
  return text;
}

async function readItemsSource(source, stdin) {
  if (source === "-") return { text: await readAll(stdin), format: "auto" };
  const file = resolve(source);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new CliError("spec_missing", `读不到条目文件 ${source}。`, { exitCode: 2 });
  }
  const ext = extname(file).toLowerCase();
  return { text, format: ext === ".jsonl" || ext === ".ndjson" ? "jsonl" : ext === ".json" ? "json" : "auto" };
}

export async function batchSubmitCommand(source, args, ctx) {
  const { makeClient, print, log, stdin, confirm } = ctx;
  if (!source) throw new CliError("usage", "用法：quriov batch submit <条目.jsonl|条目.json|->（- = 从标准输入读）", { exitCode: 2 });
  const chunkSize = intArg(args.chunkSize, "--chunk-size", { min: 1, max: MAX_ITEMS_PER_REQUEST, fallback: MAX_ITEMS_PER_REQUEST });
  const { text, format } = await readItemsSource(source, stdin);
  const { rawItems, fileBatchKey, whereOf } = parseItemsText(text, { format });
  if (!rawItems.length) throw new CliError("spec_empty", "没有读到任何条目。", { exitCode: 2 });
  const { items, errors } = prepareItems(rawItems, whereOf);
  if (errors.length) {
    throw new CliError("invalid_spec", `条目有 ${errors.length} 处要改（一条都没提交）：\n${errors.map((e) => `  - ${e}`).join("\n")}`, { exitCode: 2 });
  }
  const batchKey = (args.batchKey ?? "").trim() || fileBatchKey || autoBatchKey(items);
  const client = makeClient();

  // 先估价（免费，不提交）：拿到每条估价、哪些已经交过、哪些会被拒、余额。
  const estimate = await submitItems(client, items, { batchKey, dryRun: true, chunkSize, log });
  if (args.dryRun) {
    if (args.json) print(JSON.stringify(estimate));
    else print(renderSubmit(estimate));
    return estimate.summary.rejected ? 3 : 0;
  }

  const es = estimate.summary;
  if (es.balance !== null && es.balance !== undefined && es.new_items && exceeds(es.new_credits, es.balance)) {
    throw new CliError(
      "insufficient_credits",
      `余额不够这批：要新交的 ${es.new_items} 条约 ${es.new_credits} 点，余额 ${es.balance} 点。一条都没提交；充值后再运行同一条命令。`,
      { exitCode: 4, details: { required: es.new_credits, available: es.balance } },
    );
  }
  if (!args.json) print(renderSubmit(estimate, { heading: "估价（还没提交）：" }));
  if (es.new_items && !args.yes) {
    if (!stdin?.isTTY) {
      throw new CliError("needs_confirmation", "这一步要花钱，需要确认。先用 --dry-run 看估价，确认后再加 --yes。", { exitCode: 2 });
    }
    if (!(await confirm(`确认新交 ${es.new_items} 条、约 ${es.new_credits} 点？`))) {
      print("没有提交。");
      return 1;
    }
  }

  let result;
  try {
    result = await submitItems(client, items, { batchKey, dryRun: false, chunkSize, log });
  } catch (error) {
    const partial = error.partial;
    if (partial) {
      const hint = [502, 504, 520, 522, 524].includes(error.httpStatus)
        ? "（多半是一次交得太多撞了代理超时，可以加 --chunk-size 20 再跑）"
        : "";
      const note = `已交完 ${partial.chunks.done}/${partial.chunks.total} 组。已交的都记了账：重跑同一条命令会接着交完，不会重复扣钱${hint}。`;
      error.message = `${error.message}\n${note}`;
      if (args.json) {
        // 已交完的那几组 + 报错，一份 JSON 给 AI
        print(JSON.stringify({ ...partial, ...errorPayload(error) }));
        error.jsonPrinted = true;
      } else if (partial.items.length) print(renderSubmit(partial));
    }
    throw error;
  }
  result.estimate = es;
  if (args.json) print(JSON.stringify(result));
  else print(renderSubmit(result));
  return result.summary.rejected ? 3 : 0;
}

export async function batchStatusCommand(batchId, args, ctx) {
  const { makeClient, print, log, sleep, now, shouldStop } = ctx;
  if (!batchId) throw new CliError("usage", "用法：quriov batch status <批次号> [--wait] [--download 目录]", { exitCode: 2 });
  const client = makeClient();
  const pollSeconds = intArg(args.pollSeconds, "--poll-seconds", { min: 5, max: 300, fallback: 15 });
  const timeoutMinutes = intArg(args.timeout, "--timeout", { min: 1, max: 24 * 60, fallback: DEFAULT_WAIT_MINUTES });
  let outcome;
  try {
    outcome = args.wait
      ? await waitForBatch(client, batchId, { pollSeconds, timeoutMinutes, sleep, now, log, shouldStop })
      : { status: await client.getBatch(batchId), stopped: false, timedOut: false };
  } catch (error) {
    if (error.code === "not_found") {
      error.message += `\n批次号要用 batch submit 打印的那个；本机按表跑的批次（batch run）用 quriov batch status <输出目录>。`;
    }
    throw error;
  }
  const { status } = outcome;
  let jobs = status.items ?? [];
  if ((status.summary?.jobs ?? 0) > jobs.length) {
    // 一次最多回 1000 条，更大的批次翻页取全
    jobs = (await listAllJobs(client, { batch_id: batchId, limit: 100 }, { all: true })).items;
  }
  const downloads = args.download ? await downloadJobs(client, jobs, args.download, { log }) : null;
  if (args.json) {
    print(JSON.stringify({ ...status, items: jobs, ...(downloads ? { downloads } : {}), waited: Boolean(args.wait), stopped: outcome.stopped, timed_out: outcome.timedOut }));
  } else {
    print(renderBatchStatus({ ...status, items: jobs }));
    if (downloads) {
      const ok = downloads.filter((d) => d.status !== "failed").length;
      print(`下载到 ${resolve(args.download)}：${ok}/${downloads.length} 张${downloads.some((d) => d.status === "failed") ? "；有下载失败的，重跑同一条命令会补下" : ""}。`);
    }
    if (outcome.timedOut) print(`等了 ${timeoutMinutes} 分钟还没全部结束；稍后再运行同一条命令接着等。`);
    if (outcome.stopped) print("已停止等待；稍后再运行同一条命令接着等。");
    if (!status.summary?.done && !args.wait) print(`还没全部结束。等它结束并下载：quriov batch status ${status.batch_id ?? batchId} --wait --download ./out`);
  }
  if (outcome.stopped || outcome.timedOut) return 4;
  if (downloads?.some((d) => d.status === "failed")) return 3;
  if (status.summary?.done && jobs.some((j) => NOT_OK.has(j.status))) return 3;
  return 0;
}

export async function jobsCommand(sub, rest, args, ctx) {
  const { makeClient, print, stdin } = ctx;
  if (sub === "get") {
    if (!rest[0]) throw new CliError("usage", "用法：quriov jobs get <任务号>", { exitCode: 2 });
    const job = await makeClient().getJob(rest[0]);
    print(args.json ? JSON.stringify(job) : renderJob(job));
    return 0;
  }
  if (sub === "list") {
    if (args.status && !JOB_STATUSES.includes(args.status)) {
      throw new CliError("usage", `--status 只认：${JOB_STATUSES.join("、")}。`, { exitCode: 2 });
    }
    const limit = intArg(args.limit, "--limit", { min: 1, max: 100, fallback: args.all ? 100 : 20 });
    const filters = {
      limit,
      cursor: args.cursor,
      status: args.status,
      tag: args.tag,
      model: args.model,
      batch_id: args.batch,
      since: args.since,
      until: args.until,
    };
    const res = await listAllJobs(makeClient(), filters, { all: Boolean(args.all) });
    if (args.json) print(JSON.stringify({ items: res.items, next_cursor: res.next_cursor, request_id: res.request_id }));
    else {
      print(res.items.length ? renderJobs(res.items) : "（没有符合条件的任务）");
      if (res.next_cursor) print(`还有更早的：加 --cursor ${res.next_cursor} 接着翻，或加 --all 一次取完。`);
    }
    return 0;
  }
  if (sub === "query") {
    let ids = rest;
    if (ids.length === 1 && ids[0] === "-") ids = (await readAll(stdin)).split(/[\s,]+/);
    ids = ids.map((s) => s.trim()).filter(Boolean);
    if (!ids.length) throw new CliError("usage", "用法：quriov jobs query <任务号...>（或 - 从标准输入读，空格 / 换行 / 逗号隔开）", { exitCode: 2 });
    const res = await queryJobsChunked(makeClient(), ids);
    if (args.json) print(JSON.stringify(res));
    else {
      if (res.items.length) print(renderJobs(res.items));
      if (res.missing.length) print(`查不到（不存在，或不是这把钥匙的）：${res.missing.join("、")}`);
    }
    return res.missing.length ? 3 : 0;
  }
  if (sub === "cancel") {
    if (!rest[0]) throw new CliError("usage", "用法：quriov jobs cancel <任务号>", { exitCode: 2 });
    const res = await makeClient().cancelJob(rest[0]);
    if (args.json) print(JSON.stringify(res));
    else print(`${rest[0]}：${res.message ?? res.status}${errorTail(res.code, null)}`);
    return ["cancelled", "partially_cancelled"].includes(res.code ?? res.status) ? 0 : 3;
  }
  throw new CliError("usage", "jobs 后面要跟 get / list / query / cancel。运行 quriov --help 看用法。", { exitCode: 2 });
}
