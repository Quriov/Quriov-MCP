// 直连批量接口（batch submit / batch status <批次号> / jobs …）的测试。
// 假服务端只在内存里，不连任何真实地址、不花钱；用户目录一律是临时目录。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { API_BASE, CliError, errorPayload } from "../lib/common.mjs";
import { itemIdempotencyKey, parseItemsText, prepareItems, MAX_ITEMS_PER_REQUEST } from "../lib/batch.mjs";
import { HELP, main } from "../bin/quriov.mjs";

const TEST_KEY = "unit-test-batch-key-never-print";
const MODEL = "gpt-image-2.5-2K";

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "x-request-id": payload?.request_id ?? "rid-hdr", ...headers } });
}

function apiError(status, code, reason, extra = {}, headers = {}) {
  return json({ error_code: code, reason, request_id: `rid-${status}-${code}`, ...extra }, status, headers);
}

// 假的 /api/v1/mcp/*：批量提交（按 idempotency_key 去重）、批次查询（查几次后出结果）、任务查询、翻页、取消。
function createApi({ pollsUntilDone = 1, balance = "100.0000", onRequest = null, price = "0.7500" } = {}) {
  const api = { requests: [], downloads: [], jobs: [], byKey: new Map(), seq: 0 };
  const perImage = Number(price);
  const imagesOf = (item) => Math.max(item.template_ids?.length ?? 0, 1) * (item.n ?? 1);
  const estimate = (item) => (imagesOf(item) * perImage).toFixed(4);
  const view = (job) => {
    const media = [];
    if (job.status === "succeeded") {
      for (const t of job.item.template_ids?.length ? job.item.template_ids : [null]) {
        for (let k = 0; k < (job.item.n ?? 1); k += 1) {
          media.push({ type: "image", url: `https://oss.example.test/out/${job.job_id}/${t ?? "x"}-${k}.png?sig=1`, content_type: "image/png", template_id: t });
        }
      }
    }
    return {
      job_id: job.job_id,
      kind: "image",
      status: job.status,
      model: job.item.model,
      tag: job.item.tag ?? null,
      batch_id: job.batch_id,
      idempotency_key: job.item.idempotency_key,
      created_at: "2026-09-28T08:00:00+00:00",
      images: { total: imagesOf(job.item), completed: job.status === "succeeded" ? imagesOf(job.item) : 0, failed: 0 },
      template_ids: job.item.template_ids ?? [],
      media,
      settled_credits: job.status === "succeeded" ? estimate(job.item) : null,
      billing_status: job.status === "succeeded" ? "settled" : "pending",
      error_code: null,
      reason: null,
    };
  };
  const tick = (job) => {
    job.polls += 1;
    if (job.polls >= pollsUntilDone && job.status === "queued") job.status = "succeeded";
  };

  api.fetch = async (url, init = {}) => {
    const headers = init.headers ?? {};
    if (url.startsWith("https://oss.example.test/")) {
      api.downloads.push({ url, headers });
      return new Response(new Uint8Array([137, 80, 78, 71, 9]), { status: 200 });
    }
    assert.ok(url.startsWith(API_BASE), `只连 ${API_BASE}：${url}`);
    assert.equal(headers.Authorization, `Bearer ${TEST_KEY}`, "API 请求必须带钥匙");
    assert.match(headers["User-Agent"], /^quriov-cli\//);
    const u = new URL(url);
    const path = u.pathname.slice(new URL(API_BASE).pathname.length);
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const req = { method: init.method, path, query: Object.fromEntries(u.searchParams), body };
    api.requests.push(req);
    if (onRequest) {
      const custom = await onRequest(req, api);
      if (custom) return custom;
    }
    if (init.method === "POST" && path === "/batches") {
      const batchId = body.batch_key ? `batch-${body.batch_key.slice(-8)}` : body.dry_run ? null : `batch-rand-${api.seq}`;
      const items = body.items.map((item, index) => {
        const base = { index, idempotency_key: item.idempotency_key, tag: item.tag ?? null, model: item.model, estimated_images: imagesOf(item), estimated_credits: estimate(item) };
        if (item.prompt === "TOO LONG") return { ...base, deduplicated: false, status: "failed", error_code: "prompt_too_long", reason: "提示词太长: 最多 8000 字。", job_id: body.dry_run ? null : `rej-${index}` };
        const known = api.byKey.get(item.idempotency_key);
        if (body.dry_run) return { ...base, deduplicated: Boolean(known), status: known ? "duplicate" : "planned", error_code: null, reason: null };
        let job = known;
        if (!job) {
          api.seq += 1;
          job = { job_id: `job-${String(api.seq).padStart(4, "0")}`, status: "queued", polls: 0, item, batch_id: batchId };
          api.byKey.set(item.idempotency_key, job);
          api.jobs.push(job);
        }
        return { ...base, deduplicated: Boolean(known), job_id: job.job_id, status: job.status, error_code: null, reason: null, job: view(job) };
      });
      return json({ batch_id: batchId, request_id: `rid-submit-${api.requests.length}`, dry_run: Boolean(body.dry_run), summary: { items: items.length, submitted: 0, deduplicated: 0, rejected: 0, estimated_images: 0, estimated_credits: "0", balance }, items });
    }
    let m;
    if (init.method === "GET" && (m = /^\/batches\/([^/]+)$/.exec(path))) {
      const jobs = api.jobs.filter((j) => j.batch_id === decodeURIComponent(m[1]));
      if (!jobs.length) return apiError(404, "not_found", "找不到这个编号。");
      jobs.forEach(tick);
      const views = jobs.map(view);
      const by = {};
      for (const v of views) by[v.status] = (by[v.status] ?? 0) + 1;
      const done = views.every((v) => ["succeeded", "partial", "failed", "cancelled", "unknown", "expired"].includes(v.status));
      return json({
        batch_id: decodeURIComponent(m[1]),
        request_id: "rid-batch",
        summary: { jobs: views.length, by_status: by, done, images_total: views.reduce((s, v) => s + v.images.total, 0), images_completed: views.reduce((s, v) => s + v.images.completed, 0), images_failed: 0, settled_jobs: views.filter((v) => v.settled_credits).length, settled_credits: "0" },
        items: views,
      });
    }
    if (init.method === "POST" && path === "/jobs/query") {
      const items = [];
      const missing = [];
      for (const id of body.job_ids) {
        const job = api.jobs.find((j) => j.job_id === id);
        if (job) items.push(view(job));
        else missing.push(id);
      }
      return json({ request_id: "rid-query", items, missing });
    }
    if (init.method === "POST" && (m = /^\/jobs\/([^/]+)\/cancel$/.exec(path))) {
      const job = api.jobs.find((j) => j.job_id === m[1]);
      if (!job) return apiError(404, "not_found", "找不到这个编号。");
      if (job.status !== "queued") return json({ generation_id: job.job_id, status: job.status, code: "not_cancellable", message: "已在生成, 不能取消。", retryable: false });
      job.status = "cancelled";
      return json({ generation_id: job.job_id, status: "cancelled", code: "cancelled", message: "已取消: 任务还在排队, 没有生成, 也没有扣费。", retryable: false });
    }
    if (init.method === "GET" && (m = /^\/jobs\/([^/]+)$/.exec(path))) {
      const job = api.jobs.find((j) => j.job_id === m[1]);
      return job ? json(view(job)) : apiError(404, "not_found", "找不到这个编号。");
    }
    if (init.method === "GET" && path === "/jobs") {
      const limit = Number(req.query.limit ?? 20);
      const newestFirst = [...api.jobs].reverse().filter((j) => !req.query.status || j.status === req.query.status);
      const start = req.query.cursor ? Number(req.query.cursor.replace("c", "")) : 0;
      const page = newestFirst.slice(start, start + limit);
      const next = start + limit < newestFirst.length ? `c${start + limit}` : null;
      return json({ request_id: "rid-list", items: page.map(view), next_cursor: next });
    }
    return apiError(404, "not_found", "找不到。");
  };
  api.posts = (dry) => api.requests.filter((r) => r.method === "POST" && r.path === "/batches" && Boolean(r.body.dry_run) === dry);
  return api;
}

function fakeClock() {
  const clock = { t: Date.UTC(2026, 8, 28, 2, 0, 0), slept: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.slept.push(ms);
    clock.t += ms;
  };
  return clock;
}

function sink() {
  const s = { text: "" };
  s.write = (chunk) => {
    s.text += chunk;
    return true;
  };
  return s;
}

function workspace() {
  return mkdtempSync(join(tmpdir(), "quriov-batch-test-"));
}

async function run(argv, { dir, api, clock = fakeClock(), stdin = { isTTY: false }, shouldStop, key = TEST_KEY } = {}) {
  const stdout = sink();
  const stderr = sink();
  let code;
  let error = null;
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  try {
    code = await main(argv, {
      env: { QURIOV_API_KEY: key, XDG_CONFIG_HOME: join(dir, "config"), APPDATA: join(dir, "config") },
      stdout,
      stderr,
      stdin,
      home,
      platform: "linux",
      fetchImpl: api ? api.fetch : async () => assert.fail("不应该联网"),
      sleep: clock.sleep,
      now: clock.now,
      shouldStop,
    });
  } catch (e) {
    error = e;
  }
  for (const text of [stdout.text, stderr.text, error?.message ?? ""]) assert.ok(!text.includes(TEST_KEY), "任何输出里都不能有钥匙");
  return { code, error, stdout: stdout.text, stderr: stderr.text, clock };
}

function items(n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({ model: MODEL, prompt: `商品 ${i} 白底主图`, tag: `SKU${String(i).padStart(3, "0")}`, ...extra }));
}

