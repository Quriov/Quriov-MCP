// quriov update 与「有新版」自动提示。网络全部是假的：绝不真去连 GitHub，也绝不真跑 npm。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { VERSION, main } from "../bin/quriov.mjs";
import {
  LATEST_DOWNLOAD_URL,
  LATEST_RELEASE_API,
  compareVersions,
  detectInstallPrefix,
  manualInstallCommand,
  parseVersion,
} from "../lib/update.mjs";
import { SKILL_SOURCE } from "../lib/setup.mjs";

const NEWER = "99.0.0";
const TARBALL = new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4]); // 假的安装包内容
const UNIX_PREFIX = "/usr/local";
const UNIX_ROOT = `${UNIX_PREFIX}/lib/node_modules/quriov`;

function sink() {
  const s = { text: "" };
  s.write = (chunk) => {
    s.text += chunk;
    return true;
  };
  return s;
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "quriov-update-test-"));
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "tmp"), { recursive: true });
  return dir;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

// 假 GitHub：发布页接口 + 安装包下载。记下每次请求，好检查只连了本仓发布页、没带钥匙。
function fakeGitHub({ latest = NEWER, assetUrl, releaseStatus = 200, downloadStatus = 200, offline = false, hang = false } = {}) {
  const gh = { calls: [] };
  gh.fetch = async (url, init = {}) => {
    gh.calls.push({ url: String(url), headers: init.headers ?? {} });
    if (hang) {
      return new Promise((_, fail) => init.signal?.addEventListener("abort", () => fail(new Error("aborted"))));
    }
    if (offline) throw new TypeError("fetch failed");
    if (url === LATEST_RELEASE_API) {
      if (releaseStatus !== 200) return jsonResponse({ message: "nope" }, releaseStatus);
      const tag = `v${latest}`;
      return jsonResponse({
        tag_name: tag,
        assets: [
          { name: `quriov-${latest}.tgz`, browser_download_url: `https://github.com/Quriov/Quriov-MCP/releases/download/${tag}/quriov-${latest}.tgz` },
          { name: "quriov.tgz", browser_download_url: assetUrl ?? `https://github.com/Quriov/Quriov-MCP/releases/download/${tag}/quriov.tgz` },
        ],
      });
    }
    if (String(url).startsWith("https://github.com/Quriov/Quriov-MCP/releases/download/")) {
      if (downloadStatus !== 200) return new Response("gone", { status: downloadStatus });
      return new Response(TARBALL, { status: 200 });
    }
    assert.fail(`不该连 ${url}`);
  };
  return gh;
}

// 假 npm：记下命令和参数，并确认那一刻安装包确实在临时目录里。
function fakeNpm({ code = 0, output = "", error = null } = {}) {
  const npm = { runs: [] };
  npm.run = async ({ command, args, platform }) => {
    const file = args[args.length - 1];
    npm.runs.push({ command, args, platform, fileExisted: existsSync(file), bytes: existsSync(file) ? readFileSync(file) : null });
    return { code, output, error };
  };
  return npm;
}

async function run(argv, { dir, gh, npm = fakeNpm(), env = {}, platform = "linux", packageRoot = UNIX_ROOT, now = () => Date.UTC(2026, 8, 29), updateCheck = false, updateTimeoutMs } = {}) {
  const stdout = sink();
  const stderr = sink();
  let code;
  let error = null;
  try {
    code = await main(argv, {
      env: { XDG_CONFIG_HOME: join(dir, "config"), APPDATA: join(dir, "config"), ...env },
      stdout,
      stderr,
      stdin: { isTTY: false },
      home: join(dir, "home"),
      platform,
      fetchImpl: gh ? gh.fetch : async () => assert.fail("不应该联网"),
      sleep: async () => {},
      now,
      packageRoot,
      tmpDir: join(dir, "tmp"),
      runNpm: npm.run,
      updateCheck,
      updateTimeoutMs,
    });
  } catch (e) {
    error = e;
  }
  return { code, error, stdout: stdout.text, stderr: stderr.text, npm };
}

function cacheFile(dir) {
  return join(dir, "config", "quriov", "update-check.json");
}

// 离线就能跑、只往 stdout 打 JSON 的命令：拿它来看自动提示有没有弄脏 stdout。
function planFixture(dir) {
  const file = join(dir, "items.csv");
  writeFileSync(file, "sku,templates,prompt,model\nA001,main_image,红色保温杯,some-model\n");
  return file;
}

// ---------------------------------------------------------------------------
// 版本号与安装前缀
// ---------------------------------------------------------------------------

