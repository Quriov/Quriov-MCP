import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CliError,
  HELP,
  KEY_ENV_NAMES,
  MCP_ENDPOINT,
  QuriovClient,
  UPLOAD_ENDPOINT,
  loadSpec,
  main,
  parseArgv,
  parseCsv,
  requireKey,
  resolveKeys,
  resolveKey,
  safeName,
  sumCredits,
} from "../bin/quriov.mjs";

const TEST_KEY = "unit-test-cli-key-never-print";

// ---------------------------------------------------------------------------
// 假服务端：MCP JSON-RPC（命令行用到的那几个工具 + tools/list）+ 参考图上传 + 结果图下载。
// 不连任何真实地址，也不花钱。
// ---------------------------------------------------------------------------

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function toolError(code, extra = {}) {
  const body = { code, message: "public message", retryable: false, ...extra };
  return { isError: true, content: [{ type: "text", text: `Error executing tool x: ${JSON.stringify(body)}` }] };
}

function createServer({ pollsUntilDone = 1, onTool = null, onHttp = null } = {}) {
  const server = {
    generations: new Map(), // idempotency_key -> gen
    calls: [], // { kind, name, args }
    downloads: [], // { url, headers }
    uploads: 0,
    toolCalls(name) {
      return this.calls.filter((c) => c.kind === "tool" && c.name === name);
    },
  };
  let seq = 0;

  const genView = (gen) => {
    const view = {
      request_id: gen.requestId,
      request_status: "succeeded",
      generation_id: gen.generationId,
      status: gen.status,
    };
    if (gen.status === "succeeded") {
      view.credits = (gen.n * 0.05).toFixed(2);
      view.billing_status = "settled";
      view.media = Array.from({ length: gen.n }, (_, i) => ({
        type: "image",
        url: `https://oss.example.test/mcp-out/${gen.generationId}/${i}.png?sig=abc`,
        content_type: "image/png",
      }));
    }
    return view;
  };

  const tools = {
    list_capabilities: () => ({
      revision: "r1",
      generated_at: "2026-09-28T00:00:00Z",
      models: [
        {
          target: "image",
          id: "gpt-image-2.5-2K",
          display_name: "Image 2.5 2K",
          modality: "image",
          pricing_unit: "call",
          supports_cancel: false,
          available: true,
          minimum_profile: { units: "1", options: { aspect_ratio: "1:1" }, required_media: [], allowed_media: ["image"] },
        },
      ],
      templates: [
        { id: "main_image", name: "主图", description: "白底主图", aspect_ratio: "1:1" },
        { id: "scene", name: "场景图", description: "场景", aspect_ratio: "3:4" },
        { id: "detail", name: "细节图", description: "特写", aspect_ratio: "1:1" },
      ],
    }),
    estimate_cost: (args) => ({
      model_id: args.model_id,
      pricing_unit: args.pricing_unit,
      units: String(args.units),
      credits: (Number(args.units) * 0.05).toFixed(2),
    }),
    get_account: () => ({
      balance: "100",
      wallet_type: "organization",
      quota: {
        daily_generation_limit: 100,
        daily_generation_used: 3,
        daily_generation_remaining: 97,
        resets_at: "2026-09-29T00:00:00Z",
        requests_per_minute_limit: 30,
      },
    }),
    generate_image: (args) => {
      let gen = server.generations.get(args.idempotency_key);
      if (!gen) {
        seq += 1;
        gen = {
          requestId: `req-${seq}`,
          generationId: `gen-${seq}`,
          status: "queued",
          polls: 0,
          n: args.options?.batch_size ?? 1,
          args,
        };
        server.generations.set(args.idempotency_key, gen);
      }
      return genView(gen);
    },
    list_generations: () => {
      const items = [];
      for (const gen of server.generations.values()) {
        gen.polls += 1;
        if (gen.polls >= pollsUntilDone && gen.status !== "failed") gen.status = "succeeded";
        items.push(genView(gen));
      }
      return { items: items.reverse() };
    },
  };

  server.fetch = async (url, init = {}) => {
    const headers = init.headers ?? {};
    if (typeof url === "string" && url.startsWith("https://oss.example.test/")) {
      server.downloads.push({ url, headers });
      return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), { status: 200 });
    }
    assert.equal(headers.Authorization, `Bearer ${TEST_KEY}`, "API 请求必须带钥匙");
    assert.match(headers["User-Agent"], /^quriov-cli\//);
    if (onHttp) {
      const override = await onHttp(url, init, server);
      if (override) return override;
    }
    if (url === UPLOAD_ENDPOINT) {
      server.uploads += 1;
      server.calls.push({ kind: "upload" });
      assert.ok(init.body instanceof FormData, "上传要用 multipart");
      assert.ok(init.body.get("file"), "上传字段名必须是 file");
      return jsonResponse({
        url: `https://oss.example.test/mcp-refs/${server.uploads}.png?sig=up`,
        expires_in: 86400,
        size_bytes: 8,
        content_type: "image/png",
      });
    }
    assert.equal(url, MCP_ENDPOINT);
    const request = JSON.parse(init.body);
    if (request.method === "initialize") {
      server.calls.push({ kind: "initialize" });
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    }
    if (request.method === "tools/list") {
      server.calls.push({ kind: "tools/list" });
      // 故意比核心工具多几个：自检只看核心工具在不在，不比总数。
      const names = [...Object.keys(tools), "generate_video", "check_generation", "cancel_generation", "future_batch_tool"];
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: names.map((name) => ({ name })) } });
    }
    assert.equal(request.method, "tools/call");
    const { name, arguments: args } = request.params;
    server.calls.push({ kind: "tool", name, args });
    let result;
    const custom = onTool ? await onTool(name, args, server) : undefined;
    if (custom !== undefined) result = custom;
    else result = { structuredContent: tools[name](args), isError: false };
    return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
  };
  server.tools = tools;
  return server;
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
  const dir = mkdtempSync(join(tmpdir(), "quriov-cli-test-"));
  mkdirSync(join(dir, "refs"));
  writeFileSync(join(dir, "refs", "a.png"), Buffer.from([137, 80, 78, 71, 0, 0]));
  writeFileSync(join(dir, "refs", "b.jpg"), Buffer.from([255, 216, 255, 0]));
  return dir;
}