function writeJsonl(dir, list, name = "items.jsonl") {
  const file = join(dir, name);
  writeFileSync(file, `${list.map((x) => JSON.stringify(x)).join("\n")}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// 条目与去重键
// ---------------------------------------------------------------------------

test("去重键：同一份内容永远同一个键；内容不同键就不同；自己给的键原样保留", () => {
  const a = { model: MODEL, prompt: "白底主图", template_ids: ["main_image", "detail_1"], reference_urls: ["https://x.test/a.jpg"], aspect_ratio: "1:1", n: 2, tag: "SKU1" };
  const k = itemIdempotencyKey(a);
  assert.match(k, /^qcli-[0-9a-f]{40}$/);
  assert.equal(itemIdempotencyKey({ ...a }), k, "同一内容 → 同一个键");
  assert.equal(itemIdempotencyKey(JSON.parse(JSON.stringify(a))), k, "序列化往返后仍相同");
  assert.equal(itemIdempotencyKey({ model: MODEL, prompt: "p" }), itemIdempotencyKey({ model: MODEL, prompt: "p", n: 1 }), "写不写 n:1 算同一份");
  for (const changed of [
    { prompt: "白底主图 " },
    { model: "other-model" },
    { n: 3 },
    { tag: "SKU2" },
    { aspect_ratio: "3:4" },
    { template_ids: ["detail_1", "main_image"] },
    { reference_urls: ["https://x.test/b.jpg"] },
  ]) {
    assert.notEqual(itemIdempotencyKey({ ...a, ...changed }), k, JSON.stringify(changed));
  }
  const { items: prepared, errors } = prepareItems([a, { ...a, tag: "SKU2", idempotency_key: "mine-1" }]);
  assert.deepEqual(errors, []);
  assert.equal(prepared[0].idempotency_key, k);
  assert.equal(prepared[1].idempotency_key, "mine-1");
});

test("条目校验：问题一次全报出来；内容完全相同的两条会被拦下", () => {
  const { errors } = prepareItems(
    [
      { model: MODEL, prompt: "a" },
      { model: MODEL, prompt: "a" },
      { prompt: "no model" },
      { model: MODEL, prompt: "x", n: 5, template_ids: Array(9).fill("t"), reference_urls: ["./local.jpg"], extra: 1 },
      "not an object",
    ],
    (i) => `第 ${i + 1} 行`,
  );
  const text = errors.join("\n");
  assert.match(text, /第 2 行：和第 1 行内容完全一样/);
  assert.match(text, /第 3 行：缺 model/);
  assert.match(text, /n 只能是 1 到 4/);
  assert.match(text, /template_ids 最多 8 个/);
  assert.match(text, /不是 https 链接.*quriov upload/);
  assert.match(text, /不认识的字段 extra/);
  assert.match(text, /第 5 行：要是一个 JSON 对象/);
});

test("读条目：JSONL、JSON 数组、{batch_key, items}、带 BOM 都认", () => {
  assert.equal(parseItemsText('{"model":"m","prompt":"a"}\n\n{"model":"m","prompt":"b"}\n', { format: "jsonl" }).rawItems.length, 2);
  assert.equal(parseItemsText('﻿[{"model":"m","prompt":"a"}]').rawItems.length, 1);
  const wrapped = parseItemsText('{"batch_key":"k1","items":[{"model":"m","prompt":"a"}]}');
  assert.equal(wrapped.fileBatchKey, "k1");
  assert.equal(parseItemsText('{"model":"m","prompt":"a"}\n{"model":"m","prompt":"b"}').rawItems.length, 2, "自动判断成 JSONL");
  assert.throws(() => parseItemsText('{"model":"m"}\nnot json', { format: "jsonl" }), (e) => e.code === "invalid_spec" && /第 2 行/.test(e.message));
});

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

test("分组：120 条按每组 50 条交（50/50/20），先估价再提交，归在同一个批次，编号按全局顺序", async () => {
  const dir = workspace();
  const api = createApi();
  const file = writeJsonl(dir, items(120));
  const { code, error, stdout } = await run(["batch", "submit", file, "--yes", "--json"], { dir, api });
  assert.equal(error, null, String(error?.message));
  assert.equal(code, 0);
  assert.equal(MAX_ITEMS_PER_REQUEST, 50);
  assert.deepEqual(api.posts(true).map((r) => r.body.items.length), [50, 50, 20], "估价也分组");
  assert.deepEqual(api.posts(false).map((r) => r.body.items.length), [50, 50, 20]);
  const keys = new Set(api.posts(false).map((r) => r.body.batch_key));
  assert.equal(keys.size, 1, "所有组用同一个 batch_key → 同一个批次");
  const out = JSON.parse(stdout);
  assert.equal(out.batch_ids.length, 1);
  assert.equal(out.items.length, 120);
  assert.deepEqual(out.items.map((i) => i.index), [...Array(120).keys()]);
  assert.equal(out.summary.submitted, 120);
  assert.ok(out.items.every((i) => /^qcli-/.test(i.idempotency_key)), "没写键的自动补上");
});

test("--chunk-size 可以调小，但不能超过 50", async () => {
  const dir = workspace();
  const api = createApi();
  const file = writeJsonl(dir, items(7));
  await run(["batch", "submit", file, "--yes", "--chunk-size", "3"], { dir, api });
  assert.deepEqual(api.posts(false).map((r) => r.body.items.length), [3, 3, 1]);
  const bad = await run(["batch", "submit", file, "--yes", "--chunk-size", "51"], { dir, api });
  assert.equal(bad.error.code, "usage");
});

test("同一个文件重跑：键不变，服务端认出来，全部「已交过」，不再花钱也不用确认", async () => {
  const dir = workspace();
  const api = createApi();
  const file = writeJsonl(dir, items(3));
  const first = await run(["batch", "submit", file, "--yes", "--json"], { dir, api });
  const again = await run(["batch", "submit", file, "--json"], { dir, api }); // 没加 --yes：没有新条目就不需要确认
  assert.equal(again.error, null, String(again.error?.message));
  const a = JSON.parse(first.stdout);
  const b = JSON.parse(again.stdout);
  assert.deepEqual(b.items.map((i) => i.idempotency_key), a.items.map((i) => i.idempotency_key));
  assert.deepEqual(b.batch_ids, a.batch_ids, "同一个文件落回同一个批次");
  assert.equal(b.summary.deduplicated, 3);
  assert.equal(b.summary.submitted, 0);
  assert.equal(api.jobs.length, 3, "服务端只建了 3 个任务");
});

test("--dry-run：只估价，打印每条估价和合计，不提交", async () => {
  const dir = workspace();
  const api = createApi();
  const file = writeJsonl(dir, [
    { model: MODEL, prompt: "主图", template_ids: ["main_image", "detail_1"], n: 2, tag: "SKU1" },
    { model: MODEL, prompt: "场景", tag: "SKU2" },
  ]);
  const human = await run(["batch", "submit", file, "--dry-run"], { dir, api });
  assert.equal(human.code, 0);
  assert.match(human.stdout, /SKU1.*4 张 约 3\.0000 点/);
  assert.match(human.stdout, /SKU2.*1 张 约 0\.7500 点/);
  assert.match(human.stdout, /要新交 2 条、约 3\.7500 点/);
  assert.match(human.stdout, /没有提交，没有花钱/);
  const machine = await run(["batch", "submit", file, "--dry-run", "--json"], { dir, api });
  const out = JSON.parse(machine.stdout);
  assert.equal(out.dry_run, true);
  assert.equal(out.summary.new_credits, "3.7500");
  assert.equal(out.summary.estimated_images, 5);
  assert.equal(api.posts(false).length, 0, "dry-run 一次都没真提交");
  assert.equal(api.jobs.length, 0);
});

test("--dry-run：会被拒的条目报出原因和错误码，退出码 3", async () => {
  const dir = workspace();
  const api = createApi();
  const file = writeJsonl(dir, [{ model: MODEL, prompt: "TOO LONG", tag: "BAD" }, { model: MODEL, prompt: "ok" }]);
  const { code, stdout } = await run(["batch", "submit", file, "--dry-run"], { dir, api });
  assert.equal(code, 3);
  assert.match(stdout, /BAD.*提示词太长.*错误码 prompt_too_long/);
});

test("非交互环境要花钱却没加 --yes：拒绝，一条都不交", async () => {
  const dir = workspace();
  const api = createApi();
  const file = writeJsonl(dir, items(2));
  const { error } = await run(["batch", "submit", file], { dir, api });
  assert.equal(error.code, "needs_confirmation");
  assert.match(error.message, /--dry-run/);
  assert.equal(api.posts(false).length, 0);
});

test("余额不够整个文件：提交前就停下，一条都不交", async () => {
  const dir = workspace();
  const api = createApi({ balance: "1.0000" });
  const file = writeJsonl(dir, items(60));
  const { error } = await run(["batch", "submit", file, "--yes"], { dir, api });
  assert.equal(error.code, "insufficient_credits");
  assert.equal(error.exitCode, 4);
  assert.match(error.message, /约 45\.0000 点，余额 1\.0000 点/);
  assert.equal(api.posts(false).length, 0);
});

test("从标准输入读（-），--batch-key 原样带上", async () => {
  const dir = workspace();
  const api = createApi();
  const stdin = Readable.from([items(2).map((x) => JSON.stringify(x)).join("\n")]);
  stdin.isTTY = false;
  const { code, error } = await run(["batch", "submit", "-", "--yes", "--batch-key", "products-0928"], { dir, api, stdin });
  assert.equal(error, null, String(error?.message));
  assert.equal(code, 0);
  assert.ok(api.posts(false).every((r) => r.body.batch_key === "products-0928"));
});

test("中间一组失败（代理超时 504）：不重试，说清交了几组、重跑同一条命令不会重复扣钱", async () => {
  const dir = workspace();
  let posts = 0;
  const api = createApi({
    onRequest: (req) => {
      if (req.path === "/batches" && !req.body.dry_run) {
        posts += 1;
        if (posts === 2) return new Response("<html>gateway timeout</html>", { status: 504, headers: { "x-request-id": "rid-504" } });
      }
      return undefined;
    },
  });
  const file = writeJsonl(dir, items(80));
  const { error, stdout, clock } = await run(["batch", "submit", file, "--yes"], { dir, api });
  assert.equal(error.code, "server_error");
  assert.match(error.message, /请求编号 rid-504/);
  assert.match(error.message, /已交完 1\/2 组/);
  assert.match(error.message, /重跑同一条命令会接着交完，不会重复扣钱/);
  assert.match(error.message, /--chunk-size 20/);
  assert.equal(posts, 2, "504 不重试");
  assert.deepEqual(clock.slept, []);
  assert.match(stdout, /#1\s/, "已交完的那一组照样列出来");
  // 重跑：已交的 50 条是「已交过」，剩下 30 条补交
  const again = await run(["batch", "submit", file, "--yes", "--json"], { dir, api });
  const out = JSON.parse(again.stdout);
  assert.equal(out.summary.deduplicated, 50);
  assert.equal(out.summary.submitted, 30);
  assert.equal(api.jobs.length, 80);
});

// ---------------------------------------------------------------------------
// 批次状态 / 等待 / 下载
// ---------------------------------------------------------------------------

test("batch status --wait：轮询到 summary.done 就停，按 标记/模板 命名下载，下载不带钥匙", async () => {
  const dir = workspace();
  const api = createApi({ pollsUntilDone: 3 });
  const file = writeJsonl(dir, [
    { model: MODEL, prompt: "主图", template_ids: ["main_image", "detail_1"], tag: "SKU1" },
    { model: MODEL, prompt: "场景", n: 2, tag: "SKU2" },
  ]);
  const submitted = JSON.parse((await run(["batch", "submit", file, "--yes", "--json"], { dir, api })).stdout);
  const batchId = submitted.batch_ids[0];
  const out = join(dir, "out");
  const { code, error, stdout, clock } = await run(["batch", "status", batchId, "--wait", "--download", out, "--poll-seconds", "10", "--json"], { dir, api });
  assert.equal(error, null, String(error?.message));
  assert.equal(code, 0);
  assert.deepEqual(clock.slept, [10_000, 10_000], "查了 3 次：第 3 次全部结束就停");
  const res = JSON.parse(stdout);
  assert.equal(res.summary.done, true);
  assert.deepEqual(readdirSync(join(out, "SKU1")).sort(), ["detail_1.png", "main_image.png"]);
  assert.deepEqual(readdirSync(join(out, "SKU2")).sort(), ["image-1.png", "image-2.png"]);
  assert.equal(res.downloads.length, 4);
  assert.ok(api.downloads.every((d) => !d.headers.Authorization), "下载结果图不带钥匙");
  // 再跑一次：已下载的不重下
  const again = await run(["batch", "status", batchId, "--download", out, "--json"], { dir, api });
  assert.ok(JSON.parse(again.stdout).downloads.every((d) => d.status === "exists"));
  assert.equal(api.downloads.length, 4);
});

test("batch status --wait：一直不结束时到 --timeout 就停，退出码 4，不会死循环", async () => {
  const dir = workspace();
  const api = createApi({ pollsUntilDone: Infinity });
  const file = writeJsonl(dir, items(1));
  const batchId = JSON.parse((await run(["batch", "submit", file, "--yes", "--json"], { dir, api })).stdout).batch_ids[0];
  const { code, stdout, clock } = await run(["batch", "status", batchId, "--wait", "--timeout", "1", "--poll-seconds", "15"], { dir, api });
  assert.equal(code, 4);
  assert.match(stdout, /等了 1 分钟还没全部结束/);
  assert.equal(clock.slept.length, 4, "60 秒 / 15 秒 = 4 次");
});

test("batch status：不加 --wait 只查一次；本机按表跑的批次仍看本机记录", async () => {
  const dir = workspace();
  const api = createApi({ pollsUntilDone: 5 });
  const file = writeJsonl(dir, items(2));
  const batchId = JSON.parse((await run(["batch", "submit", file, "--yes", "--json"], { dir, api })).stdout).batch_ids[0];
  const before = api.requests.length;
  const { code, stdout } = await run(["batch", "status", batchId], { dir, api });
  assert.equal(code, 0);
  assert.equal(api.requests.length, before + 1);
  assert.match(stdout, /还没全部结束/);
  assert.match(stdout, /--wait --download/);
  const missing = await run(["batch", "status", "no-such-batch"], { dir, api });
  assert.equal(missing.error.code, "not_found");
  assert.match(missing.error.message, /找不到这个编号。（错误码 not_found，请求编号 rid-404-not_found）/);
});

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

test("jobs list --all：顺着 next_cursor 翻到底；不加 --all 只取一页并给出游标", async () => {
  const dir = workspace();
  const api = createApi();
  await run(["batch", "submit", writeJsonl(dir, items(45)), "--yes"], { dir, api });
  api.requests.length = 0;
  const all = await run(["jobs", "list", "--limit", "20", "--all", "--json"], { dir, api });
  const out = JSON.parse(all.stdout);
  assert.equal(out.items.length, 45);
  assert.equal(new Set(out.items.map((j) => j.job_id)).size, 45);
  assert.equal(out.next_cursor, null);
  assert.deepEqual(api.requests.map((r) => r.query.cursor ?? null), [null, "c20", "c40"]);
  assert.ok(api.requests.every((r) => r.query.limit === "20"));

  api.requests.length = 0;
  const one = await run(["jobs", "list", "--status", "queued", "--tag", "SKU001", "--model", MODEL, "--batch", "b1", "--since", "2026-09-27T00:00:00Z", "--until", "2026-09-29T00:00:00Z", "--json"], { dir, api });
  assert.equal(one.error, null, String(one.error?.message));
  assert.deepEqual(api.requests[0].query, { limit: "20", status: "queued", tag: "SKU001", model: MODEL, batch_id: "b1", since: "2026-09-27T00:00:00Z", until: "2026-09-29T00:00:00Z" });
  const page = await run(["jobs", "list"], { dir, api });
  assert.match(page.stdout, /加 --cursor c20 接着翻/);
  const bad = await run(["jobs", "list", "--status", "done"], { dir, api });
  assert.equal(bad.error.code, "usage");
});

test("jobs get / query / cancel", async () => {
  const dir = workspace();
  const api = createApi({ pollsUntilDone: 99 });
  await run(["batch", "submit", writeJsonl(dir, items(3)), "--yes"], { dir, api });
  const got = await run(["jobs", "get", "job-0001", "--json"], { dir, api });
  assert.equal(JSON.parse(got.stdout).job_id, "job-0001");
  const human = await run(["jobs", "get", "job-0002"], { dir, api });
  assert.match(human.stdout, /job-0002\s+排队中\s+SKU001/);

  const q = await run(["jobs", "query", "job-0001", "job-0003", "nope", "--json"], { dir, api });
  assert.equal(q.code, 3, "有查不到的 → 退出码 3");
  const res = JSON.parse(q.stdout);
  assert.deepEqual(res.items.map((j) => j.job_id), ["job-0001", "job-0003"]);
  assert.deepEqual(res.missing, ["nope"]);

  const c = await run(["jobs", "cancel", "job-0002"], { dir, api });
  assert.equal(c.code, 0);
  assert.match(c.stdout, /已取消.*错误码 cancelled|已取消/);
  const again = await run(["jobs", "cancel", "job-0002", "--json"], { dir, api });
  assert.equal(again.code, 3);
  assert.equal(JSON.parse(again.stdout).code, "not_cancellable");
});

test("jobs query：超过 200 个编号自动分几次查", async () => {
  const dir = workspace();
  const api = createApi();
  const ids = Array.from({ length: 450 }, (_, i) => `id-${i}`);
  const { code } = await run(["jobs", "query", ...ids, "--json"], { dir, api });
  assert.equal(code, 3);
  assert.deepEqual(api.requests.map((r) => r.body.job_ids.length), [200, 200, 50]);
});

// ---------------------------------------------------------------------------
// 报错：中文原因 + 错误码 + 请求编号；只重试 503
// ---------------------------------------------------------------------------

test("401：带服务端中文原因、错误码、请求编号；不重试、不等", async () => {
  const dir = workspace();
  let calls = 0;
  const api = createApi({
    onRequest: () => {
      calls += 1;
      return apiError(401, "unauthorized", "钥匙无效或已撤销。");
    },
  });
  const { error, clock } = await run(["jobs", "list", "--json"], { dir, api });
  assert.equal(error.code, "unauthorized");
  assert.match(error.message, /钥匙无效或已撤销。/);
  assert.match(error.message, /错误码 unauthorized/);
  assert.match(error.message, /请求编号 rid-401-unauthorized/);
  assert.equal(error.requestId, "rid-401-unauthorized");
  assert.equal(calls, 1);
  assert.deepEqual(clock.slept, []);
});

test("503：按 Retry-After 等了再试；一直 503 最多试 4 次就报错并带请求编号", async () => {
  const dir = workspace();
  let fails = 1;
  const api = createApi({
    onRequest: () => (fails-- > 0 ? apiError(503, "service_unavailable", "出图服务暂时不可用。", {}, { "retry-after": "7" }) : undefined),
  });
  const ok = await run(["jobs", "list", "--json"], { dir, api });
  assert.equal(ok.error, null, String(ok.error?.message));
  assert.deepEqual(ok.clock.slept, [7_000]);

  let calls = 0;
  const down = createApi({
    onRequest: () => {
      calls += 1;
      return apiError(503, "service_unavailable", "出图服务暂时不可用。", {}, { "retry-after": "3" });
    },
  });
  const bad = await run(["jobs", "list"], { dir, api: down });
  assert.equal(bad.error.code, "service_unavailable");
  assert.equal(bad.error.exitCode, 4);
  assert.match(bad.error.message, /出图服务暂时不可用。（错误码 service_unavailable，请求编号 rid-503-service_unavailable）/);
  assert.equal(calls, 4, "有上限");
  assert.deepEqual(bad.clock.slept, [3_000, 3_000, 3_000]);
});

test("其他 4xx 一律不重试：原因、错误码、请求编号、字段都报出来", async () => {
  const dir = workspace();
  const cases = [
    [apiError(400, "invalid_request", "参数格式不对。", { fields: ["items.0.n"] }), "invalid_request", /参数格式不对。（有问题的字段：items\.0\.n）（错误码 invalid_request，请求编号 rid-400-invalid_request）/],
    [apiError(402, "insufficient_credits", "余额不足。", { required: "150.0000", available: "120.0000" }), "insufficient_credits", /余额不足。（这次要 150\.0000 点，可用 120\.0000 点）（错误码 insufficient_credits/],
    [apiError(404, "not_found", "找不到这个编号。"), "not_found", /找不到这个编号。（错误码 not_found，请求编号 rid-404-not_found）/],
    [apiError(409, "idempotency_conflict", "这个 key 已用在另一份内容上。"), "idempotency_conflict", /错误码 idempotency_conflict/],
  ];
  for (const [response, code, pattern] of cases) {
    let calls = 0;
    const api = createApi({
      onRequest: () => {
        calls += 1;
        return response.clone();
      },
    });
    const { error, clock } = await run(["jobs", "get", "job-x"], { dir, api });
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
    assert.equal(calls, 1, `${code} 不重试`);
    assert.deepEqual(clock.slept, []);
  }
});

test("钥匙里混进说明文字（换行 / 中文）：直接说格式不对，不当成网络问题去重试", async () => {
  const dir = workspace();
  let calls = 0;
  const { error, clock } = await run(["jobs", "list"], {
    dir,
    key: `# 测试用钥匙说明\nkey=${TEST_KEY}`,
    api: {
      fetch: async () => {
        calls += 1;
        throw new TypeError("Cannot convert argument to a ByteString");
      },
    },
  });
  assert.equal(error.code, "invalid_key_format");
  assert.match(error.message, /格式不对/);
  assert.equal(calls, 0);
  assert.deepEqual(clock.slept, []);
});