test("版本号比较：按数字比，认 v 前缀", () => {
  assert.equal(parseVersion("v1.4.0"), "1.4.0");
  assert.equal(parseVersion("1.10.2"), "1.10.2");
  assert.equal(parseVersion("latest"), null);
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("v1.4.0", "1.4.1") < 0);
  assert.equal(compareVersions("v1.4.0", "1.4.0"), 0);
});

test("安装前缀：默认前缀、自定义 --prefix、Windows 都认；不是 npm -g 装的返回 null", () => {
  assert.equal(detectInstallPrefix("/usr/local/lib/node_modules/quriov", "linux"), "/usr/local");
  assert.equal(detectInstallPrefix("/home/u/.quriov-cli/lib/node_modules/quriov", "linux"), "/home/u/.quriov-cli");
  assert.equal(detectInstallPrefix("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\quriov", "win32"), "C:\\Users\\u\\AppData\\Roaming\\npm");
  assert.equal(detectInstallPrefix("/home/u/code/Quriov-MCP", "linux"), null);
  assert.equal(detectInstallPrefix("/home/u/.npm/_npx/abc/node_modules/quriov", "linux"), null);
  assert.equal(manualInstallCommand("x.tgz", { prefix: "/home/u/my prefix", platform: "linux" }), "npm install -g --prefix '/home/u/my prefix' x.tgz");
  assert.equal(manualInstallCommand("x.tgz", { prefix: "C:\\a b", platform: "win32" }), 'npm.cmd install -g --prefix "C:\\a b" x.tgz');
});

// ---------------------------------------------------------------------------
// quriov update：已最新 / 有新版 / 网络失败 / 自定义前缀
// ---------------------------------------------------------------------------

test("update：已是最新时只说一句「已是最新 vX」，不下载、不装", async () => {
  const dir = workspace();
  const gh = fakeGitHub({ latest: VERSION });
  const { code, stdout, npm } = await run(["update"], { dir, gh });
  assert.equal(code, 0);
  assert.equal(stdout.trim(), `已是最新 v${VERSION}`);
  assert.equal(npm.runs.length, 0);
  assert.equal(gh.calls.length, 1);
});

test("update：有新版时下载 quriov.tgz 到临时目录，用当前前缀 npm install -g，装完删掉临时文件", async () => {
  const dir = workspace();
  const gh = fakeGitHub();
  const { code, stdout, stderr, npm } = await run(["update"], { dir, gh });
  assert.equal(code, 0, stderr);
  assert.equal(npm.runs.length, 1);
  const [{ command, args, fileExisted, bytes }] = npm.runs;
  assert.equal(command, "npm");
  assert.deepEqual(args.slice(0, 4), ["install", "-g", "--prefix", UNIX_PREFIX]);
  assert.ok(args[4].startsWith(join(dir, "tmp")), "安装包下载到临时目录");
  assert.ok(args[4].endsWith("quriov.tgz"));
  assert.ok(fileExisted);
  assert.deepEqual(new Uint8Array(bytes), TARBALL);
  assert.ok(!existsSync(args[4]), "装好后临时文件删掉");
  assert.match(stdout, new RegExp(`已更新到 v${NEWER.replace(/\./g, "\\.")}（原来 v${VERSION.replace(/\./g, "\\.")}），装在 /usr/local。`));
  assert.match(stdout, /接着运行 quriov doctor/);
  assert.match(stderr, /发现新版 v99\.0\.0/);
  // 只连了本仓的发布页，而且没带钥匙
  assert.deepEqual(
    gh.calls.map((c) => c.url),
    [LATEST_RELEASE_API, "https://github.com/Quriov/Quriov-MCP/releases/download/v99.0.0/quriov.tgz"],
  );
  for (const call of gh.calls) assert.equal(call.headers.Authorization, undefined);
});

test("update：装在自定义前缀（npm install -g --prefix ~/.quriov-cli）时用同一个前缀装回去", async () => {
  const dir = workspace();
  const { code, npm, stdout } = await run(["update"], {
    dir,
    gh: fakeGitHub(),
    packageRoot: "/home/u/.quriov-cli/lib/node_modules/quriov",
  });
  assert.equal(code, 0);
  assert.deepEqual(npm.runs[0].args.slice(0, 4), ["install", "-g", "--prefix", "/home/u/.quriov-cli"]);
  assert.match(stdout, /装在 \/home\/u\/\.quriov-cli。/);
});

test("update：Windows 用 npm.cmd，前缀是 node_modules 的上一层", async () => {
  const dir = workspace();
  const { code, npm } = await run(["update"], {
    dir,
    gh: fakeGitHub(),
    platform: "win32",
    packageRoot: "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\quriov",
  });
  assert.equal(code, 0);
  assert.equal(npm.runs[0].command, "npm.cmd");
  assert.equal(npm.runs[0].platform, "win32");
  assert.deepEqual(npm.runs[0].args.slice(0, 4), ["install", "-g", "--prefix", "C:\\Users\\u\\AppData\\Roaming\\npm"]);
});

