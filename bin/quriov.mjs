#!/usr/bin/env node
// Quriov 官方命令行。零依赖（Node 20+ 自带的 fetch / FormData / fs）。
//
// 和 Quriov MCP 用同一把钥匙、打同一个后端。扣点、失败退款、出图记录全部在服务端；这里只做本机的事：
// 一条命令装好（setup：验钥匙、写 MCP 配置、装技能、自检）、读图上传、按表提交、轮询、
// 下载到文件夹、写出每张花了多少点、断了能接着跑。
//
// 模块：lib/transport.mjs 是和服务端说话的唯一出口；lib/setup.mjs 管客户端配置、技能和自检。
// 安全边界（见 AGENTS.md）：钥匙永远不从命令行参数读、不打印、不写进日志和批次状态文件。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  chmodSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CliError,
  INSTALL_DOC_URL,
  KEYS_PAGE_URL,
  MCP_ENDPOINT,
  ORIGIN,
  UPLOAD_ENDPOINT,
  VERSION,
  describeError,
  realSleep,
  sha256,
  writeAtomic,
} from "../lib/common.mjs";
import {
  DEFAULT_REQUESTS_PER_MINUTE,
  IMAGE_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  QuriovClient,
  RequestBudget,
  parseToolError,
} from "../lib/transport.mjs";
import {
  CORE_TOOLS,
  checkKeyShape,
  clientTargets,
  installSkill,
  removeClientConfig,
  removeSkill,
  renderDoctor,
  runDoctor,
  skillDirsFor,
  writeClientConfig,
} from "../lib/setup.mjs";

export {
  CliError,
  CORE_TOOLS,
  MCP_ENDPOINT,
  ORIGIN,
  QuriovClient,
  RequestBudget,
  UPLOAD_ENDPOINT,
  VERSION,
  describeError,
  parseToolError,
};

// 钥匙的环境变量：第一个是正式名字；后三个是以前在不同地方出现过的名字，照认，已经配好的人不用重配。
export const KEY_ENV_NAMES = Object.freeze([
  "QURIOV_API_KEY",
  "QURIOV_MCP_ACCESS_KEY",
  "QURIOV_MCP_KEY",
  "QURIOV_ACCESS_KEY",
]);

export const DEFAULT_CONCURRENCY = 4; // 每个组织同时出图 4 张，再多只是在服务端排队
export const DEFAULT_POLL_SECONDS = 15;
export const MAX_IMAGES_PER_SUBMIT = 4;
export const MAX_PROMPT_CHARS = 8000;
const UPLOAD_REUSE_MARGIN_MS = 2 * 3600 * 1000; // 参考图链接 24 小时有效；剩不到 2 小时就重传
const UNKNOWN_GIVE_UP_MS = 10 * 60 * 1000;
const MISSING_GIVE_UP_POLLS = 8;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const STATE_DIR = ".quriov";
const EXT_BY_TYPE = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
});
const TERMINAL_OK = new Set(["succeeded", "partial"]);

// ---------------------------------------------------------------------------
// 钥匙：环境变量 → quriov setup 存下的文件。永远不从命令行参数读。
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

export function resolveKey({ env = process.env, readFile = readFileSync, path, home, platform } = {}) {
  for (const name of KEY_ENV_NAMES) {
    const value = (env[name] ?? "").trim();
    if (value) return { key: value, source: `环境变量 ${name}` };
  }
  const file = path ?? credentialsPath({ env, home, platform });
  try {
    const stored = JSON.parse(readFile(file, "utf8"));
    if (typeof stored?.key === "string" && stored.key.trim()) {
      return { key: stored.key.trim(), source: "quriov setup 保存的钥匙" };
    }
  } catch {
    // 没配置过：落到下面的报错
  }
  return null;
}

export function requireKey(options) {
  const found = resolveKey(options);
  if (!found) {
    throw new CliError(
      "missing_key",
      [
        "没找到钥匙。运行 quriov setup，按提示粘贴网页上建的钥匙（输入不显示，存在本机用户目录）；",
        "或设置环境变量 QURIOV_API_KEY。",
        `钥匙在 ${KEYS_PAGE_URL} 创建。出于安全，钥匙不能写在命令参数里。`,
      ].join("\n"),
      { exitCode: 2 },
    );
  }
  return found;
}