function env(dir, extra = {}) {
  // 故意不带 PATH：不让测试探测到本机真装的客户端。
  return { QURIOV_MCP_ACCESS_KEY: TEST_KEY, XDG_CONFIG_HOME: join(dir, "config"), APPDATA: join(dir, "config"), ...extra };
}

// 每个测试一个假的用户目录：setup / uninstall 只准碰这里，绝不碰真的 ~/.claude.json 等。
function fakeHome(dir) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

async function run(argv, { dir, server, clock = fakeClock(), extraEnv = {}, shouldStop } = {}) {
  const stdout = sink();
  const stderr = sink();
  let code;
  let error = null;
  try {
    code = await main(argv, {
      env: env(dir, extraEnv),
      stdout,
      stderr,
      stdin: { isTTY: false },
      home: fakeHome(dir),
      platform: "linux",
      fetchImpl: server ? server.fetch : async () => assert.fail("不应该联网"),
      sleep: clock.sleep,
      now: clock.now,
      shouldStop,
    });
  } catch (e) {
    error = e;
  }
  return { code, error, stdout: stdout.text, stderr: stderr.text, clock };
}

function writeCsv(dir, text, name = "products.csv") {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

const TWO_BY_TWO = [
  "sku,refs,templates,prompt",
  'A001,refs/a.png,main_image;scene,"红色保温杯, 316 不锈钢"',
  "B002,refs/a.png;refs/b.jpg,main_image;scene,蓝色水杯",
].join("\n");

function stateFiles(dir) {
  return readdirSync(dir).filter((n) => n.endsWith(".json"));
}

// ---------------------------------------------------------------------------
// 参数与钥匙
// ---------------------------------------------------------------------------

test("钥匙不能写在命令参数里", () => {
  for (const bad of ["--key", "--key=abc", "--token", "--api-key=x", "--endpoint", "--base-url=http://evil"]) {
    assert.throws(() => parseArgv(["gen", bad, "x"]), (e) => e instanceof CliError && e.code === "forbidden_argument", bad);
  }
  const parsed = parseArgv(["gen", "-m", "m1", "--ref", "a.png", "--ref=b.png", "-n", "2", "--yes"]);
  assert.deepEqual(parsed.ref, ["a.png", "b.png"]);
  assert.equal(parsed.model, "m1");
  assert.equal(parsed.n, "2");
  assert.equal(parsed.yes, true);
  assert.throws(() => parseArgv(["--bogus"]), (e) => e.code === "usage");
});

test("钥匙：四个环境变量名都认；都没有才看 setup 保存的文件", () => {
  assert.deepEqual(KEY_ENV_NAMES, ["QURIOV_API_KEY", "QURIOV_MCP_ACCESS_KEY", "QURIOV_MCP_KEY", "QURIOV_ACCESS_KEY"]);
  assert.equal(resolveKey({ env: { QURIOV_API_KEY: "new", QURIOV_MCP_ACCESS_KEY: "a" }, readFile: () => "" }).key, "new");
  const noFile = () => {
    throw new Error("no file");
  };
  assert.equal(resolveKey({ env: { QURIOV_MCP_ACCESS_KEY: "a", QURIOV_MCP_KEY: "b" }, readFile: noFile }).key, "a");
  assert.equal(resolveKey({ env: { QURIOV_MCP_KEY: " b " }, readFile: noFile }).key, "b");
  assert.equal(resolveKey({ env: { QURIOV_ACCESS_KEY: "c" }, readFile: noFile }).key, "c");
  const fromFile = resolveKey({ env: {}, readFile: () => JSON.stringify({ key: "d" }), path: "/x" });
  assert.equal(fromFile.key, "d");
  assert.equal(resolveKey({ env: {}, readFile: noFile, path: "/x" }), null);
  assert.throws(
    () => requireKey({ env: {}, readFile: noFile, path: "/x" }),
    (e) => e.code === "missing_key" && e.message.includes("quriov setup") && e.message.includes("QURIOV_API_KEY"),
  );
});

test("--help 列出全部命令", async () => {
  const dir = workspace();
  const { code, stdout } = await run(["--help"], { dir });
  assert.equal(code, 0);
  for (const word of ["quriov setup", "quriov doctor", "quriov uninstall", "quriov upload", "quriov models", "quriov gen", "batch plan", "batch run", "batch status", "batch resume", "https://quriovai.com/install.md"]) {
    assert.ok(stdout.includes(word), word);
  }
  assert.equal(stdout.trim(), HELP.trim());
  // 帮助里不写死服务端限额数字、工具总数
  assert.doesNotMatch(HELP, /30 次|100 次|8 个工具/);
});

// ---------------------------------------------------------------------------
// 任务表
// ---------------------------------------------------------------------------

test("CSV：引号、BOM、CRLF、中文表头", () => {
  const rows = parseCsv('﻿货号,提示词\r\nA,"有逗号, 和 ""引号"""\r\n\r\n');
  assert.deepEqual(rows, [["货号", "提示词"], ["A", '有逗号, 和 "引号"']]);
});

test("任务表：2 个商品 × 2 个图位 = 4 次提交，参考图按表格所在文件夹找", () => {
  const dir = workspace();
  const spec = loadSpec(writeCsv(dir, TWO_BY_TWO), { model: "gpt-image-2.5-2K" });
  assert.deepEqual(spec.errors, []);
  assert.equal(spec.jobs.length, 4);
  assert.deepEqual(
    spec.jobs.map((j) => j.key),
    ["A001/main_image", "A001/scene", "B002/main_image", "B002/scene"],
  );
  assert.equal(spec.jobs[2].refs.length, 2);
  assert.ok(spec.jobs[2].refs[1].endsWith(join("refs", "b.jpg")));
  assert.equal(spec.jobs[0].prompt, "红色保温杯, 316 不锈钢");
});

test("任务表：问题一次全报出来，一张都不提交", () => {
  const dir = workspace();
  const long = "长".repeat(8001);
  const csv = [
    "sku,refs,templates,prompt,n",
    "A,refs/missing.png,main_image,x,1",
    "B,,main_image;main_image,x,1",
    "C,,,,1",
    `D,,,${long},1`,
    "E,refs/a.png,,x,9",
  ].join("\n");
  const spec = loadSpec(writeCsv(dir, csv), { model: "m" });
  const all = spec.errors.join("\n");
  assert.match(all, /找不到参考图/);
  assert.match(all, /图位 main_image 重复/);
  assert.match(all, /没有提示词/);
  assert.match(all, /超过 8000 字/);
  assert.match(all, /1 到 4/);
});

test("任务表：文件夹模式，每个子文件夹一个商品", () => {
  const dir = workspace();
  const root = join(dir, "products");
  mkdirSync(join(root, "SKU-1"), { recursive: true });
  writeFileSync(join(root, "SKU-1", "front.png"), "x");
  writeFileSync(join(root, "SKU-1", "prompt.txt"), "白色 T 恤");
  const spec = loadSpec(root, { model: "m", templates: ["main_image", "detail"] });
  assert.deepEqual(spec.errors, []);
  assert.equal(spec.jobs.length, 2);
  assert.equal(spec.jobs[0].sku, "SKU-1");
  assert.equal(spec.jobs[0].prompt, "白色 T 恤");
  assert.equal(spec.jobs[0].refs.length, 1);
});

test("Windows 不能用的文件名字符会被换掉", () => {
  assert.equal(safeName('a/b:c*?"<>|'), "a_b_c______");
  assert.equal(safeName("CON"), "_CON");
  assert.equal(safeName("name. "), "name");
});

test("点数按十进制相加，不出现浮点误差", () => {
  assert.equal(sumCredits(["0.1", "0.2", null, ""]), "0.3");
  assert.equal(sumCredits(["1.05", "2.95"]), "4");
});

// ---------------------------------------------------------------------------
// 试运行：不联网
// ---------------------------------------------------------------------------

test("batch plan / batch run --dry-run / gen --dry-run 都不联网、不花钱", async () => {
  const dir = workspace();
  const csv = writeCsv(dir, TWO_BY_TWO);
  for (const argv of [
    ["batch", "plan", csv, "-m", "gpt-image-2.5-2K"],
    ["batch", "run", csv, "-m", "gpt-image-2.5-2K", "--dry-run", "-o", join(dir, "out")],
    ["gen", "-m", "gpt-image-2.5-2K", "-p", "杯子", "--ref", join(dir, "refs", "a.png"), "--dry-run"],
  ]) {
    const { code, error, stdout } = await run(argv, { dir }); // 没给 server：任何联网都会 assert.fail
    assert.equal(error, null, String(error?.message));
    assert.equal(code, 0);
    assert.match(stdout, /没有联网/);
  }
  const { stdout } = await run(["batch", "plan", csv, "-m", "gpt-image-2.5-2K"], { dir });
  assert.match(stdout, /2 个商品，4 次提交，共 4 张/);
  assert.ok(!existsSync(join(dir, "out")), "试运行不应该建输出目录");
});

test("batch plan --estimate 用服务端估价（免费工具），不提交", async () => {
  const dir = workspace();
  const server = createServer();
  const { code, stdout } = await run(["batch", "plan", writeCsv(dir, TWO_BY_TWO), "-m", "gpt-image-2.5-2K", "--estimate"], {
    dir,
    server,
  });
  assert.equal(code, 0);
  assert.match(stdout, /gpt-image-2.5-2K × 4 张 = 0.20 点/);
  assert.match(stdout, /今天还能提交 97 次/);
  assert.equal(server.toolCalls("generate_image").length, 0);
  assert.equal(server.uploads, 0);
});

// ---------------------------------------------------------------------------
// 真跑（假服务端）：上传、提交、轮询、下载、花费清单
// ---------------------------------------------------------------------------

test("batch run：自动上传、提交、轮询、下载到 out/货号/图位.png，并写出花费清单", async () => {
  const dir = workspace();
  const server = createServer({ pollsUntilDone: 2 });
  const out = join(dir, "out");
  const { code, error, stdout, stderr } = await run(
    ["batch", "run", writeCsv(dir, TWO_BY_TWO), "-m", "gpt-image-2.5-2K", "-o", out, "--yes"],
    { dir, server },
  );
  assert.equal(error, null, String(error?.message));
  assert.equal(code, 0);

  // 参考图：两张不同的图各传一次（A001 与 B002 共用 a.png，只传一次）
  assert.equal(server.uploads, 2);
  const submits = server.toolCalls("generate_image").map((c) => c.args);
  assert.equal(submits.length, 4);
  const scene = submits.find((a) => a.options?.template_id === "scene");
  assert.equal(scene.options.aspect_ratio, "3:4", "没写比例时用模板自己的比例");
  assert.ok(scene.input_media.every((m) => m.type === "image_url" && m.value.startsWith("https://")));
  assert.equal(new Set(submits.map((a) => a.idempotency_key)).size, 4, "每个任务一个唯一编号");

  for (const file of ["A001/main_image.png", "A001/scene.png", "B002/main_image.png", "B002/scene.png"]) {
    assert.ok(existsSync(join(out, file)), file);
  }
  // 下载结果图绝不带钥匙
  assert.equal(server.downloads.length, 4);
  for (const d of server.downloads) assert.equal(d.headers.Authorization, undefined);

  const cost = readFileSync(join(out, "cost.csv"), "utf8");
  assert.ok(cost.startsWith("﻿"));
  assert.match(cost, /A001,scene,scene,gpt-image-2.5-2K,1,1,0.05,settled,完成/);
  assert.match(cost, /合计,,,,4,4,0.2,/);

  // 钥匙不出现在任何输出或落盘文件里
  const stateText = readFileSync(join(out, ".quriov", stateFiles(join(out, ".quriov"))[0]), "utf8");
  for (const text of [stdout, stderr, cost, stateText]) assert.ok(!text.includes(TEST_KEY));
  assert.match(stdout, /完成 4，失败 0/);

  // 进度行打印图的真实路径（绝对路径），不是看起来像相对当前目录的 ./A001/xxx.png
  const doneLines = stderr.split("\n").filter((line) => line.includes(" 完成 "));
  assert.equal(doneLines.length, 4);
  for (const line of doneLines) assert.ok(!/→ \.[\/]/.test(line), `进度行不该是 ./ 开头的相对路径：${line}`);
  assert.ok(stderr.includes(`→ ${join(out, "A001", "main_image.png")}`), stderr);
  assert.ok(stderr.includes(`→ ${join(out, "B002", "scene.png")}`), stderr);
});

test("resume：中断后接着跑，已提交的不重复提交，崩在「已发出、待确认」的用原编号重交，不重复扣钱", async () => {
  const dir = workspace();
  const server = createServer({ pollsUntilDone: 1 });
  const out = join(dir, "out");
  const csv = writeCsv(dir, TWO_BY_TWO);

  // 第一次：提交 2 个以后就中断（模拟 Ctrl+C）
  let stop = false;
  const first = await run(["batch", "run", csv, "-m", "gpt-image-2.5-2K", "-o", out, "--yes", "--concurrency", "2"], {
    dir,
    server,
    shouldStop: () => {
      if (server.toolCalls("generate_image").length >= 2) stop = true;
      return stop;
    },
  });
  assert.equal(first.error, null, String(first.error?.message));
  assert.equal(first.code, 4, "没跑完要返回 4（可续跑）");
  assert.match(first.stdout, /quriov batch resume/);
  assert.equal(server.toolCalls("generate_image").length, 2);

  // 再模拟一种更糟的中断：第 3 个任务已经发出去了，但回应还没落盘（状态停在「已发出、待确认」）
  const stateDir = join(out, ".quriov");
  const stateFile = join(stateDir, stateFiles(stateDir)[0]);
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const third = state.jobs[2];
  third.status = "submitting";
  third.idempotencyKey = `qcli-${state.batchId}-2-a1`;
  third.args = {
    model: third.model,
    prompt: third.prompt,
    idempotency_key: third.idempotencyKey,
    options: { aspect_ratio: "1:1", template_id: "main_image" },
  };
  writeFileSync(stateFile, JSON.stringify(state));
  server.tools.generate_image(third.args); // 服务端其实已经收下了

  // 这时看进度：发出去但没收到回应的任务不能算成「待提交」，要单独标「已发出、待确认」
  const midStatus = await run(["batch", "status", out], { dir });
  assert.equal(midStatus.error, null, String(midStatus.error?.message));
  assert.match(midStatus.stdout, /待提交 1 · 已发出、待确认 1 ·/);
  assert.match(midStatus.stdout, /resume 会用原任务编号重发确认，不会重复扣钱/);
  const midJson = JSON.parse((await run(["batch", "status", out, "--json"], { dir })).stdout);
  assert.equal(midJson.counts.submitting, 1);
  assert.equal(midJson.counts.pending, 1);
  const generationsBefore = server.generations.size;

  const second = await run(["batch", "resume", state.batchId], { dir, server });
  assert.equal(second.error, null, String(second.error?.message));
  assert.equal(second.code, 0);
  // 服务端总共只有 4 个生成任务：续跑没有给已提交的再开新任务
  assert.equal(generationsBefore, 3);
  assert.equal(server.generations.size, 4);
  const replay = server.toolCalls("generate_image").filter((c) => c.args.idempotency_key === third.idempotencyKey);
  assert.equal(replay.length, 1, "已发出、待确认的任务用原编号重交一次");
  for (const file of ["A001/main_image.png", "A001/scene.png", "B002/main_image.png", "B002/scene.png"]) {
    assert.ok(existsSync(join(out, file)), file);
  }
  const status = await run(["batch", "status", out], { dir });
  assert.match(status.stdout, /完成 4 · 失败 0/);
});

test("batch run：输出目录里已有批次时拒绝，提示用 resume", async () => {
  const dir = workspace();
  const server = createServer();
  const out = join(dir, "out");
  const csv = writeCsv(dir, TWO_BY_TWO);
  await run(["batch", "run", csv, "-m", "gpt-image-2.5-2K", "-o", out, "--yes"], { dir, server });
  const again = await run(["batch", "run", csv, "-m", "gpt-image-2.5-2K", "-o", out, "--yes"], { dir, server });
  assert.equal(again.error?.code, "out_dir_in_use");
  assert.match(again.error.message, /quriov batch resume/);
});

test("resume --retry-failed：失败的换新编号重交，成功的不动", async () => {
  const dir = workspace();
  let rejectScene = true;
  const server = createServer({
    onTool: (name, args) => {
      if (name === "generate_image" && rejectScene && args.options?.template_id === "scene") {
        return {
          structuredContent: { request_id: `r-${args.idempotency_key}`, request_status: "failed", status: "failed", error_code: "content_rejected", message: "x" },
          isError: false,
        };
      }
      return undefined;
    },
  });
  const out = join(dir, "out");
  const first = await run(["batch", "run", writeCsv(dir, TWO_BY_TWO), "-m", "gpt-image-2.5-2K", "-o", out, "--yes"], { dir, server });
  assert.equal(first.code, 3, "有失败返回 3");
  assert.match(first.stdout, /内容审核没通过/);
  const cost = readFileSync(join(out, "cost.csv"), "utf8");
  assert.match(cost, /A001,scene,scene,gpt-image-2.5-2K,1,0,,,失败/);

  rejectScene = false;
  const before = server.toolCalls("generate_image").length;
  const second = await run(["batch", "resume", out, "--retry-failed", "--yes"], { dir, server });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const retried = server.toolCalls("generate_image").slice(before);
  assert.equal(retried.length, 2, "只重交失败的两个");
  assert.ok(retried.every((c) => c.args.idempotency_key.endsWith("-a2")));
});

// ---------------------------------------------------------------------------
// 报错要说清真实原因
// ---------------------------------------------------------------------------

test("401：只当钥匙问题，带上服务端的中文原因和请求编号，不重试、不等", async () => {
  const dir = workspace();
  let calls = 0;
  const server = createServer({
    onHttp: () => {
      calls += 1;
      return new Response(JSON.stringify({ detail: "钥匙已过期。请到网页新建一把。", code: "access_key_expired", request_id: "req-401-abc" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const { error, clock } = await run(["account"], { dir, server });
  assert.equal(error.code, "unauthorized");
  assert.match(error.message, /钥匙已过期。请到网页新建一把。/);
  assert.match(error.message, /请求编号 req-401-abc/);
  assert.match(error.message, /正在用环境变量 QURIOV_MCP_ACCESS_KEY 的钥匙/);
  assert.doesNotMatch(error.message, /API 调用|限流/);
  assert.ok(!error.message.includes(TEST_KEY));
  assert.equal(calls, 1, "401 不重试");
  assert.deepEqual(clock.slept, [], "401 不等");
});

test("503：按 Retry-After 等了再试；别的 5xx 不重试，报请求编号", async () => {
  const dir = workspace();
  let failures = 1;
  const server = createServer({
    onHttp: (url, init) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      if (body?.params?.name === "get_account" && failures > 0) {
        failures -= 1;
        return new Response("{}", { status: 503, headers: { "retry-after": "7" } });
      }
      return undefined;
    },
  });
  const ok = await run(["account"], { dir, server });
  assert.equal(ok.error, null, String(ok.error?.message));
  assert.equal(ok.code, 0);
  assert.ok(ok.clock.slept.includes(7_000));

  let calls = 0;
  const broken = createServer({
    onHttp: () => {
      calls += 1;
      return new Response(JSON.stringify({ detail: "internal server error", request_id: "req-500-xyz" }), { status: 500 });
    },
  });
  const bad = await run(["account"], { dir, server: broken });
  assert.equal(bad.error.code, "server_error");
  assert.match(bad.error.message, /请求编号 req-500-xyz/);
  assert.equal(calls, 1, "500 不重试");
});

test("account：服务端不再返回额度（quota: null）时不显示额度那行", async () => {
  const dir = workspace();
  const server = createServer({
    onTool: (name) => (name === "get_account" ? { structuredContent: { balance: "12.5", wallet_type: "personal", quota: null }, isError: false } : undefined),
  });
  const { code, stdout } = await run(["account"], { dir, server });
  assert.equal(code, 0);
  assert.match(stdout, /余额：12.5 点/);
  assert.doesNotMatch(stdout, /还能提交|null/);
});

test("被网站防火墙拦（Cloudflare 1010）：明说不是钥匙问题", async () => {
  const dir = workspace();
  const server = createServer({ onHttp: () => new Response("error code: 1010", { status: 403 }) });
  const { error } = await run(["account"], { dir, server });
  assert.equal(error.code, "blocked_by_firewall");
  assert.match(error.message, /不是钥匙问题/);
});

test("模板编号写错：联网校验时就拦下，一张都不提交", async () => {
  const dir = workspace();
  const server = createServer();
  const csv = writeCsv(dir, "sku,templates,prompt\nA,amazon_main,杯子\n");
  const { error } = await run(["batch", "run", csv, "-m", "gpt-image-2.5-2K", "-o", join(dir, "out"), "--yes"], { dir, server });
  assert.equal(error.code, "invalid_spec");
  assert.match(error.message, /模板 amazon_main 不存在/);
  assert.equal(server.toolCalls("generate_image").length, 0);
});

test("模型下架 / 写错：联网校验时就拦下并列出能用的", async () => {
  const dir = workspace();
  const server = createServer();
  const { error } = await run(["gen", "-m", "no-such-model", "-p", "杯子", "--yes", "-o", join(dir, "o")], { dir, server });
  assert.equal(error.code, "invalid_spec");
  assert.match(error.message, /no-such-model 现在不能出图.*gpt-image-2.5-2K/);
});

for (const [old, replacement] of [
  ["gpt-image-2", "gpt-image-2.5-1K"],
  ["gpt-image-2-2K", "gpt-image-2.5-2K"],
  ["gpt-image-2-4K", "gpt-image-2.5-4K"],
]) {
  test(`已停用的 Image 2（${old}）：点名改用 ${replacement}，一张都不提交`, async () => {
    const dir = workspace();
    const server = createServer();
    const { error } = await run(["gen", "-m", old, "-p", "杯子", "--yes", "-o", join(dir, "o")], { dir, server });
    assert.equal(error.code, "invalid_spec");
    assert.ok(error.message.includes(`模型 ${old}（Image 2）已停用，请改用同档的 ${replacement}`), error.message);
    assert.equal(server.toolCalls("generate_image").length, 0);
  });
}

test("服务端回 retired_model 时也有中文说明", async () => {
  const { describeError } = await import("../lib/common.mjs");
  assert.match(describeError("retired_model"), /gpt-image-2-2K → gpt-image-2.5-2K/);
});

test("服务端拒绝某一个任务：只这一个失败，原因翻成中文，其余照跑", async () => {
  const dir = workspace();
  const server = createServer({
    onTool: (name, args) =>
      name === "generate_image" && args.options?.template_id === "scene" && args.prompt === "蓝色水杯"
        ? toolError("too_many_media")
        : undefined,
  });
  const out = join(dir, "out");
  const { code, stdout } = await run(["batch", "run", writeCsv(dir, TWO_BY_TWO), "-m", "gpt-image-2.5-2K", "-o", out, "--yes"], {
    dir,
    server,
  });
  assert.equal(code, 3);
  assert.match(stdout, /完成 3，失败 1/);
  assert.match(stdout, /参考图张数超过这个模型的上限/);
});

test("参考图上传被拒（不是真图片）：说清按内容判断", async () => {
  const dir = workspace();
  const client = new QuriovClient({
    key: TEST_KEY,
    fetchImpl: async () => new Response("{}", { status: 415 }),
    sleep: async () => {},
  });
  await assert.rejects(client.upload(join(dir, "refs", "a.png")), (e) => e.code === "unsupported_media_format" && /改扩展名没用/.test(e.message));
});

function piped(text) {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
}

async function runSetup(argv, { dir, server, home, stdinText = `${TEST_KEY}\n`, extraEnv = {} }) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, {
    env: { XDG_CONFIG_HOME: join(dir, "config"), ...extraEnv },
    stdout,
    stderr,
    stdin: piped(stdinText),
    home,
    platform: "linux",
    fetchImpl: server.fetch,
    sleep: async () => {},
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

// ---------------------------------------------------------------------------
// setup / doctor / uninstall（全部在假的用户目录里）
// ---------------------------------------------------------------------------

test("setup：钥匙先验证再保存；没通过就什么都不写", async () => {
  const dir = workspace();
  const home = fakeHome(dir);
  mkdirSync(join(home, ".claude"));
  const bad = createServer({ onHttp: () => new Response("{}", { status: 401 }) });
  await assert.rejects(runSetup(["setup", "--key-stdin"], { dir, server: bad, home }), (e) => e.code === "unauthorized");
  assert.ok(!existsSync(join(dir, "config", "quriov", "credentials.json")));
  assert.ok(!existsSync(join(home, ".claude.json")));
  assert.ok(!existsSync(join(home, ".claude", "skills", "quriov")));
});

test("setup：钥匙格式不对（有空格、引号）直接拒绝，不联网", async () => {
  const dir = workspace();
  const server = createServer({ onHttp: () => assert.fail("不应该联网") });
  await assert.rejects(
    runSetup(["setup", "--key-stdin"], { dir, server, home: fakeHome(dir), stdinText: 'abc" def-ghijklmnopqrst' }),
    (e) => e.code === "invalid_key_format",
  );
});

test("setup：三个客户端都写好、保留别的配置、装技能、自检全过；uninstall 全部清掉", async () => {
  const dir = workspace();
  const home = fakeHome(dir);
  // Claude Code：已有别的 MCP 和一堆无关设置
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { other: { type: "stdio", command: "x" } } }));
  // Codex：已有别的设置、别的 MCP，还有旧版装的 quriov（环境变量写法 + 子表）
  mkdirSync(join(home, ".codex"));
  writeFileSync(
    join(home, ".codex", "config.toml"),
    [
      'model = "gpt-5"',
      "",
      "[mcp_servers.other]",
      'command = "npx"',
      "",
      "[mcp_servers.quriov]",
      'url = "https://quriovai.com/mcp/v1"',
      'bearer_token_env_var = "QURIOV_MCP_ACCESS_KEY"',
      "",
      "[mcp_servers.quriov.env_http_headers]",
      'X = "Y"',
      "",
      '[projects."/tmp/x"]',
      'trust_level = "trusted"',
      "",
    ].join("\n"),
  );
  // Cursor：目录在、配置文件还没有
  mkdirSync(join(home, ".cursor"));
  const server = createServer();

  const { code, stdout } = await runSetup(["setup", "--key-stdin"], { dir, server, home });
  assert.equal(code, 0, stdout);
  assert.ok(!stdout.includes(TEST_KEY), "输出里不能有钥匙");
  assert.match(stdout, /全部通过/);
  assert.match(stdout, /\[通过\] MCP 连得上、核心工具齐全/);

  const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.equal(claude.numStartups, 3);
  assert.deepEqual(claude.mcpServers.other, { type: "stdio", command: "x" });
  assert.deepEqual(claude.mcpServers.quriov, {
    type: "http",
    url: MCP_ENDPOINT,
    headers: { Authorization: `Bearer ${TEST_KEY}` },
  });

  const codex = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.match(codex, /^model = "gpt-5"$/m);
  assert.match(codex, /\[mcp_servers\.other\]\ncommand = "npx"/);
  assert.match(codex, /\[projects\."\/tmp\/x"\]\ntrust_level = "trusted"/);
  assert.doesNotMatch(codex, /bearer_token_env_var|env_http_headers/, "旧版 quriov 整段（含子表）被替换");
  assert.equal(codex.match(/\[mcp_servers\.quriov\]/g).length, 1);
  assert.ok(codex.includes(`http_headers = { Authorization = "Bearer ${TEST_KEY}" }`));

  const cursor = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(cursor.mcpServers.quriov, { url: MCP_ENDPOINT, headers: { Authorization: `Bearer ${TEST_KEY}` } });

  for (const skills of [join(home, ".claude", "skills"), join(home, ".agents", "skills")]) {
    const text = readFileSync(join(skills, "quriov", "SKILL.md"), "utf8");
    assert.match(text, /^---\r?\nname: quriov$/m);
  }
  if (process.platform !== "win32") {
    for (const file of [join(home, ".claude.json"), join(home, ".codex", "config.toml"), join(dir, "config", "quriov", "credentials.json")]) {
      assert.equal(statSync(file).mode & 0o777, 0o600, `${file} 里有钥匙，要仅本人可读写`);
    }
  }

  // 再跑一次：幂等，不会写出第二份
  await runSetup(["setup", "--key-stdin"], { dir, server, home });
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8").match(/\[mcp_servers\.quriov\]/g).length, 1);

  // doctor：只读，四项全过
  const doctor = await runSetup(["doctor"], { dir, server, home });
  assert.equal(doctor.code, 0, doctor.stdout);
  assert.equal(doctor.stdout.trim().split("\n").length, 4);
  assert.ok(!doctor.stdout.includes(TEST_KEY));

  // uninstall：只删 quriov 那一项、技能和保存的钥匙，别的原样
  const un = await runSetup(["uninstall"], { dir, server, home });
  assert.equal(un.code, 0);
  const claudeAfter = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
  assert.equal(claudeAfter.mcpServers.quriov, undefined);
  assert.deepEqual(claudeAfter.mcpServers.other, { type: "stdio", command: "x" });
  const codexAfter = readFileSync(join(home, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(codexAfter, /quriov/);
  assert.match(codexAfter, /\[mcp_servers\.other\]/);
  assert.equal(JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).mcpServers.quriov, undefined);
  assert.ok(!existsSync(join(home, ".claude", "skills", "quriov")));
  assert.ok(!existsSync(join(home, ".agents", "skills", "quriov")));
  assert.ok(!existsSync(join(dir, "config", "quriov", "credentials.json")));
});

test("setup：配置文件解析不了就跳过这个客户端、原样不动，自检报出来", async () => {
  const dir = workspace();
  const home = fakeHome(dir);
  const broken = "{ this is not json";
  writeFileSync(join(home, ".claude.json"), broken);
  mkdirSync(join(home, ".codex"));
  const inline = 'mcp_servers.quriov = { url = "x" }\n';
  writeFileSync(join(home, ".codex", "config.toml"), inline);
  const server = createServer();
  const { code, stdout } = await runSetup(["setup", "--key-stdin"], { dir, server, home });
  assert.equal(code, 1);
  assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), broken);
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), inline);
  assert.match(stdout, /Claude Code：没改（文件不是合法的 JSON）/);
  assert.match(stdout, /Codex：没改（quriov 是用行内写法定义的，不能安全替换）/);
  assert.match(stdout, /\[没过\] 客户端配置正确/);
});

test("setup --dry-run：不联网、不写任何文件，只列出会改哪些", async () => {
  const dir = workspace();
  const home = fakeHome(dir);
  mkdirSync(join(home, ".claude"));
  const server = createServer({ onHttp: () => assert.fail("不应该联网") });
  const { code, stdout } = await runSetup(["setup", "--dry-run"], { dir, server, home, stdinText: "" });
  assert.equal(code, 0);
  assert.match(stdout, /Claude Code：写入 MCP「quriov」/);
  assert.match(stdout, /Codex：本机没发现，跳过/);
  assert.ok(!existsSync(join(home, ".claude.json")));
  assert.ok(!existsSync(join(home, ".claude", "skills", "quriov")));
  assert.ok(!existsSync(join(dir, "config", "quriov", "credentials.json")));
});

test("setup：没输入新钥匙时沿用已保存的（升级重跑用）；--client 只配指定的客户端", async () => {
  const dir = workspace();
  const home = fakeHome(dir);
  const server = createServer();
  await runSetup(["setup", "--key-stdin", "--client", "cursor"], { dir, server, home });
  assert.ok(existsSync(join(home, ".cursor", "mcp.json")), "指名的客户端没检测到也照配");
  assert.ok(!existsSync(join(home, ".claude.json")));
  const again = await runSetup(["setup", "--key-stdin", "--client", "cursor"], { dir, server, home, stdinText: "" });
  assert.equal(again.code, 0, again.stdout);
  assert.match(again.stdout, /沿用quriov setup 保存的钥匙/);
  await assert.rejects(runSetup(["setup", "--client", "vscode"], { dir, server, home }), (e) => e.code === "usage");
});

test("setup：技能目录是软链到同一处时只装一份（比如 ~/.agents/skills → ~/.claude/skills）", { skip: process.platform === "win32" }, async () => {
  const dir = workspace();
  const home = fakeHome(dir);
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".agents"));
  symlinkSync("../.claude/skills", join(home, ".agents", "skills"));
  const server = createServer();
  const { code, stdout } = await runSetup(["setup", "--key-stdin"], { dir, server, home });
  assert.equal(code, 0, stdout);
  assert.equal(stdout.match(/技能（/g).length, 1);
  assert.match(stdout, /技能（Claude Code、Codex）/);
});

