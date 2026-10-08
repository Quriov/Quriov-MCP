// 详情套图（aplus modules / run / status / jobs）的测试。
// 假服务端只在内存里，不连任何真实地址、不花钱；用户目录一律是临时目录。

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { APLUS_BASE, MCP_ENDPOINT, detailText, serverReason } from "../lib/common.mjs";
import { APLUS_DEFAULT_MODEL, collectRunInput, moduleRows, parsePointsText } from "../lib/aplus.mjs";
import { QuriovClient } from "../lib/transport.mjs";
import { HELP, main } from "../bin/quriov.mjs";

const TEST_KEY = "unit-test-aplus-key-never-print";
const MODULE_IDS = [
  "aplus_hero_banner",
  "aplus_pain_points",
  "aplus_key_features",
  "aplus_technology_detail",
  "aplus_color_options",
  "aplus_lifestyle",
  "aplus_comparison",
  "aplus_size_chart",
  "aplus_whats_in_box",
  "aplus_brand_story",
  "aplus_usage_steps",
];
const FOUR = ["aplus_pain_points", "aplus_key_features", "aplus_technology_detail", "aplus_color_options"];
const PRICE = 0.75;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "x-request-id": "rid-aplus" } });
}

// 假的详情套图接口 + 估价用到的三个 MCP 工具 + 结果图下载。
function createServer({ pollsUntilDone = 1, balance = "100", failModules = [], onSubmit = null, onRequest = null } = {}) {
  const server = { requests: [], submits: [], downloads: [], tools: [], jobs: new Map(), seq: 0 };
  const view = (job) => {
    const done = job.polls >= pollsUntilDone;
    const results = done
      ? job.moduleIds.map((id, seq) =>
          failModules.includes(id)
            ? { module_id: id, status: "failed", image_url: null, remote_key: null, cost_credits: null, failure_reason: "这个模块生成失败, 已退款", seq }
            : { module_id: id, status: "completed", image_url: `https://oss.example.test/aplus/${job.id}/${seq}.png?sig=1`, remote_key: `k/${seq}.png`, cost_credits: PRICE.toFixed(2), failure_reason: null, seq },
        )
      : [];
    const failed = results.filter((r) => r.status === "failed").length;
    const completed = results.length - failed;
    const status = !done ? (job.polls ? "running" : "queued") : failed === 0 ? "succeeded" : completed === 0 ? "failed" : "partial";
    return {
      id: job.id,
      batch_id: `b-${job.id}`,
      created_by_user_id: "00000000-0000-0000-0000-000000000001",
      status,
      total_modules: job.moduleIds.length,
      completed_modules: completed,
      failed_modules: failed,
      // 故意打乱顺序返回：命令行要按 seq 排回去
      module_results: [...results].reverse(),
      error_reason: null,
      created_at: "2026-10-08T03:00:00+00:00",
      started_at: null,
      completed_at: null,
      expires_at: "2026-11-07T03:00:00+00:00",
    };
  };

  const mcpTools = {
    list_capabilities: () => ({
      models: ["gpt-image-2.5-1K", "gpt-image-2.5-2K", "gpt-image-2.5-4K"].map((id) => ({ id, display_name: id, modality: "image", pricing_unit: "call", available: true })),
      templates: [],
    }),
    estimate_cost: (args) => ({ model_id: args.model_id, pricing_unit: args.pricing_unit, units: String(args.units), credits: (Number(args.units) * PRICE).toFixed(2) }),
    get_account: () => ({ balance, wallet_type: "organization" }),
  };

  server.fetch = async (url, init = {}) => {
    const headers = init.headers ?? {};
    if (url.startsWith("https://oss.example.test/")) {
      assert.equal(headers.Authorization, undefined, "下载结果图不能带钥匙");
      server.downloads.push(url);
      return new Response(new Uint8Array([137, 80, 78, 71, 7]), { status: 200 });
    }
    assert.equal(headers.Authorization, `Bearer ${TEST_KEY}`, "API 请求必须带钥匙");
    if (url === MCP_ENDPOINT) {
      const request = JSON.parse(init.body);
      if (request.method === "initialize") return json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
      assert.equal(request.method, "tools/call");
      const { name, arguments: args } = request.params;
      server.tools.push({ name, args });
      assert.ok(mcpTools[name], `估价只该用到免费工具，不该调 ${name}`);
      return json({ jsonrpc: "2.0", id: request.id, result: { structuredContent: mcpTools[name](args) } });
    }
    assert.ok(url.startsWith(`${APLUS_BASE}/`), `只连详情套图接口：${url}`);
    const u = new URL(url);
    const path = u.pathname.slice(new URL(APLUS_BASE).pathname.length);
    const req = { method: init.method, path, query: Object.fromEntries(u.searchParams) };
    server.requests.push(req);
    if (onRequest) {
      const custom = await onRequest(req, init, server);
      if (custom) return custom;
    }
    if (init.method === "GET" && path === "/templates") {
      return json({ modules: MODULE_IDS.map((id, i) => ({ id, name: `模块${i + 1}`, description: `说明${i + 1}`, aspect_ratio: "3:4", dimensions: "1464x1952" })) });
    }
    if (init.method === "POST" && path === "/generate") {
      assert.ok(init.body instanceof FormData, "提交要用 multipart 表单");
      assert.equal(headers["Content-Type"], undefined, "multipart 的 Content-Type 要留给 fetch 自己写（带边界）");
      const form = init.body;
      const submit = { fields: {}, file: form.get("reference_image") };
      for (const [k, v] of form.entries()) if (typeof v === "string") submit.fields[k] = v;
      server.submits.push(submit);
      if (onSubmit) {
        const custom = await onSubmit(submit, server);
        if (custom) return custom;
      }
      server.seq += 1;
      const job = { id: `0000000${server.seq}-aaaa-bbbb-cccc-000000000000`, moduleIds: JSON.parse(submit.fields.module_ids), polls: 0 };
      server.jobs.set(job.id, job);
      return json({ job_id: job.id, status: "queued", total_modules: job.moduleIds.length, status_url: `/api/v1/aplus/jobs/${job.id}`, model_id: submit.fields.model_id, notice: null }, 202);
    }
    let m;
    if (init.method === "GET" && (m = /^\/jobs\/([^/]+)$/.exec(path))) {
      const job = server.jobs.get(m[1]);
      if (!job) return json({ detail: `任务 ${m[1]} 不存在或无权访问` }, 404);
      const v = view(job);
      job.polls += 1;
      return json(v);
    }
    if (init.method === "GET" && path === "/jobs") {
      return json({ jobs: [...server.jobs.values()].reverse().map(view), next_cursor: null });
    }
    return json({ detail: "Not Found" }, 404);
  };
  return server;
}