export function saveKey(key, { path, env = process.env, home, platform } = {}) {
  const file = path ?? credentialsPath({ env, home, platform });
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify({ key, savedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
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
    // 每日提交上限只在服务端还返回它时才提（服务端撤掉限额后这段自然不出现）。
    const remaining = Number(estimate.quota?.daily_generation_remaining);
    if (estimate.quota && Number.isFinite(remaining)) {
      lines.push(`  今天还能提交 ${remaining} 次（${estimate.quota.resets_at ?? "零点"} 重置）。`);
      if (s.submissions > remaining) {
        lines.push(`  注意：这批要提交 ${s.submissions} 次，超过今天剩余次数；用完会自动暂停，重置后运行 resume 接着跑。`);
      }
    }
  } else {
    lines.push("  没有联网估价。加 --estimate 可以联网估价（免费，不出图）。");
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

// 「submitting」= 请求已经发出去，但没收到（或没来得及存下）服务端的回应，比如提交途中被 Ctrl+C。
// 服务端可能已经收下并记账，所以它不是「待提交」；续跑会用原任务编号重发，服务端认得出，不会重复扣钱。
const SENT_UNCONFIRMED = "已发出、待确认";
const SENT_UNCONFIRMED_NOTE = `「${SENT_UNCONFIRMED}」= 请求已发出但没收到回应；resume 会用原任务编号重发确认，不会重复扣钱。`;

const STATUS_LABELS = Object.freeze({
  pending: "待提交",
  submitting: "已发出、待确认",
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
    // 打印真实路径：以前写成 ./货号/图位.png（相对输出目录），看起来像相对当前目录，容易找错地方。
    const where = files.length ? files.join("、") : "（没有图）";
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
  "--client": "client",
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
        "出于安全，钥匙和服务地址不能写在命令参数里（会留在命令历史和进程列表里）。用 quriov setup（按提示粘贴，或从标准输入 --key-stdin）或环境变量 QURIOV_API_KEY。",
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
安装说明：${INSTALL_DOC_URL}

装好 / 检查 / 卸载
  quriov setup                   粘贴网页上建的钥匙（输入不显示）；验证钥匙、存本机、
                                 给本机的 Claude Code / Codex / Cursor 写好 MCP、装技能、自检
         [--key-stdin]           钥匙从标准输入读（给 AI / 脚本用）
         [--client claude,codex,cursor]  只配这几个客户端（默认：本机装了的都配）
         [--dry-run]             只列出会改哪些文件，什么都不写
  quriov doctor                  只读自检：钥匙、MCP、客户端配置、技能
  quriov uninstall [--dry-run]   删掉三个客户端里的 quriov 配置、技能和本机保存的钥匙
  quriov logout                  只删本机保存的钥匙（网页上的钥匙不受影响）
  也可以不 setup，直接设环境变量 QURIOV_API_KEY

查看（免费）
  quriov account                 余额
  quriov models                  能用的模型、模板编号、每张多少点

参考图
  quriov upload <图...>          上传本地参考图，打印 24 小时有效的链接（给 MCP 的 input_media 用）

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
  每个模板 = 一个图位）· prompt 提示词 · model 模型 · aspect_ratio 比例 · n 每个图位几张（1-4）
  文件夹模式：每个子文件夹是一个商品，里面的图当参考图，可放 prompt.txt；用 --templates 指定图位。

退出码：0 全部完成 · 1 出错 · 2 用法不对 · 3 有任务失败 · 4 暂停（服务端限额 / 网络），可 resume
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
    `批次 ${state.batchId}：完成 ${c.done}，失败 ${c.failed}，生成中 ${c.running}，待提交 ${c.pending}，${SENT_UNCONFIRMED} ${c.submitting}，待下载 ${c.download_retry}。`,
  );
  if (c.submitting) lines.push(SENT_UNCONFIRMED_NOTE);
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
    home = homedir(),
    platform = process.platform,
  } = io;
  const where = { env, home, platform };
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
    const { key } = requireKey(where);
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

  const walletLabel = (account) => (account?.wallet_type === "organization" ? "组织钱包" : "个人账户");
  const selectTargets = () => {
    const all = clientTargets(where);
    if (!args.client) return all;
    const wanted = String(args.client)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const unknown = wanted.filter((id) => !all.some((t) => t.id === id));
    if (unknown.length) {
      throw new CliError("usage", `--client 只认 claude、codex、cursor（逗号隔开），不认识：${unknown.join("、")}。`, { exitCode: 2 });
    }
    // 指名的客户端即使没检测到也照配（比如刚装、还没打开过）。
    return all.filter((t) => wanted.includes(t.id)).map((t) => ({ ...t, installed: true }));
  };

  if (command === "setup" || command === "login") {
    const dryRun = Boolean(args.dryRun);
    // --dry-run 不联网、不写文件，用不到钥匙；除非明确说了从标准输入给。
    let key =
      dryRun && !args.keyStdin
        ? ""
        : await readSecret("粘贴 Quriov 钥匙（输入不显示；直接回车沿用本机已保存的），回车确认：", {
            stdin,
            stderr,
            piped: args.keyStdin,
          });
    if (!key) {
      const existing = resolveKey(where);
      if (existing) {
        key = existing.key;
        print(`没有输入新钥匙，沿用${existing.source}。`);
      } else if (!dryRun) {
        throw new CliError("missing_key", `没有输入钥匙。钥匙在 ${KEYS_PAGE_URL} 创建。`, { exitCode: 2 });
      }
    }
    if (key) checkKeyShape(key);
    const targets = selectTargets();
    const active = targets.filter((t) => t.installed);

    if (dryRun) {
      print("（--dry-run：只列出会做什么，没有联网，什么都没写）");
      print(`  存钥匙 → ${credentialsPath(where)}`);
      for (const t of targets) {
        if (!t.installed) print(`  ${t.name}：本机没发现，跳过`);
        else {
          const r = writeClientConfig(t, key ?? "dry-run-placeholder-key", { dryRun: true });
          print(r.status === "skipped" ? `  ${t.name}：会跳过（${r.reason}）→ ${t.config}` : `  ${t.name}：写入 MCP「quriov」→ ${t.config}`);
        }
      }
      for (const d of skillDirsFor(active)) print(`  技能（${d.clients.join("、")}）→ ${installSkill(d.dir, { dryRun: true }).file}`);
      return 0;
    }

    const client = new QuriovClient({ key, fetchImpl, sleep, now, log });
    const account = await client.account(); // 先验证再写任何东西：错的钥匙不落盘
    const file = saveKey(key, where);
    print(`钥匙可用（${walletLabel(account)}），已保存到 ${file}`);
    const problems = [];
    for (const t of targets) {
      if (!t.installed) {
        print(`${t.name}：本机没发现，跳过`);
        continue;
      }
      const r = writeClientConfig(t, key);
      if (r.status === "written") print(`${t.name}：已写入 MCP「quriov」→ ${t.config}`);
      else {
        print(`${t.name}：没改（${r.reason}）→ ${t.config}`);
        problems.push(t.name);
      }
    }
    for (const d of skillDirsFor(active)) {
      const r = installSkill(d.dir);
      print(`技能（${d.clients.join("、")}）：已装到 ${r.file}`);
    }
    if (!active.length) {
      print("本机没发现 Claude Code / Codex / Cursor：命令行已经能用；装了客户端后重跑 quriov setup，或用 --client 指定。");
    }
    const result = await runDoctor({ client, key, targets });
    print("");
    print("自检：");
    print(renderDoctor(result));
    if (!result.ok || problems.length) {
      print("有没通过的项，按上面的提示处理后重跑 quriov setup。");
      return 1;
    }
    print("全部通过。请新开一个会话（新会话才会加载 Quriov 的 MCP 和技能）。");
    return 0;
  }

  if (command === "doctor") {
    const { key } = requireKey(where);
    const client = new QuriovClient({ key, fetchImpl, sleep, now, log });
    const result = await runDoctor({ client, key, targets: clientTargets(where) });
    print(renderDoctor(result));
    return result.ok ? 0 : 1;
  }

  if (command === "uninstall") {
    const dryRun = Boolean(args.dryRun);
    if (dryRun) print("（--dry-run：只列出会删什么，什么都没删）");
    const targets = clientTargets(where);
    for (const t of targets) {
      const r = removeClientConfig(t, { dryRun });
      if (r.status === "removed" || r.status === "planned") print(`${t.name}：${dryRun ? "会删" : "已删"} MCP「quriov」← ${t.config}`);
      else if (r.status === "skipped") print(`${t.name}：没动（${r.reason}）← ${t.config}`);
    }
    for (const d of skillDirsFor(targets)) {
      const r = removeSkill(d.dir, { dryRun });
      if (r.status === "removed" || r.status === "planned") print(`技能：${dryRun ? "会删" : "已删"} ${r.file}`);
      else if (r.status === "skipped") print(`技能：没动 ${r.file}（${r.reason}）`);
    }
    const file = credentialsPath(where);
    if (existsSync(file)) {
      if (!dryRun) rmSync(file);
      print(`本机保存的钥匙：${dryRun ? "会删" : "已删"} ${file}`);
    }
    const envName = KEY_ENV_NAMES.find((name) => (env[name] ?? "").trim());
    if (envName) print(`注意：环境变量 ${envName} 里还有钥匙，请自己从 shell 配置里删掉。`);
    print(`命令行本身：npm uninstall -g quriov。钥匙要作废请到 ${KEYS_PAGE_URL} 撤销（卸载不会作废钥匙）。`);
    return 0;
  }

  if (command === "logout") {
    const file = credentialsPath(where);
    if (existsSync(file)) rmSync(file);
    print(`已删除本机保存的钥匙（${file}）。网页上的钥匙不受影响，要作废请到 ${KEYS_PAGE_URL} 撤销。`);
    return 0;
  }

  if (command === "account") {
    const client = makeClient();
    const a = await client.account();
    if (args.json) {
      print(JSON.stringify(a));
      return 0;
    }
    print(`余额：${a.balance} 点（${walletLabel(a)}）`);
    if (a.quota && a.quota.daily_generation_remaining !== undefined && a.quota.daily_generation_remaining !== null) {
      print(`今天还能提交 ${a.quota.daily_generation_remaining} 次（${a.quota.resets_at ?? "零点"} 重置）`);
    }
    return 0;
  }

  if (command === "upload") {
    const files = [sub, ...rest].filter(Boolean);
    if (!files.length) throw new CliError("usage", "用法：quriov upload <图1> [图2 ...]", { exitCode: 2 });
    const client = makeClient();
    const results = [];
    for (const file of files) {
      const uploaded = await client.upload(resolve(file));
      results.push({ file, url: uploaded.url, expires_in: uploaded.expiresIn });
    }
    if (args.json) print(JSON.stringify({ uploads: results }));
    else for (const r of results) print(`${r.file}\t${r.url}`);
    log(`链接 ${Math.round((results[0]?.expires_in ?? 86400) / 3600)} 小时内有效；在 MCP 里作为 {"type": "image_url", "value": "<链接>"} 放进 input_media。`);
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
    rememberBatch(state, where);
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
      rememberBatch(state, where);
      print(`批次号 ${state.batchId}（断了用 quriov batch resume ${state.batchId} 接着跑）`);
      return execute(state, client, pre.templateAspect);
    }

    if (sub === "status") {
      const state = findState(rest[0] ?? ".", where);
      if (args.json) {
        print(JSON.stringify({ batchId: state.batchId, counts: statusCounts(state), credits: sumCredits(state.jobs.map((j) => j.credits)), pausedUntil: state.pausedUntil, jobs: state.jobs.map(({ args: _a, ...job }) => job) }));
        return 0;
      }
      const c = statusCounts(state);
      print(`批次 ${state.batchId}（${state.createdAt}），输出 ${state.outDir}`);
      print(`  完成 ${c.done} · 失败 ${c.failed} · 生成中 ${c.running} · 待提交 ${c.pending} · ${SENT_UNCONFIRMED} ${c.submitting} · 待下载 ${c.download_retry}，共 ${state.jobs.length}`);
      if (c.submitting) print(`  ${SENT_UNCONFIRMED_NOTE}`);
      print(`  已扣点数（服务端返回）合计 ${sumCredits(state.jobs.map((j) => j.credits))}；明细 ${join(state.outDir, state.costFile)}`);
      for (const job of state.jobs.filter((j) => j.status === "failed")) print(`  失败 ${job.sku} / ${job.slot}：${job.errorMessage}`);
      if (isUnfinishedState(state) || c.failed) print(`  接着跑：quriov batch resume ${state.batchId}${c.failed ? " [--retry-failed]" : ""}`);
      print("  （这是本机记录；要看服务端最新进度请运行 resume）");
      return 0;
    }

    if (sub === "resume") {
      const state = findState(rest[0] ?? ".", where);
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
      rememberBatch(state, where);
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