test("doctor：服务端少了核心工具才算没过；多了新工具照样通过", async () => {
  const dir = workspace();
  const home = fakeHome(dir);
  const server = createServer({
    onHttp: (url, init) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      if (body?.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "get_account" }, { name: "list_capabilities" }] } });
      }
      return undefined;
    },
  });
  const { code, stdout } = await runSetup(["doctor"], { dir, server, home, extraEnv: { QURIOV_API_KEY: TEST_KEY } });
  assert.equal(code, 1);
  assert.match(stdout, /缺少：estimate_cost、generate_image/);
});

test("upload：打印链接给 MCP 用，不打印钥匙", async () => {
  const dir = workspace();
  const server = createServer();
  const { code, stdout, stderr } = await run(["upload", join(dir, "refs", "a.png")], { dir, server });
  assert.equal(code, 0);
  assert.match(stdout, /https:\/\/oss\.example\.test\/mcp-refs\/1\.png/);
  assert.match(stderr, /input_media/);
  assert.ok(!stdout.includes(TEST_KEY) && !stderr.includes(TEST_KEY));
});

test("非交互环境要花钱却没加 --yes：拒绝并说明", async () => {
  const dir = workspace();
  const server = createServer();
  const { error } = await run(["gen", "-m", "gpt-image-2.5-2K", "-p", "杯子", "-o", join(dir, "o")], { dir, server });
  assert.equal(error.code, "needs_confirmation");
  assert.equal(server.toolCalls("generate_image").length, 0);
});