function fakeClock() {
  const clock = { t: Date.UTC(2026, 9, 8, 3, 0, 0), slept: [] };
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
  const dir = mkdtempSync(join(tmpdir(), "quriov-aplus-test-"));
  writeFileSync(join(dir, "ref.png"), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  return dir;
}

async function run(argv, { dir, server, clock = fakeClock(), stdin = { isTTY: false }, shouldStop } = {}) {
  const stdout = sink();
  const stderr = sink();
  let code;
  let error = null;
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  try {
    code = await main(argv, {
      env: { QURIOV_API_KEY: TEST_KEY, XDG_CONFIG_HOME: join(dir, "config"), APPDATA: join(dir, "config") },
      stdout,
      stderr,
      stdin,
      home,
      platform: "linux",
      fetchImpl: server ? server.fetch : async () => assert.fail("不应该联网"),
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

const base = (dir, extra = []) => ["aplus", "run", "--modules", FOUR.join(","), "--ref", join(dir, "ref.png"), "--point", "轻", "-o", join(dir, "out"), ...extra];
const posts = (server) => server.requests.filter((r) => r.method === "POST");

// ---------------------------------------------------------------------------
// 模块清单
// ---------------------------------------------------------------------------

test("aplus modules：列出服务端给的全部模块（编号 + 名称）；--json 原样给出", async () => {
  const dir = workspace();
  const server = createServer();
  const human = await run(["aplus", "modules"], { dir, server });
  assert.equal(human.code, 0, String(human.error?.message));
  for (const id of MODULE_IDS) assert.match(human.stdout, new RegExp(`${id}\\s`));
  assert.match(human.stdout, /aplus_pain_points\s+3:4\s+模块2/);
  const machine = JSON.parse((await run(["aplus", "modules", "--json"], { dir, server })).stdout);
  assert.deepEqual(machine.modules.map((m) => m.id), MODULE_IDS);
  assert.equal(posts(server).length, 0);
  assert.match(HELP, /quriov aplus run/);
});

test("模块清单不用登录：它成功不算钥匙验证过，后面第一把钥匙被拒时照样换下一把", async () => {
  const seen = [];
  const client = new QuriovClient({
    key: "stale-key-not-real",
    keySource: "环境变量 QURIOV_API_KEY 的钥匙",
    fallbacks: [{ key: TEST_KEY, source: "quriov setup 保存的钥匙" }],
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      seen.push([url, init.headers.Authorization]);
      if (url === `${APLUS_BASE}/templates`) return json({ modules: [] });
      if (init.headers.Authorization !== `Bearer ${TEST_KEY}`) return json({ detail: "钥匙无效" }, 401);
      const request = JSON.parse(init.body);
      return json({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize" ? {} : { structuredContent: { balance: "1" } } });
    },
  });
  await client.aplusModules();
  assert.deepEqual(await client.account(), { balance: "1" });
  assert.equal(client.keySource, "quriov setup 保存的钥匙");
  assert.deepEqual(client.rejectedSources, ["环境变量 QURIOV_API_KEY 的钥匙"]);
  assert.ok(seen.length >= 3);
});

// ---------------------------------------------------------------------------
// 本机校验先于网络
// ---------------------------------------------------------------------------

test("本机校验：模块数越界 / 重复、参考图不存在 / 太大 / 不是图、卖点为空、型号不对 —— 都不联网，问题一次全报", async () => {
  const dir = workspace();
  const big = join(dir, "big.png");
  writeFileSync(big, new Uint8Array(10 * 1024 * 1024 + 1));
  writeFileSync(join(dir, "empty.txt"), "\n  \n");
  const cases = [
    [["aplus", "run", "--ref", join(dir, "ref.png"), "--point", "轻"], /没给模块/],
    [["aplus", "run", "--modules", MODULE_IDS.slice(0, 6).join(","), "--ref", join(dir, "ref.png"), "--point", "轻"], /一次最多 5 个模块，这里给了 6 个/],
    [["aplus", "run", "--modules", "aplus_lifestyle,aplus_lifestyle", "--ref", join(dir, "ref.png"), "--point", "轻"], /模块重复了：aplus_lifestyle/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--point", "轻"], /要正好 1 张参考图.*给了 0 张/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--ref", join(dir, "ref.png"), "--ref", big, "--point", "轻"], /要正好 1 张参考图.*给了 2 张/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--ref", join(dir, "nope.png"), "--point", "轻"], /找不到参考图/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--ref", big, "--point", "轻"], /10\.0 MB，超过 10 MB 上限/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--ref", join(dir, "empty.txt"), "--point", "轻"], /不是 JPG \/ PNG \/ WebP/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--ref", join(dir, "ref.png")], /没有卖点/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--ref", join(dir, "ref.png"), "--point", "   "], /没有卖点/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--ref", join(dir, "ref.png"), "--points-file", join(dir, "empty.txt")], /没有卖点/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--ref", join(dir, "ref.png"), "--points-file", join(dir, "missing.txt")], /读不到卖点文件/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--ref", join(dir, "ref.png"), "--point", "轻", "-m", "some-video-model"], /详情套图不能用型号 some-video-model/],
    [["aplus", "run", "--modules", "aplus_lifestyle", "--ref", join(dir, "ref.png"), "--point", "轻", "-m", "gpt-image-2-2K"], /已停用，请改用同档的 gpt-image-2\.5-2K/],
    [["aplus", "run", "--modules", "aplus_size_chart", "--ref", join(dir, "ref.png"), "--point", "轻"], /aplus_size_chart 要带真实尺码数据/],
  ];
  for (const [argv, pattern] of cases) {
    const { error, code } = await run([...argv, "--yes"], { dir }); // 没给 server：一联网就判失败
    assert.equal(code, undefined, argv.join(" "));
    assert.equal(error?.code, "invalid_spec", `${argv.join(" ")} → ${error?.message}`);
    assert.equal(error.exitCode, 2);
    assert.match(error.message, pattern);
    assert.match(error.message, /没有提交，没有花钱/);
  }
  const many = await run(["aplus", "run", "--modules", MODULE_IDS.slice(0, 6).join(","), "--ref", join(dir, "nope.png"), "--yes"], { dir });
  assert.match(many.error.message, /有 3 处要改/, "一次全报");
});

test("模块编号不在服务端清单里：点名是哪个、列出能用的，不提交", async () => {
  const dir = workspace();
  const server = createServer();
  const { error } = await run(["aplus", "run", "--modules", "aplus_pain_points,aplus_typo", "--ref", join(dir, "ref.png"), "--point", "轻", "--yes"], { dir, server });
  assert.equal(error.code, "unknown_module");
  assert.equal(error.exitCode, 2);
  assert.match(error.message, /模块编号不存在：aplus_typo（没有提交，没有花钱）/);
  assert.match(error.message, /aplus_color_options/);
  assert.equal(posts(server).length, 0);
  assert.equal(server.tools.length, 0, "编号不对就不用再估价");
});

test("卖点文件：一行一条或 JSON 数组都认；命令行里的和文件里的按顺序合在一起", () => {
  assert.deepEqual(parsePointsText("﻿轻\r\n\r\n  防水 \n"), ["轻", "防水"]);
  assert.deepEqual(parsePointsText('["a, b", "c\\"d"]'), ["a, b", 'c"d']);
  assert.throws(() => parsePointsText("[1, 2]"));
  assert.throws(() => parsePointsText('["a",'));
  const dir = workspace();
  writeFileSync(join(dir, "points.txt"), "续航 40 小时\n防水 IPX7\n");
  const input = collectRunInput({ modules: "aplus_lifestyle;aplus_comparison", ref: [join(dir, "ref.png")], point: ["轻"], pointsFile: join(dir, "points.txt") }, ["aplus_brand_story"]);
  assert.deepEqual(input.sellingPoints, ["轻", "续航 40 小时", "防水 IPX7"]);
  assert.deepEqual(input.moduleIds, ["aplus_lifestyle", "aplus_comparison", "aplus_brand_story"]);
  assert.equal(input.model, APLUS_DEFAULT_MODEL);
});

// ---------------------------------------------------------------------------
// 估价
// ---------------------------------------------------------------------------

test("--estimate：给出每个模块的单价、合计和余额；不发提交请求、不建任务、不写文件", async () => {
  const dir = workspace();
  const server = createServer();
  const human = await run(base(dir, ["--estimate"]), { dir, server });
  assert.equal(human.error, null, String(human.error?.message));
  assert.equal(human.code, 0);
  assert.match(human.stdout, /4 个模块/);
  assert.match(human.stdout, /gpt-image-2\.5-1K × 4 个模块（每个 0\.75 点）= 3\.00 点/);
  assert.match(human.stdout, /当前余额 100 点/);
  assert.match(human.stdout, /只估价：没有提交，没有花钱/);
  FOUR.forEach((id, i) => assert.match(human.stdout, new RegExp(`${i + 1}\\s+${id}`)));
  assert.equal(posts(server).length, 0, "估价不许发提交请求");
  assert.equal(server.jobs.size, 0);
  assert.equal(existsSync(join(dir, "out")), false);
  assert.deepEqual(server.tools.map((t) => t.name), ["list_capabilities", "estimate_cost", "estimate_cost", "get_account"]);
  assert.deepEqual(server.tools.filter((t) => t.name === "estimate_cost").map((t) => t.args.units), [4, 1]);

  const machine = await run(base(dir, ["--estimate", "--json", "-m", "gpt-image-2.5-2K"]), { dir, server });
  const out = JSON.parse(machine.stdout);
  assert.deepEqual(out.estimate, { model: "gpt-image-2.5-2K", modules: 4, credits_per_module: "0.75", credits: "3.00", balance: "100" });
  assert.deepEqual(out.plan.moduleIds, FOUR);
  assert.equal(posts(server).length, 0);
});

test("--dry-run：完全不联网，只列计划", async () => {
  const dir = workspace();
  const { code, stdout } = await run(base(dir, ["--dry-run"]), { dir });
  assert.equal(code, 0);
  assert.match(stdout, /详情套图计划：4 个模块/);
  assert.match(stdout, /没有联网，没有提交，没有花钱/);
});

test("没加 --yes 的非交互环境：估完价就停，不提交；余额不够也不提交", async () => {
  const dir = workspace();
  const server = createServer();
  const noYes = await run(base(dir), { dir, server });
  assert.equal(noYes.error.code, "needs_confirmation");
  assert.match(noYes.error.message, /--estimate.*--yes/);
  assert.equal(posts(server).length, 0);

  const poor = createServer({ balance: "2.99" });
  const broke = await run(base(dir, ["--yes"]), { dir, server: poor });
  assert.equal(broke.error.code, "insufficient_credits");
  assert.equal(broke.error.exitCode, 4);
  assert.match(broke.error.message, /约 3\.00 点，余额 2\.99 点。没有提交/);
  assert.equal(posts(poor).length, 0);
});

// ---------------------------------------------------------------------------
// 提交 → 等结果 → 下载
// ---------------------------------------------------------------------------

test("run：module_ids / selling_points 是 JSON 数组字符串且顺序不变；等结果、按顺序下载、列出每个模块扣点和合计", async () => {
  const dir = workspace();
  const server = createServer({ pollsUntilDone: 2 });
  writeFileSync(join(dir, "points.txt"), '带"引号"和,逗号的卖点\n第三条\n');
  const order = ["aplus_color_options", "aplus_pain_points", "aplus_technology_detail", "aplus_key_features"]; // 故意不是清单顺序
  const argv = ["aplus", "run", "--modules", order.join(","), "--ref", join(dir, "ref.png"), "--point", "第一条：轻", "--points-file", join(dir, "points.txt"), "-p", "蓝牙耳机", "--headline", "听得更久", "-o", join(dir, "out"), "--yes"];
  const { code, error, stdout, clock } = await run(argv, { dir, server });
  assert.equal(error, null, String(error?.message));
  assert.equal(code, 0);

  assert.equal(server.submits.length, 1, "只提交一次");
  const { fields, file } = server.submits[0];
  assert.equal(typeof fields.module_ids, "string");
  assert.deepEqual(JSON.parse(fields.module_ids), order, "模块按给的顺序");
  assert.equal(typeof fields.selling_points, "string");
  const points = JSON.parse(fields.selling_points);
  assert.ok(Array.isArray(points) && points.every((p) => typeof p === "string"), "卖点必须是 JSON 字符串数组");
  assert.deepEqual(points, ["第一条：轻", '带"引号"和,逗号的卖点', "第三条"]);
  assert.equal(fields.model_id, "gpt-image-2.5-1K");
  assert.equal(fields.product_description, "蓝牙耳机");
  assert.equal(fields.headline, "听得更久");
  assert.equal(fields.size_chart_data, undefined);
  assert.equal(file.name, "ref.png");
  assert.equal(file.type, "image/png");
  assert.equal(file.size, 8);

  const jobId = [...server.jobs.keys()][0];
  assert.match(stdout, new RegExp(`任务编号 ${jobId}`));
  assert.match(stdout, new RegExp(`任务 ${jobId}：成功（成功 4 / 失败 0，共 4 个模块），型号 gpt-image-2\\.5-1K`));
  const files = readdirSync(join(dir, "out")).sort();
  assert.deepEqual(files, order.map((id, i) => `0${i + 1}-${id}.png`));
  order.forEach((id, i) => {
    assert.match(stdout, new RegExp(`${i + 1}\\s+${id}\\s+成功\\s+0\\.75 点\\s+→ .*0${i + 1}-${id}\\.png`));
  });
  assert.match(stdout, /合计实扣 3 点/);
  assert.equal(server.downloads.length, 4);
  assert.deepEqual(clock.slept, [10_000, 10_000], "默认 10 秒查一次");
});

test("run --json：一份机器可读的结果（任务编号、每个模块的状态 / 扣点 / 文件、合计）；标准输出只有这一行 JSON", async () => {
  const dir = workspace();
  const server = createServer();
  const { code, stdout, stderr } = await run(base(dir, ["--yes", "--json"]), { dir, server });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.job_id, [...server.jobs.keys()][0]);
  assert.equal(out.status, "succeeded");
  assert.equal(out.total_credits, "3");
  assert.deepEqual(out.modules.map((m) => m.module_id), FOUR);
  assert.deepEqual(out.modules.map((m) => basename(m.file)), FOUR.map((id, i) => `0${i + 1}-${id}.png`));
  assert.ok(out.modules.every((m) => m.credits === "0.75" && m.download === "downloaded"));
  assert.match(stderr, /任务编号/);
});