test("update：连不上 GitHub 时给一句能照做的中文说明（浏览器下载后 npm install -g <文件>）", async () => {
  const dir = workspace();
  const { error, npm } = await run(["update"], { dir, gh: fakeGitHub({ offline: true }) });
  assert.equal(error?.code, "update_check_failed");
  assert.equal(error.exitCode, 1);
  assert.match(error.message, /连不上 GitHub/);
  assert.ok(error.message.includes(`用浏览器打开 ${LATEST_DOWNLOAD_URL} 下载安装包`));
  assert.ok(error.message.includes("npm install -g --prefix /usr/local <下载的文件>"));
  assert.equal(npm.runs.length, 0);
});

test("update：查到新版但下载失败，同样给浏览器下载 + 手动安装的说明", async () => {
  const dir = workspace();
  const { error, npm } = await run(["update"], { dir, gh: fakeGitHub({ downloadStatus: 404 }) });
  assert.equal(error?.code, "update_download_failed");
  assert.match(error.message, /新版 v99\.0\.0 下载失败（HTTP 404/);
  assert.ok(error.message.includes("https://github.com/Quriov/Quriov-MCP/releases/download/v99.0.0/quriov.tgz"));
  assert.ok(error.message.includes("npm install -g --prefix /usr/local <下载的文件>"));
  assert.equal(npm.runs.length, 0);
});

test("update：npm 报 EACCES 时按安装说明改装到自己的目录，并留着已下载的安装包", async () => {
  const dir = workspace();
  const npm = fakeNpm({ code: 243, output: "npm error code EACCES\nnpm error syscall mkdir" });
  const { error } = await run(["update"], { dir, gh: fakeGitHub(), npm });
  assert.equal(error?.code, "update_install_failed");
  assert.match(error.message, /没有权限写 \/usr\/local（EACCES）/);
  assert.match(error.message, /npm install -g --prefix "\$HOME\/\.quriov-cli" /);
  assert.match(error.message, /"\$HOME\/\.quriov-cli\/bin\/quriov"/);
  assert.ok(error.message.includes("https://quriovai.com/install.md"));
  assert.ok(existsSync(npm.runs[0].args[4]), "装失败时留着安装包给人手动装");
});

test("update：发布页给的下载链接不是本仓发布页的就不用", async () => {
  const dir = workspace();
  const gh = fakeGitHub({ assetUrl: "https://evil.example.com/quriov.tgz" });
  const { code } = await run(["update"], { dir, gh });
  assert.equal(code, 0);
  assert.equal(gh.calls[1].url, "https://github.com/Quriov/Quriov-MCP/releases/download/v99.0.0/quriov.tgz");
});

test("update：不是 npm install -g 装的（从源码跑 / npx）不自动装，指向安装说明", async () => {
  const dir = workspace();
  const { error, npm } = await run(["update"], { dir, gh: fakeGitHub(), packageRoot: "/home/u/code/Quriov-MCP" });
  assert.equal(error?.code, "update_unsupported_install");
  assert.ok(error.message.includes("https://quriovai.com/install.md"));
  assert.equal(npm.runs.length, 0);
});

test("update：装好后把本机已装的技能同步成新版，没装过的客户端不新装", async () => {
  const dir = workspace();
  const home = join(dir, "home");
  const claudeSkill = join(home, ".claude", "skills", "quriov", "SKILL.md");
  mkdirSync(join(home, ".claude", "skills", "quriov"), { recursive: true });
  writeFileSync(claudeSkill, "---\nname: quriov\n---\n旧版技能\n");
  const { code, stdout } = await run(["update"], { dir, gh: fakeGitHub() });
  assert.equal(code, 0);
  assert.equal(readFileSync(claudeSkill, "utf8"), readFileSync(SKILL_SOURCE, "utf8"));
  assert.ok(!existsSync(join(home, ".agents", "skills", "quriov")), "Codex 的技能目录没装过就不新装");
  assert.match(stdout, /技能已同步成新版/);
});

test("update --json：给 AI 读的结果", async () => {
  const dir = workspace();
  const { code, stdout } = await run(["update", "--json"], { dir, gh: fakeGitHub({ latest: VERSION }) });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { updated: false, current: VERSION, latest: VERSION, message: `已是最新 v${VERSION}` });
});

// ---------------------------------------------------------------------------
// 自动提示：只写 stderr、24 小时一次、可关、失败静默
// ---------------------------------------------------------------------------