test("下载失败（链接过期等）：下一轮重新取链接再下，不重复提交", async () => {
  const dir = workspace();
  const server = createServer();
  let failFirstDownload = true;
  const baseFetch = server.fetch;
  server.fetch = async (url, init) => {
    if (typeof url === "string" && url.startsWith("https://oss.example.test/mcp-out/") && failFirstDownload) {
      failFirstDownload = false;
      return new Response("expired", { status: 403 });
    }
    return baseFetch(url, init);
  };
  const out = join(dir, "out");
  const csv = writeCsv(dir, "sku,templates,prompt\nA,main_image,杯子\n");
  const { code, stderr } = await run(["batch", "run", csv, "-m", "gpt-image-2.5-2K", "-o", out, "--yes"], { dir, server });
  assert.equal(code, 0);
  assert.match(stderr, /下载失败（第 1 次）/);
  assert.ok(existsSync(join(out, "A", "main_image.png")));
  assert.equal(server.toolCalls("generate_image").length, 1);
});

test("gen：一次出 2 张带参考图，文件和花费清单落到输出目录", async () => {
  const dir = workspace();
  const server = createServer();
  const out = join(dir, "gen-out");
  const { code, error } = await run(
    ["gen", "-m", "gpt-image-2.5-2K", "-p", "白底主图", "--ref", join(dir, "refs", "a.png"), "-n", "2", "-o", out, "--yes"],
    { dir, server },
  );
  assert.equal(error, null, String(error?.message));
  assert.equal(code, 0);
  const [call] = server.toolCalls("generate_image");
  assert.equal(call.args.options.batch_size, 2);
  assert.equal(call.args.input_media.length, 1);
  const files = readdirSync(out);
  assert.equal(files.filter((f) => f.endsWith(".png")).length, 2);
  const costFile = files.find((f) => f.startsWith("cost-") && f.endsWith(".csv"));
  assert.match(readFileSync(join(out, costFile), "utf8"), /gen,image,,gpt-image-2.5-2K,2,2,0.10,settled,完成/);
});

