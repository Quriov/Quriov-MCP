// 详情套图的命令：aplus modules / aplus run / aplus status / aplus jobs。
//
// 一张参考图 + 卖点 → 一组详情模块图。每个模块按所选型号的单张价各扣一次，出不来的模块不收费；
// 扣点、退款都在服务端，这里只做本机的事：先校验、估价、确认，再提交、等结果、下载、列清每个模块花了多少。
//
// 和别的提交不一样的一点：这个接口没有去重键，同样的内容再交一次 = 再建一个任务、再扣一次钱。
// 所以提交那一下绝不自动重试；没收到明确回应就按「结果不确定」报出来，让人先去任务列表里看。
// 和服务端说话仍然只经过 lib/transport.mjs 的 QuriovClient。

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { CliError, RETIRED_IMAGE_MODELS, creditsExceed, errorPayload, realSleep, safeName, sumCredits } from "./common.mjs";
import { IMAGE_EXTENSIONS, MAX_UPLOAD_BYTES } from "./transport.mjs";

export const MAX_APLUS_MODULES = 5; // 服务端单次上限
export const MAX_DESCRIPTION_CHARS = 8000;
// 详情套图只收这几个型号（和服务端一致）；不指定时用服务端的默认档。写错的在本机就拦下，不去估一个交不上的价。
export const APLUS_MODELS = Object.freeze(["gpt-image-2.5-1K", "gpt-image-2.5-2K", "gpt-image-2.5-4K"]);
export const APLUS_DEFAULT_MODEL = APLUS_MODELS[0];
// 尺码表模块必须带真实尺码数据：不带的话服务端会跳过它（不编造尺码），白占一个模块位。
const SIZE_CHART_MODULE = "aplus_size_chart";
const DEFAULT_POLL_SECONDS = 10;
const DEFAULT_TIMEOUT_MINUTES = 30;

const JOB_TERMINAL = new Set(["succeeded", "partial", "failed"]);
const JOB_STATUS_TEXT = Object.freeze({
  queued: "排队中",
  running: "生成中",
  succeeded: "成功",
  partial: "部分成功",
  failed: "失败",
});
const MODULE_STATUS_TEXT = Object.freeze({
  completed: "成功",
  failed: "失败",
  generating: "生成中",
  pending: "还没出",
  missing: "没有结果",
});

function intArg(value, name, { min, max, fallback }) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError("usage", `${name} 要是 ${min} 到 ${max} 之间的整数。`, { exitCode: 2 });
  return n;
}