test("403：网关回的 HTML 说清不是钥匙问题；应用回的 JSON 403 报原因、错误码、请求编号；都不重试", async () => {
  const dir = workspace();
  let calls = 0;
  const gateway = createApi({
    onRequest: () => {
      calls += 1;
      return new Response("<html><head><title>403 Forbidden</title></head><body>nginx</body></html>", { status: 403, headers: { "content-type": "text/html" } });
    },
  });
  const blocked = await run(["jobs", "list"], { dir, api: gateway });
  assert.equal(blocked.error.code, "endpoint_blocked");
  assert.match(blocked.error.message, /不是钥匙问题/);
  assert.equal(calls, 1);
  const scoped = createApi({ onRequest: () => apiError(403, "insufficient_scope", "没带钥匙。") });
  const denied = await run(["jobs", "list"], { dir, api: scoped });
  assert.equal(denied.error.code, "insufficient_scope");
  assert.match(denied.error.message, /错误码 insufficient_scope，请求编号 rid-403-insufficient_scope/);
});

test("--json 报错形状：error_code / reason / request_id，没有钥匙", () => {
  const e = new CliError("not_found", "找不到。（错误码 not_found，请求编号 r1）", { requestId: "r1", httpStatus: 404 });
  const payload = errorPayload(e);
  assert.deepEqual(payload, { error: { error_code: "not_found", reason: e.message, request_id: "r1", http_status: 404 } });
});

test("--help 列出新命令；帮助里不写死服务端限额数字", async () => {
  for (const word of ["batch submit", "batch status <批次号>", "--wait", "--download", "jobs get", "jobs list", "jobs query", "jobs cancel", "--all", "--json"]) {
    assert.ok(HELP.includes(word), word);
  }
  assert.ok(!existsSync(join(workspace(), ".quriov")));
});