// ---------------------------------------------------------------------------
// 钥匙从哪来（宇通 09-28 实撞：shell 里的旧环境变量 QURIOV_ACCESS_KEY 盖掉了刚 login 存下的钥匙）
// ---------------------------------------------------------------------------

const STALE_KEY = "stale-old-key-from-shell-0000";

// 真服务端的样子：旧钥匙一律 401，好钥匙交给假服务端照常处理。
function rejectingStale(server) {
  return async (url, init = {}) => {
    if (init.headers?.Authorization === `Bearer ${STALE_KEY}`) return new Response('{"error":"invalid_token"}', { status: 401 });
    return server.fetch(url, init);
  };
}

function saveTestKey(dir) {
  mkdirSync(join(dir, "config", "quriov"), { recursive: true });
  writeFileSync(join(dir, "config", "quriov", "credentials.json"), JSON.stringify({ key: TEST_KEY }));
}

async function runWith(argv, { dir, fetchImpl, envVars }) {
  const stdout = sink();
  const stderr = sink();
  let code;
  let error = null;
  try {
    code = await main(argv, {
      env: { XDG_CONFIG_HOME: join(dir, "config"), ...envVars },
      stdout,
      stderr,
      stdin: { isTTY: false },
      home: fakeHome(dir),
      platform: "linux",
      fetchImpl,
      sleep: async () => {},
    });
  } catch (e) {
    error = e;
  }
  return { code, error, stdout: stdout.text, stderr: stderr.text };
}