function splitIds(value) {
  return String(value ?? "")
    .split(/[,;，；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 卖点文件：一行一条；或者整个文件是一个 JSON 字符串数组。
export function parsePointsText(text) {
  const input = String(text ?? "").replace(/^﻿/, "");
  if (input.trim().startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new Error("以 [ 开头但不是合法的 JSON 数组");
    }
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) throw new Error("JSON 里要是字符串数组");
    return parsed.map((s) => s.trim()).filter(Boolean);
  }
  return input
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 本机校验（不联网）：问题一次全报出来，有问题就什么都不发。
export function collectRunInput(args, rest = [], { statFn = statSync, readFile = readFileSync } = {}) {
  const errors = [];

  const moduleIds = [...splitIds(args.modules), ...rest.flatMap(splitIds)];
  if (!moduleIds.length) errors.push("没给模块。用 --modules 编号,编号…（quriov aplus modules 看能用的编号）。");
  else if (moduleIds.length > MAX_APLUS_MODULES) {
    errors.push(`一次最多 ${MAX_APLUS_MODULES} 个模块，这里给了 ${moduleIds.length} 个。请分成几次提交。`);
  }
  const repeated = [...new Set(moduleIds.filter((id, i) => moduleIds.indexOf(id) !== i))];
  if (repeated.length) errors.push(`模块重复了：${repeated.join("、")}。同一个模块一次只出一张。`);

  const refs = args.ref ?? [];
  let referencePath = null;
  if (refs.length !== 1) errors.push(`要正好 1 张参考图（--ref <图>），这里给了 ${refs.length} 张。`);
  else {
    referencePath = resolve(refs[0]);
    if (!IMAGE_EXTENSIONS[extname(referencePath).toLowerCase()]) errors.push(`参考图 ${refs[0]} 不是 JPG / PNG / WebP。`);
    else {
      let info = null;
      try {
        info = statFn(referencePath);
      } catch {
        errors.push(`找不到参考图 ${refs[0]}。`);
      }
      if (info && !info.isFile()) errors.push(`参考图 ${refs[0]} 不是文件。`);
      else if (info && info.size === 0) errors.push(`参考图 ${refs[0]} 是空文件。`);
      else if (info && info.size > MAX_UPLOAD_BYTES) {
        errors.push(`参考图 ${refs[0]} 有 ${(info.size / 1048576).toFixed(1)} MB，超过 10 MB 上限。`);
      }
    }
  }

  const sellingPoints = (args.point ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (args.pointsFile) {
    try {
      sellingPoints.push(...parsePointsText(readFile(resolve(args.pointsFile), "utf8")));
    } catch (error) {
      errors.push(
        error?.code === "ENOENT" || error?.code === "EISDIR" || error?.code === "EACCES"
          ? `读不到卖点文件 ${args.pointsFile}。`
          : `卖点文件 ${args.pointsFile} 看不懂：${error.message}。一行写一条卖点，或写成 JSON 字符串数组。`,
      );
    }
  }
  if (!sellingPoints.length) errors.push('没有卖点。用 --point "<一条卖点>"（可以写多次），或 --points-file <文件>（一行一条）。');

  const model = (args.model ?? "").trim() || APLUS_DEFAULT_MODEL;
  if (RETIRED_IMAGE_MODELS[model]) {
    errors.push(`型号 ${model}（Image 2）已停用，请改用同档的 ${RETIRED_IMAGE_MODELS[model]}。`);
  } else if (!APLUS_MODELS.includes(model)) {
    errors.push(`详情套图不能用型号 ${model}。能用的：${APLUS_MODELS.join("、")}（不写 -m 就是 ${APLUS_DEFAULT_MODEL}）。`);
  }

  const fields = {};
  const text = (name, value, max) => {
    if (value === undefined || value === null || !String(value).trim()) return;
    if (max && String(value).length > max) errors.push(`${name} 有 ${String(value).length} 字，超过 ${max} 字上限。`);
    else fields[name] = String(value);
  };
  text("product_description", args.prompt, MAX_DESCRIPTION_CHARS);
  text("style_description", args.style);
  text("headline", args.headline);
  text("subheadline", args.subheadline);
  text("category", args.category);

  let sizeChart = null;
  if (args.sizeChart) {
    try {
      sizeChart = JSON.parse(String(readFile(resolve(args.sizeChart), "utf8")).replace(/^﻿/, ""));
      if (!sizeChart || typeof sizeChart !== "object" || Array.isArray(sizeChart)) {
        sizeChart = null;
        errors.push(`尺码表 ${args.sizeChart} 要是一个 JSON 对象：{"headers": [...], "rows": [[...]], "unit": "cm"}。`);
      }
    } catch {
      errors.push(`尺码表 ${args.sizeChart} 读不到或不是合法的 JSON。`);
    }
  }
  if (moduleIds.includes(SIZE_CHART_MODULE) && !sizeChart) {
    errors.push(`模块 ${SIZE_CHART_MODULE} 要带真实尺码数据：加 --size-chart <尺码表.json>，否则服务端会跳过这个模块。`);
  }

  if (errors.length) {
    throw new CliError("invalid_spec", `有 ${errors.length} 处要改（没有提交，没有花钱）：\n${errors.map((e) => `  - ${e}`).join("\n")}`, {
      exitCode: 2,
    });
  }
  return { moduleIds, referencePath, sellingPoints, model, fields, sizeChart };
}

function renderPlan(input, names = new Map()) {
  const lines = [`详情套图计划：${input.moduleIds.length} 个模块，型号 ${input.model}，参考图 ${input.referencePath}，卖点 ${input.sellingPoints.length} 条。`];
  input.moduleIds.forEach((id, i) => lines.push(`  ${String(i + 1).padEnd(3)} ${id.padEnd(30)} ${names.get(id) ?? ""}`.trimEnd()));
  return lines.join("\n");
}

// 联网但免费：模块编号在不在、型号能不能用、估价、余额。
async function preflight(client, input) {
  const listed = (await client.aplusModules()).modules ?? [];
  const names = new Map(listed.map((m) => [m.id, m.name]));
  const unknown = input.moduleIds.filter((id) => !names.has(id));
  if (unknown.length) {
    throw new CliError(
      "unknown_module",
      `模块编号不存在：${unknown.join("、")}（没有提交，没有花钱）。能用的：${listed.map((m) => m.id).join("、") || "无"}。`,
      { exitCode: 2 },
    );
  }
  const caps = await client.capabilities();
  const model = (caps.models ?? []).find((m) => m.id === input.model);
  if (!model || !model.available || model.modality !== "image") {
    throw new CliError("unsupported_model", `型号 ${input.model} 现在不能出图（没有提交，没有花钱）。用 quriov models 看现在能用的。`, { exitCode: 2 });
  }
  const count = input.moduleIds.length;
  const total = String((await client.estimate({ modelId: input.model, pricingUnit: model.pricing_unit, units: count })).credits);
  const perModule = count === 1 ? total : String((await client.estimate({ modelId: input.model, pricingUnit: model.pricing_unit, units: 1 })).credits);
  const account = await client.account();
  return { names, estimate: { model: input.model, modules: count, credits_per_module: perModule, credits: total, balance: account.balance ?? null } };
}

function renderEstimate(estimate) {
  return [
    `  估价：${estimate.model} × ${estimate.modules} 个模块（每个 ${estimate.credits_per_module} 点）= ${estimate.credits} 点（服务端按这把钥匙所属账号估算）`,
    `  当前余额 ${estimate.balance ?? "未知"} 点。出不来的模块不收费，实扣看结果。`,
  ].join("\n");
}

// 提交结果不确定（断网 / 超时 / 服务端 5xx）：可能已经收下并开始扣点，也可能没有。
function submitUnknownError(error) {
  return new CliError(
    "submit_unknown",
    [
      `提交结果不确定：${error.message}`,
      "服务端可能已经收下这个任务，也可能没有。没有自动重交（这个接口不去重，再交一次会再扣一次钱）。",
      "先运行 quriov aplus jobs 看最近的任务：有这一条就用 quriov aplus status <任务编号> --wait --download <目录> 接着等；确认没有再重新提交。",
    ].join("\n"),
    { exitCode: 4, requestId: error.requestId ?? null, httpStatus: error.httpStatus ?? null },
  );
}

async function waitForJob(client, jobId, { pollSeconds, timeoutMinutes, sleep = realSleep, now = Date.now, log = () => {}, shouldStop = () => false }) {
  const deadline = now() + timeoutMinutes * 60_000;
  let job = await client.aplusJob(jobId);
  while (!JOB_TERMINAL.has(job.status)) {
    if (shouldStop()) return { job, stopped: true, timedOut: false };
    if (now() >= deadline) return { job, stopped: false, timedOut: true };
    const finished = (job.completed_modules ?? 0) + (job.failed_modules ?? 0);
    log(`  ${JOB_STATUS_TEXT[job.status] ?? job.status}：${finished}/${job.total_modules ?? "?"} 个模块有结果；${pollSeconds} 秒后再查…`);
    await sleep(pollSeconds * 1000);
    if (shouldStop()) return { job, stopped: true, timedOut: false };
    job = await client.aplusJob(jobId);
  }
  return { job, stopped: false, timedOut: false };
}

// 把服务端的任务整理成「按顺序的一行一个模块」。expected：提交时给的模块顺序（run 才有）；
// 任务结束了却没有结果的模块也列出来，不让它悄悄消失。
export function moduleRows(job, expected = null) {
  const results = [...(job.module_results ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const done = JOB_TERMINAL.has(job.status);
  const row = (r, seq, moduleId) => ({
    seq,
    module_id: moduleId,
    status: r ? r.status : done ? "missing" : "pending",
    credits: r && r.cost_credits !== null && r.cost_credits !== undefined ? String(r.cost_credits) : null,
    image_url: r?.image_url ?? null,
    failure_reason: r?.failure_reason ?? (!r && done ? (job.error_reason ?? "服务端没有返回这个模块的结果") : null),
    file: null,
    download: null,
  });
  if (!expected) return results.map((r, i) => row(r, r.seq ?? i, r.module_id));
  return expected.map((moduleId, seq) => row(results.find((r) => r.seq === seq) ?? results.find((r) => r.module_id === moduleId) ?? null, seq, moduleId));
}

function extensionOf(url) {
  try {
    const ext = extname(new URL(url).pathname).toLowerCase();
    if (IMAGE_EXTENSIONS[ext]) return ext === ".jpeg" ? ".jpg" : ext;
  } catch {
    // 用默认
  }
  return ".png";
}

// 文件名带顺序：<目录>/<两位序号>-<模块编号>.<扩展名>。已存在的不重下。
async function downloadRows(client, rows, dir, { log = () => {} } = {}) {
  const root = resolve(dir);
  for (const r of rows) {
    if (r.status !== "completed" || typeof r.image_url !== "string") continue;
    const target = join(root, `${String(r.seq + 1).padStart(2, "0")}-${safeName(r.module_id)}${extensionOf(r.image_url)}`);
    r.file = target;
    if (existsSync(target)) {
      r.download = "exists";
      continue;
    }
    try {
      await client.download(r.image_url, target);
      r.download = "downloaded";
      log(`  已下载 ${target}`);
    } catch (error) {
      r.download = "failed";
      r.download_reason = error.message;
      log(`  下载失败 ${target}：${error.message}`);
    }
  }
  return rows;
}

function summarize(job, rows, { model = null, outDir = null } = {}) {
  const ok = rows.filter((r) => r.status === "completed");
  const failed = rows.filter((r) => r.status === "failed" || r.status === "missing");
  return {
    job_id: job.id,
    status: job.status,
    model_id: model,
    out_dir: outDir,
    total_modules: job.total_modules ?? rows.length,
    succeeded_modules: ok.map((r) => r.module_id),
    failed_modules: failed.map((r) => r.module_id),
    total_credits: sumCredits(rows.map((r) => r.credits)),
    error_reason: job.error_reason ?? null,
    modules: rows,
  };
}

function renderResult(summary) {
  const lines = [];
  const counts = `成功 ${summary.succeeded_modules.length} / 失败 ${summary.failed_modules.length}，共 ${summary.total_modules} 个模块`;
  lines.push(`任务 ${summary.job_id}：${JOB_STATUS_TEXT[summary.status] ?? summary.status}（${counts}）${summary.model_id ? `，型号 ${summary.model_id}` : ""}`);
  for (const r of summary.modules) {
    const parts = [`  ${String(r.seq + 1).padEnd(3)}${r.module_id.padEnd(30)}`, MODULE_STATUS_TEXT[r.status] ?? r.status];
    if (r.credits !== null) parts.push(`${r.credits} 点`);
    if (r.file && r.download !== "failed") parts.push(`→ ${r.file}`);
    if (r.download === "failed") parts.push(`图已出但下载失败：${r.download_reason}`);
    if (r.failure_reason) parts.push(`原因：${r.failure_reason}`);
    lines.push(parts.join("  "));
  }
  if (summary.error_reason) lines.push(`  任务报错：${summary.error_reason}`);
  lines.push(`合计实扣 ${summary.total_credits} 点（服务端返回；只有出了图的模块收费）。`);
  if (summary.failed_modules.length) {
    lines.push(`失败的模块：${summary.failed_modules.join("、")}。要重出就只带这几个模块重新提交一次（会再花钱，先估价）。`);
  }
  return lines.join("\n");
}

function exitCodeFor(summary, { stopped = false, timedOut = false } = {}) {
  if (stopped || timedOut) return 4;
  if (!JOB_TERMINAL.has(summary.status)) return 0; // 还在跑（没让等）
  if (summary.status !== "succeeded" || summary.failed_modules.length) return 3;
  if (summary.modules.some((r) => r.download === "failed")) return 3;
  return 0;
}

async function finish(client, job, { expected = null, model = null, download = null, args, print, log, outcome = {} }) {
  const rows = moduleRows(job, expected);
  if (download && JOB_TERMINAL.has(job.status)) await downloadRows(client, rows, download, { log });
  const summary = summarize(job, rows, { model, outDir: download ? resolve(download) : null });
  const waitHint = `quriov aplus status ${job.id} --wait --download ${download ?? "./out"}`;
  if (args.json) print(JSON.stringify({ ...summary, stopped: Boolean(outcome.stopped), timed_out: Boolean(outcome.timedOut) }));
  else {
    print(renderResult(summary));
    if (outcome.timedOut) print(`等了 ${outcome.timeoutMinutes} 分钟还没结束（任务还在服务端跑，不要重新提交）。接着等：${waitHint}`);
    else if (outcome.stopped) print(`已停止等待（任务还在服务端跑，不要重新提交）。接着等：${waitHint}`);
    else if (!JOB_TERMINAL.has(job.status)) print(`还没结束。等它结束并下载：${waitHint}`);
    else if (summary.modules.some((r) => r.download === "failed")) print(`有图下载失败，重跑这条会补下：${waitHint}`);
  }
  return exitCodeFor(summary, outcome);
}

export async function aplusCommand(sub, rest, args, ctx) {
  const { makeClient, print, log, stdin, confirm, sleep, now, shouldStop } = ctx;
  const waitOptions = () => ({
    pollSeconds: intArg(args.pollSeconds, "--poll-seconds", { min: 5, max: 300, fallback: DEFAULT_POLL_SECONDS }),
    timeoutMinutes: intArg(args.timeout, "--timeout", { min: 1, max: 24 * 60, fallback: DEFAULT_TIMEOUT_MINUTES }),
    sleep,
    now,
    log,
    shouldStop,
  });

  if (sub === "modules") {
    const modules = (await makeClient().aplusModules()).modules ?? [];
    if (args.json) {
      print(JSON.stringify({ modules }));
      return 0;
    }
    print(`详情套图模块（quriov aplus run --modules 填这里的编号，一次最多 ${MAX_APLUS_MODULES} 个）：`);
    for (const m of modules) print(`  ${String(m.id).padEnd(30)} ${String(m.aspect_ratio ?? "").padEnd(6)} ${m.name}  ${m.description ?? ""}`.trimEnd());
    return 0;
  }

  if (sub === "run") {
    const input = collectRunInput(args, rest); // 本机校验先于任何联网
    const outDir = resolve(args.out ?? "quriov-out");
    if (args.dryRun) {
      if (args.json) print(JSON.stringify({ plan: { ...input, out_dir: outDir } }));
      else {
        print(renderPlan(input));
        print(`（--dry-run：没有联网，没有提交，没有花钱。模块编号在不在要联网才知道：加 --estimate 联网估价，免费）`);
      }
      return 0;
    }
    const wait = waitOptions();
    const client = makeClient();
    const { names, estimate } = await preflight(client, input);
    if (args.estimate) {
      if (args.json) print(JSON.stringify({ estimate, plan: { ...input, out_dir: outDir } }));
      else {
        print(renderPlan(input, names));
        print(renderEstimate(estimate));
        print("（只估价：没有提交，没有花钱）");
      }
      return 0;
    }
    if (estimate.balance !== null && creditsExceed(estimate.credits, estimate.balance)) {
      throw new CliError(
        "insufficient_credits",
        `余额不够：这次约 ${estimate.credits} 点，余额 ${estimate.balance} 点。没有提交；充值后再运行同一条命令。`,
        { exitCode: 4, details: { required: estimate.credits, available: estimate.balance } },
      );
    }
    if (!args.json) {
      print(renderPlan(input, names));
      print(renderEstimate(estimate));
    }
    if (!args.yes) {
      if (!stdin?.isTTY) {
        throw new CliError("needs_confirmation", "这一步要花钱，需要确认。先用 --estimate 看估价，确认后再加 --yes。", { exitCode: 2 });
      }
      if (!(await confirm(`确认出 ${estimate.modules} 个详情模块、约 ${estimate.credits} 点？`))) {
        print("没有提交。");
        return 1;
      }
    }

    let created;
    try {
      created = await client.aplusSubmit({
        moduleIds: input.moduleIds,
        referencePath: input.referencePath,
        sellingPoints: input.sellingPoints,
        modelId: input.model,
        fields: input.fields,
        sizeChart: input.sizeChart,
      });
    } catch (error) {
      if (error instanceof CliError && (error.code === "network_error" || (error.httpStatus ?? 0) >= 500)) throw submitUnknownError(error);
      throw error;
    }
    const jobId = created.job_id;
    if (typeof jobId !== "string" || !jobId) {
      throw submitUnknownError(new CliError("invalid_response", "服务端的回应里没有任务编号。"));
    }
    // 任务编号第一时间说出来：后面等结果时断了，凭它就能接着查，不用重交。
    (args.json ? log : print)(`任务编号 ${jobId}（已提交；断了用 quriov aplus status ${jobId} --wait --download ${args.out ?? "./quriov-out"} 接着等，不要重新提交）`);
    if (created.notice) log(`提示：${created.notice}`);

    if (args.noWait) {
      const out = { job_id: jobId, status: created.status ?? "queued", model_id: created.model_id ?? input.model, total_modules: created.total_modules ?? input.moduleIds.length, modules: input.moduleIds, estimate };
      if (args.json) print(JSON.stringify(out));
      else print(`没有等结果（--no-wait）。等它结束并下载：quriov aplus status ${jobId} --wait --download ${args.out ?? "./quriov-out"}`);
      return 0;
    }

    let outcome;
    try {
      outcome = await waitForJob(client, jobId, wait);
    } catch (error) {
      if (error instanceof CliError) {
        error.message = `${error.message}\n任务 ${jobId} 已经提交，还在服务端跑：不要重新提交（会重复扣钱）。稍后接着等：quriov aplus status ${jobId} --wait --download ${args.out ?? "./quriov-out"}`;
        error.exitCode = 4;
        if (args.json) {
          print(JSON.stringify({ job_id: jobId, ...errorPayload(error) }));
          error.jsonPrinted = true;
        }
      }
      throw error;
    }
    return finish(client, outcome.job, {
      expected: input.moduleIds,
      model: created.model_id ?? input.model,
      download: outDir,
      args,
      print,
      log,
      outcome: { ...outcome, timeoutMinutes: wait.timeoutMinutes },
    });
  }

  if (sub === "status") {
    const jobId = rest[0];
    if (!jobId) throw new CliError("usage", "用法：quriov aplus status <任务编号> [--wait] [--download 目录]", { exitCode: 2 });
    const wait = waitOptions();
    const client = makeClient();
    const outcome = args.wait ? await waitForJob(client, jobId, wait) : { job: await client.aplusJob(jobId), stopped: false, timedOut: false };
    return finish(client, outcome.job, { download: args.download ?? null, args, print, log, outcome: { ...outcome, timeoutMinutes: wait.timeoutMinutes } });
  }

  if (sub === "jobs") {
    const limit = intArg(args.limit, "--limit", { min: 1, max: 100, fallback: 20 });
    const page = await makeClient().aplusJobs({ limit, cursor: args.cursor });
    const jobs = page.jobs ?? [];
    if (args.json) {
      print(JSON.stringify({ jobs, next_cursor: page.next_cursor ?? null }));
      return 0;
    }
    if (!jobs.length) print("（最近 7 天没有详情套图任务）");
    for (const job of jobs) {
      const rows = moduleRows(job);
      const parts = [`  ${job.id}`, JOB_STATUS_TEXT[job.status] ?? job.status, `模块 ${job.completed_modules ?? 0}/${job.total_modules ?? "?"}${job.failed_modules ? `（失败 ${job.failed_modules}）` : ""}`];
      parts.push(`实扣 ${sumCredits(rows.map((r) => r.credits))} 点`);
      if (job.created_at) parts.push(`提交于 ${job.created_at}`);
      if (rows.length) parts.push(rows.map((r) => r.module_id).join(","));
      print(parts.join("  "));
    }
    if (page.next_cursor) print(`还有更早的：加 --cursor '${page.next_cursor}' 接着翻。`);
    return 0;
  }

  throw new CliError("usage", "aplus 后面要跟 modules / run / status / jobs。运行 quriov --help 看用法。", { exitCode: 2 });
}