test("部分模块失败：照实列出哪些成功哪些失败，成功的照样下载，退出码 3", async () => {
  const dir = workspace();
  const server = createServer({ failModules: ["aplus_key_features"] });
  const { code, stdout } = await run(base(dir, ["--yes"]), { dir, server });
  assert.equal(code, 3);
  assert.match(stdout, /部分成功（成功 3 \/ 失败 1，共 4 个模块）/);
  assert.match(stdout, /2\s+aplus_key_features\s+失败\s+原因：这个模块生成失败, 已退款/);
  assert.match(stdout, /合计实扣 2\.25 点/);
  assert.match(stdout, /失败的模块：aplus_key_features。/);
  assert.deepEqual(readdirSync(join(dir, "out")).sort(), ["01-aplus_pain_points.png", "03-aplus_technology_detail.png", "04-aplus_color_options.png"]);

  const all = createServer({ failModules: FOUR });
  const dir2 = workspace();
  const failed = await run(base(dir2, ["--yes", "--json"]), { dir: dir2, server: all });
  assert.equal(failed.code, 3);
  const out = JSON.parse(failed.stdout);
  assert.equal(out.status, "failed");
  assert.deepEqual(out.failed_modules, FOUR);
  assert.equal(out.total_credits, "0");
});

test("任务结束了却少一个模块的结果：也列成失败，不让它悄悄消失", () => {
  const rows = moduleRows(
    { id: "j", status: "partial", module_results: [{ module_id: "b", status: "completed", image_url: "https://x/1.png", cost_credits: 0.5, seq: 1 }], error_reason: null },
    ["a", "b"],
  );
  assert.deepEqual(rows.map((r) => [r.seq, r.module_id, r.status]), [[0, "a", "missing"], [1, "b", "completed"]]);
  assert.equal(rows[1].credits, "0.5");
  assert.match(rows[0].failure_reason, /没有返回这个模块的结果/);
});