test("钥匙优先级：QURIOV_API_KEY > setup 保存的 > 旧名字；旧名字不能盖过刚保存的", () => {
  const saved = () => JSON.stringify({ key: "saved" });
  assert.equal(resolveKey({ env: { QURIOV_ACCESS_KEY: "legacy" }, readFile: saved, path: "/x" }).key, "saved");
  assert.equal(resolveKey({ env: { QURIOV_MCP_ACCESS_KEY: "legacy" }, readFile: saved, path: "/x" }).source, "quriov setup 保存的钥匙");
  assert.equal(resolveKey({ env: { QURIOV_API_KEY: "primary", QURIOV_ACCESS_KEY: "legacy" }, readFile: saved, path: "/x" }).key, "primary");
  const all = resolveKeys({ env: { QURIOV_API_KEY: "p", QURIOV_MCP_KEY: "l", QURIOV_ACCESS_KEY: "saved" }, readFile: saved, path: "/x" });
  assert.deepEqual(
    all.map((k) => k.source),
    ["环境变量 QURIOV_API_KEY 的钥匙", "quriov setup 保存的钥匙", "环境变量 QURIOV_MCP_KEY 的钥匙"],
    "按优先级排，重复的钥匙只留一份",
  );
});

test("旧环境变量里是失效钥匙、本机存着好钥匙：直接用好钥匙，account 说清用的是哪一把", async () => {
  const dir = workspace();
  saveTestKey(dir);
  const server = createServer();
  const { code, error, stdout } = await runWith(["account"], {
    dir,
    fetchImpl: rejectingStale(server),
    envVars: { QURIOV_ACCESS_KEY: STALE_KEY },
  });
  assert.equal(error, null, String(error?.message));
  assert.equal(code, 0);
  assert.match(stdout, /正在用quriov setup 保存的钥匙/);
  assert.ok(!stdout.includes(TEST_KEY) && !stdout.includes(STALE_KEY));
});