test("自动检查：有新版时只在 stderr 提示一行，stdout 原样（--json 输出照样能解析）", async () => {
  const dir = workspace();
  const spec = planFixture(dir);
  const plain = await run(["batch", "plan", spec, "--json"], { dir });
  const withCheck = await run(["batch", "plan", spec, "--json"], { dir, gh: fakeGitHub(), updateCheck: true });
  assert.equal(withCheck.code, 0);
  assert.equal(withCheck.stdout, plain.stdout, "stdout 一个字都不变");
  JSON.parse(withCheck.stdout);
  assert.doesNotMatch(withCheck.stdout, /新版/);
  assert.equal(withCheck.stderr, `quriov 有新版 v${NEWER}（当前 v${VERSION}），运行 quriov update 升级\n`);
});

test("自动检查：24 小时内只查一次，结果缓存在配置目录；过了 24 小时再查", async () => {
  const dir = workspace();
  const spec = planFixture(dir);
  const gh = fakeGitHub();
  let t = Date.UTC(2026, 8, 29, 8, 0, 0);
  const now = () => t;
  await run(["batch", "plan", spec], { dir, gh, now, updateCheck: true });
  assert.equal(gh.calls.length, 1);
  const cache = JSON.parse(readFileSync(cacheFile(dir), "utf8"));
  assert.equal(cache.latest, NEWER);
  assert.equal(cache.checkedAt, new Date(t).toISOString());

  t += 23 * 3600 * 1000;
  const second = await run(["batch", "plan", spec], { dir, gh, now, updateCheck: true });
  assert.equal(gh.calls.length, 1, "24 小时内不再联网");
  assert.match(second.stderr, /quriov 有新版 v99\.0\.0/, "用缓存里的结果照样提示");

  t += 2 * 3600 * 1000;
  await run(["batch", "plan", spec], { dir, gh, now, updateCheck: true });
  assert.equal(gh.calls.length, 2, "过了 24 小时再查一次");
});

test("自动检查：QURIOV_NO_UPDATE_CHECK=1 时完全不联网、不提示", async () => {
  const dir = workspace();
  const spec = planFixture(dir);
  const gh = fakeGitHub();
  const { code, stderr } = await run(["batch", "plan", spec], { dir, gh, updateCheck: true, env: { QURIOV_NO_UPDATE_CHECK: "1" } });
  assert.equal(code, 0);
  assert.equal(gh.calls.length, 0);
  assert.equal(stderr, "");
  assert.ok(!existsSync(cacheFile(dir)));
});

test("自动检查：网络失败静默，命令照常；记下查过，24 小时内不再每条命令都等", async () => {
  const dir = workspace();
  const spec = planFixture(dir);
  const gh = fakeGitHub({ offline: true });
  const { code, stderr, error } = await run(["batch", "plan", spec], { dir, gh, updateCheck: true });
  assert.equal(error, null);
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.equal(gh.calls.length, 1);
  await run(["batch", "plan", spec], { dir, gh, updateCheck: true });
  assert.equal(gh.calls.length, 1);
  // GitHub 回 403（限流）一样静默
  const dir2 = workspace();
  const limited = await run(["batch", "plan", planFixture(dir2)], { dir: dir2, gh: fakeGitHub({ releaseStatus: 403 }), updateCheck: true });
  assert.equal(limited.code, 0);
  assert.equal(limited.stderr, "");
});

test("自动检查：GitHub 一直不回应时到点就放弃（不卡住命令），也不出声", async () => {
  const dir = workspace();
  const spec = planFixture(dir);
  const started = Date.now();
  const { code, stderr } = await run(["batch", "plan", spec], { dir, gh: fakeGitHub({ hang: true }), updateCheck: true, updateTimeoutMs: 50 });
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.ok(Date.now() - started < 1500, "最多等到时限");
});

test("自动检查：已是最新时什么都不打；--version / update / doctor 不走自动提示", async () => {
  const dir = workspace();
  const spec = planFixture(dir);
  const same = await run(["batch", "plan", spec], { dir, gh: fakeGitHub({ latest: VERSION }), updateCheck: true });
  assert.equal(same.stderr, "");
  const dir2 = workspace();
  const gh = fakeGitHub();
  const version = await run(["--version"], { dir: dir2, gh, updateCheck: true });
  assert.equal(version.stdout.trim(), VERSION);
  assert.equal(version.stderr, "");
  assert.equal(gh.calls.length, 0);
});

test("自动检查：命令出错时也不影响报错本身", async () => {
  const dir = workspace();
  const { error, stderr } = await run(["batch", "plan", join(dir, "missing.csv")], { dir, gh: fakeGitHub(), updateCheck: true });
  assert.equal(error?.code, "spec_missing");
  assert.match(stderr, /quriov 有新版/);
});