// ---------------------------------------------------------------------------
// 失败路径
// ---------------------------------------------------------------------------

test("提交时断网 / 超时：不自动重交（只发一次），报「结果不确定」并指去任务列表，退出码 4", async () => {
  const dir = workspace();
  const server = createServer({
    onSubmit: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const { error, clock } = await run(base(dir, ["--yes"]), { dir, server });
  assert.equal(error.code, "submit_unknown");
  assert.equal(error.exitCode, 4);
  assert.equal(server.submits.length, 1, "提交不许自动重试");
  assert.deepEqual(clock.slept, [], "没有等待重试");
  assert.match(error.message, /提交结果不确定/);
  assert.match(error.message, /没有自动重交/);
  assert.match(error.message, /quriov aplus jobs/);
});

test("提交时服务端 502 / 503：同样只发一次，按「结果不确定」报，并带上服务端给的原因", async () => {
  for (const [status, body, pattern] of [
    [502, "<html>bad gateway</html>", /HTTP 502/],
    [503, JSON.stringify({ detail: "后台队列入队失败, 任务已记录但未启动, 请联系管理员" }), /任务已记录但未启动/],
  ]) {
    const dir = workspace();
    const server = createServer({ onSubmit: async () => new Response(body, { status, headers: { "retry-after": "1" } }) });
    const { error, clock } = await run(base(dir, ["--yes"]), { dir, server });
    assert.equal(error.code, "submit_unknown", String(error?.message));
    assert.equal(error.exitCode, 4);
    assert.equal(server.submits.length, 1);
    assert.deepEqual(clock.slept, []);
    assert.match(error.message, pattern);
    assert.match(error.message, /quriov aplus jobs/);
    assert.doesNotMatch(error.message, /不会重复扣钱/, "这个接口不去重，不能说重跑不会重复扣钱");
  }
});

test("服务端明确拒绝（4xx）：detail 和 reason 两种写法的原因都显示出来；--json 时也在 reason 里", async () => {
  const cases = [
    [422, { detail: "单次最多生成 5 个模块 (请求 6 个). 请分批生成" }, /单次最多生成 5 个模块/],
    [400, { detail: "参考图不是有效的图片文件, 请换一张 (PNG / JPG)" }, /参考图不是有效的图片文件/],
    [422, { detail: [{ loc: ["body", "module_ids"], msg: "Field required", type: "missing" }] }, /module_ids：Field required/],
    [400, { error_code: "invalid_request", reason: "这是 reason 写法的原因", request_id: "rid-1" }, /这是 reason 写法的原因（错误码 invalid_request，请求编号 rid-1）/],
  ];
  for (const [status, body, pattern] of cases) {
    const dir = workspace();
    const server = createServer({ onSubmit: async () => json(body, status) });
    const { error } = await run(base(dir, ["--yes"]), { dir, server });
    assert.ok(error, "应该报错");
    assert.notEqual(error.code, "submit_unknown", "明确被拒不是「结果不确定」");
    assert.equal(error.httpStatus, status);
    assert.match(error.message, pattern);
    assert.equal(server.submits.length, 1);
  }
  assert.equal(detailText("  一句话 "), "一句话");
  assert.equal(detailText([{ loc: ["body", "a"], msg: "x" }, "y"]), "a：x；y");
  assert.equal(detailText({ message: "m" }), "m");
  assert.equal(detailText(null), null);
  assert.equal(serverReason({ reason: "r", detail: "d" }), "r");
  assert.equal(serverReason({ detail: "d" }), "d");
});

test("查任务时 404（detail 写法）：原因原样显示", async () => {
  const dir = workspace();
  const server = createServer();
  const { error } = await run(["aplus", "status", "no-such-job"], { dir, server });
  assert.equal(error.code, "not_found");
  assert.match(error.message, /任务 no-such-job 不存在或无权访问/);
});

test("等结果时查询出错：任务已经提交，报错里带任务编号和接着等的命令，提示不要重交，退出码 4", async () => {
  const dir = workspace();
  const server = createServer({
    onRequest: async (req) => (req.method === "GET" && req.path.startsWith("/jobs/") ? json({ detail: "boom" }, 500) : null),
  });
  const { error } = await run(base(dir, ["--yes"]), { dir, server });
  const jobId = [...server.jobs.keys()][0];
  assert.equal(server.submits.length, 1);
  assert.equal(error.exitCode, 4);
  assert.match(error.message, new RegExp(`任务 ${jobId} 已经提交`));
  assert.match(error.message, new RegExp(`quriov aplus status ${jobId} --wait --download`));
  assert.match(error.message, /不要重新提交/);
});

test("等超时：任务还在跑，退出码 4，给出接着等的命令，不重交", async () => {
  const dir = workspace();
  const server = createServer({ pollsUntilDone: 1000 });
  const { code, stdout } = await run(base(dir, ["--yes", "--timeout", "1", "--poll-seconds", "30"]), { dir, server });
  assert.equal(code, 4);
  assert.match(stdout, /等了 1 分钟还没结束（任务还在服务端跑，不要重新提交）/);
  assert.match(stdout, /quriov aplus status .* --wait --download/);
  assert.equal(server.submits.length, 1);
});

// ---------------------------------------------------------------------------
// --no-wait / status / jobs
// ---------------------------------------------------------------------------

test("--no-wait 提交后只给任务编号；之后 aplus status --wait --download 取回，aplus jobs 能看到", async () => {
  const dir = workspace();
  const server = createServer({ pollsUntilDone: 2 });
  const submitted = await run(base(dir, ["--yes", "--no-wait", "--json"]), { dir, server });
  assert.equal(submitted.code, 0);
  const out = JSON.parse(submitted.stdout);
  const jobId = [...server.jobs.keys()][0];
  assert.equal(out.job_id, jobId);
  assert.deepEqual(out.modules, FOUR);
  assert.equal(server.downloads.length, 0);
  assert.equal(server.requests.filter((r) => r.path.startsWith("/jobs")).length, 0, "--no-wait 不查任务");

  const peek = await run(["aplus", "status", jobId], { dir, server });
  assert.equal(peek.code, 0);
  assert.match(peek.stdout, /排队中/);
  assert.match(peek.stdout, /还没结束。等它结束并下载/);

  const waited = await run(["aplus", "status", jobId, "--wait", "--download", join(dir, "got"), "--json"], { dir, server });
  assert.equal(waited.code, 0, String(waited.error?.message));
  const result = JSON.parse(waited.stdout);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.modules.map((m) => m.module_id), FOUR, "按 seq 排回提交顺序");
  assert.deepEqual(readdirSync(join(dir, "got")).sort(), FOUR.map((id, i) => `0${i + 1}-${id}.png`));

  const again = await run(["aplus", "status", jobId, "--download", join(dir, "got"), "--json"], { dir, server });
  assert.ok(JSON.parse(again.stdout).modules.every((m) => m.download === "exists"), "已有的不重下");
  assert.equal(server.downloads.length, 4);

  const list = await run(["aplus", "jobs"], { dir, server });
  assert.match(list.stdout, new RegExp(`${jobId}\\s+成功\\s+模块 4/4\\s+实扣 3 点`));
  const listJson = JSON.parse((await run(["aplus", "jobs", "--json", "--limit", "5"], { dir, server })).stdout);
  assert.equal(listJson.jobs[0].id, jobId);
  assert.equal(server.requests.at(-1).query.limit, "5");
});

test("aplus 后面跟了不认识的子命令：给用法", async () => {
  const dir = workspace();
  const { error } = await run(["aplus", "bogus"], { dir });
  assert.equal(error.code, "usage");
  assert.match(error.message, /modules \/ run \/ status \/ jobs/);
});