test("QURIOV_API_KEY 里的钥匙被拒、本机存着好钥匙：自动换用一次，并提醒删掉那个环境变量", async () => {
  const dir = workspace();
  saveTestKey(dir);
  const server = createServer();
  const { code, error, stdout, stderr } = await runWith(["account"], {
    dir,
    fetchImpl: rejectingStale(server),
    envVars: { QURIOV_API_KEY: STALE_KEY },
  });
  assert.equal(error, null, String(error?.message));
  assert.equal(code, 0);
  assert.match(stdout, /正在用quriov setup 保存的钥匙/);
  assert.match(stderr, /环境变量 QURIOV_API_KEY 里的钥匙没通过验证/);
  assert.match(stderr, /删掉 QURIOV_API_KEY/);
  assert.ok(!stderr.includes(TEST_KEY) && !stderr.includes(STALE_KEY));
});

test("钥匙没通过验证：报错说清是哪个来源的钥匙（不打印钥匙）", async () => {
  const dir = workspace();
  const server = createServer();
  const { error } = await runWith(["account"], {
    dir,
    fetchImpl: rejectingStale(server),
    envVars: { QURIOV_MCP_ACCESS_KEY: STALE_KEY },
  });
  assert.equal(error?.code, "unauthorized");
  assert.match(error.message, /正在用环境变量 QURIOV_MCP_ACCESS_KEY 的钥匙/);
  assert.match(error.message, /旧的环境变量/);
  assert.ok(!error.message.includes(STALE_KEY));
});

test("doctor：第一行说清用的是哪把钥匙；换用过备选钥匙时提醒删环境变量", async () => {
  const dir = workspace();
  saveTestKey(dir);
  const server = createServer();
  const { code, stdout, stderr } = await runWith(["doctor"], {
    dir,
    fetchImpl: rejectingStale(server),
    envVars: { QURIOV_API_KEY: STALE_KEY },
  });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /\[通过\] 钥匙可用（正在用quriov setup 保存的钥匙）/);
  assert.match(stderr, /删掉 QURIOV_API_KEY/);
});

test("doctor：任何失败都给中文原因，不甩出看不懂的异常", async () => {
  const dir = workspace();
  const server = createServer();
  // 钥匙不对：不抛异常，逐项说原因
  const bad = await runWith(["doctor"], { dir, fetchImpl: rejectingStale(server), envVars: { QURIOV_API_KEY: STALE_KEY } });
  assert.equal(bad.error, null, String(bad.error?.message));
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /\[没过\] 钥匙可用：钥匙没通过验证（HTTP 401）（正在用环境变量 QURIOV_API_KEY 的钥匙）/);
  assert.match(bad.stdout, /\[没过\] MCP 连得上、核心工具齐全：钥匙没通过，没法检查/);
  // 意外异常（不是命令行自己的报错）：翻成一句中文，不冒英文堆栈
  const weird = await runWith(["doctor"], {
    dir,
    envVars: { QURIOV_API_KEY: TEST_KEY },
    fetchImpl: async (url, init) => {
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      if (body?.method === "tools/list") {
        return { ok: true, status: 200, headers: new Headers(), text: async () => { throw new TypeError("boom"); } };
      }
      return server.fetch(url, init);
    },
  });
  assert.equal(weird.error, null, String(weird.error?.message));
  assert.equal(weird.code, 1);
  assert.match(weird.stdout, /\[没过\] MCP 连得上、核心工具齐全：命令行内部出错（TypeError）/);
  assert.doesNotMatch(weird.stdout, /boom|DoctorError/);
});
