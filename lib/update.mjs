// 更新：quriov update、每 24 小时一次的「有新版」提示、doctor 里的版本项。
//
// 边界（见 AGENTS.md）：
// - 只连 GitHub 上本仓的发布页：api.github.com 查最新版、github.com 下载 quriov.tgz。不带钥匙。
// - 自动提示只写 stderr，stdout 一个字都不动（批量出图的输出要能被程序解析）；
//   查不到、超时一律不出声；环境变量 QURIOV_NO_UPDATE_CHECK=1 整个关掉。
// - 升级 = 下载安装包到临时目录，再用「当前这份 quriov 所在的 npm 前缀」npm install -g 它；
//   装在自定义 --prefix 的人升级后还在原处，不会装出第二份。

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError, INSTALL_DOC_URL, USER_AGENT, VERSION, writeAtomic } from "./common.mjs";

export const RELEASE_REPO = "Quriov/Quriov-MCP";
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
export const RELEASE_DOWNLOAD_PREFIX = `https://github.com/${RELEASE_REPO}/releases/download/`;
export const LATEST_DOWNLOAD_URL = `https://github.com/${RELEASE_REPO}/releases/latest/download/quriov.tgz`;
export const ASSET_NAME = "quriov.tgz";
export const NO_UPDATE_CHECK_ENV = "QURIOV_NO_UPDATE_CHECK";
export const CHECK_INTERVAL_MS = 24 * 3600 * 1000;
export const AUTO_CHECK_TIMEOUT_MS = 2000; // 自动检查最多等 2 秒
export const DOCTOR_CHECK_TIMEOUT_MS = 5000;
const UPDATE_CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const CACHE_FILE = "update-check.json";

// 这份命令行的包目录（…/node_modules/quriov）。npm 全局安装时 bin 是链接，取真实路径。
export const PACKAGE_ROOT = (() => {
  const self = fileURLToPath(import.meta.url);
  let real = self;
  try {
    real = realpathSync(self);
  } catch {
    // 用原路径
  }
  const p = process.platform === "win32" ? win32 : posix;
  return p.dirname(p.dirname(real));
})();

// ---------------------------------------------------------------------------
// 版本号
// ---------------------------------------------------------------------------

export function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(String(raw ?? "").trim());
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

// a 比 b 新 → 正数；一样 → 0；旧 → 负数。认不出的版本号当作最旧。
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  const na = pa.split(".").map(Number);
  const nb = pb.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (na[i] !== nb[i]) return na[i] - nb[i];
  return 0;
}

// ---------------------------------------------------------------------------
// 查最新版（免登录的 GitHub 接口；不带钥匙）
// ---------------------------------------------------------------------------

// 给一个会一直挂着的请求套上时限：到点就放弃（并中止请求），计时器不拖住进程退出。
function withTimeout(start, ms) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, fail) => {
    timer = setTimeout(() => {
      controller.abort();
      fail(new CliError("update_timeout", `等了 ${Math.round(ms / 1000)} 秒没有回应`));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([start(controller.signal), expired]).finally(() => clearTimeout(timer));
}

export async function fetchLatestRelease({ fetchImpl = globalThis.fetch, timeoutMs = UPDATE_CHECK_TIMEOUT_MS } = {}) {
  return withTimeout(async (signal) => {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
      signal,
    });
    if (!response?.ok) throw new CliError("update_check_failed", `GitHub 返回 HTTP ${response?.status ?? "?"}`);
    const body = await response.json();
    const version = parseVersion(body?.tag_name);
    if (!version) throw new CliError("update_check_failed", "GitHub 发布页上没有认得出的版本号");
    // 下载链接只认本仓发布页的；别的一律不用，改用按版本号拼的固定地址。
    const asset = (Array.isArray(body.assets) ? body.assets : []).find(
      (a) => a?.name === ASSET_NAME && typeof a.browser_download_url === "string" && a.browser_download_url.startsWith(RELEASE_DOWNLOAD_PREFIX),
    );
    return {
      version,
      tag: body.tag_name,
      downloadUrl: asset?.browser_download_url ?? `${RELEASE_DOWNLOAD_PREFIX}${encodeURIComponent(body.tag_name)}/${ASSET_NAME}`,
    };
  }, timeoutMs);
}

// ---------------------------------------------------------------------------
// 检查结果缓存：<配置目录>/update-check.json = { checkedAt, latest }
// ---------------------------------------------------------------------------

export function updateCachePath(configDir) {
  return join(configDir, CACHE_FILE);
}

export function readUpdateCache(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return typeof data?.checkedAt === "string" ? data : null;
  } catch {
    return null;
  }
}

export function writeUpdateCache(file, data) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify(data)}\n`);
  } catch {
    // 写不下就下次再查，不影响命令本身
  }
}

export function updateCheckDisabled(env) {
  const value = String(env?.[NO_UPDATE_CHECK_ENV] ?? "").trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false";
}

export function newVersionHint(latest, current = VERSION) {
  return `quriov 有新版 v${latest}（当前 v${current}），运行 quriov update 升级`;
}

// 自动提示：命令一开始就在后台查（距上次查不到 24 小时就只读缓存），命令跑完再决定要不要提示。
// 返回 null = 这次不查；否则返回 { finish() }，finish 只往 stderr 写，失败一律不出声。
export function startUpdateNotifier({
  env,
  cacheFile,
  fetchImpl,
  now = Date.now,
  stderr,
  timeoutMs = AUTO_CHECK_TIMEOUT_MS,
  current = VERSION,
}) {
  if (updateCheckDisabled(env)) return null;
  const cache = readUpdateCache(cacheFile);
  const checkedAt = cache ? Date.parse(cache.checkedAt) : NaN;
  const fresh = Number.isFinite(checkedAt) && checkedAt <= now() && now() - checkedAt < CHECK_INTERVAL_MS;
  let pending = null;
  if (!fresh) {
    pending = fetchLatestRelease({ fetchImpl, timeoutMs }).then(
      (release) => {
        writeUpdateCache(cacheFile, { checkedAt: new Date(now()).toISOString(), latest: release.version });
        return release.version;
      },
      () => {
        // 查不到（国内网络连不上 GitHub 很常见）：记下这次查过，24 小时后再试，免得每条命令都等。
        writeUpdateCache(cacheFile, { checkedAt: new Date(now()).toISOString(), latest: cache?.latest ?? null });
        return cache?.latest ?? null;
      },
    );
  }
  return {
    async finish() {
      try {
        const latest = pending ? await pending : cache?.latest;
        if (latest && compareVersions(latest, current) > 0) stderr.write(`${newVersionHint(latest, current)}\n`);
      } catch {
        // 静默
      }
    },
  };
}

// doctor 的版本项：只是提示，不影响自检通过与否。
export async function versionDoctorCheck({ env, cacheFile, fetchImpl, now = Date.now, current = VERSION, timeoutMs = DOCTOR_CHECK_TIMEOUT_MS }) {
  if (updateCheckDisabled(env)) {
    return { ok: true, warn: true, label: `版本：当前 v${current}`, detail: `已用 ${NO_UPDATE_CHECK_ENV} 关掉联网查新版` };
  }
  try {
    const release = await fetchLatestRelease({ fetchImpl, timeoutMs });
    writeUpdateCache(cacheFile, { checkedAt: new Date(now()).toISOString(), latest: release.version });
    if (compareVersions(release.version, current) > 0) {
      return { ok: true, warn: true, label: `版本：当前 v${current}，最新 v${release.version}`, detail: "运行 quriov update 升级" };
    }
    return { ok: true, label: `版本：v${current}，已是最新` };
  } catch {
    return { ok: true, warn: true, label: `版本：当前 v${current}`, detail: "查不到最新版本（连不上 GitHub），稍后可再运行 quriov update" };
  }
}

// ---------------------------------------------------------------------------
// quriov update
// ---------------------------------------------------------------------------

// 当前这份 quriov 装在哪个 npm 前缀下：
//   Mac / Linux：<前缀>/lib/node_modules/quriov      Windows：<前缀>\node_modules\quriov
// 不是这个样子（从源码直接跑、npx 临时目录……）就返回 null：不自动装，给出重装方法。
export function detectInstallPrefix(packageRoot, platform = process.platform) {
  const p = platform === "win32" ? win32 : posix;
  if (!packageRoot) return null;
  if (/[\\/]_npx[\\/]/.test(packageRoot)) return null;
  const parent = p.dirname(packageRoot);
  if (p.basename(parent).toLowerCase() !== "node_modules") return null;
  const above = p.dirname(parent);
  if (platform === "win32") return above;
  return p.basename(above) === "lib" ? p.dirname(above) : null;
}

function npmCommand(platform) {
  return platform === "win32" ? "npm.cmd" : "npm";
}

function quoteArg(arg, platform) {
  if (platform === "win32") return /[\s"&|<>^()]/.test(arg) ? `"${arg}"` : arg;
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;
}

// 给人照抄的安装命令（带上前缀，装回原处）。file 是「<下载的文件>」这种占位时原样写。
export function manualInstallCommand(file, { prefix = null, platform = process.platform } = {}) {
  const parts = [npmCommand(platform), "install", "-g"];
  if (prefix) parts.push("--prefix", quoteArg(prefix, platform));
  parts.push(file.startsWith("<") ? file : quoteArg(file, platform));
  return parts.join(" ");
}

// 真去跑 npm。Windows 上 npm 是 npm.cmd，要经过 cmd 才能跑（新版 Node 不许直接起 .cmd），参数自己加引号。
export function spawnNpm({ command, args, platform = process.platform }) {
  return new Promise((done) => {
    const argv = platform === "win32" ? args.map((a) => quoteArg(a, platform)) : args;
    let output = "";
    let child;
    try {
      child = spawn(command, argv, { shell: platform === "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      done({ code: null, output, error });
      return;
    }
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => done({ code: null, output, error }));
    child.on("close", (code) => done({ code, output }));
  });
}

function tail(text, lines = 8) {
  return String(text ?? "").trim().split(/\r?\n/).slice(-lines).join("\n");
}

export async function runUpdate({
  fetchImpl = globalThis.fetch,
  platform = process.platform,
  packageRoot = PACKAGE_ROOT,
  tmpDir = tmpdir(),
  runNpm = spawnNpm,
  cacheFile = null,
  now = Date.now,
  current = VERSION,
  log = () => {},
  afterInstall = async () => [],
}) {
  const prefix = detectInstallPrefix(packageRoot, platform);
  const manual = (file) => manualInstallCommand(file, { prefix, platform });

  let release;
  try {
    release = await fetchLatestRelease({ fetchImpl });
  } catch (error) {
    throw new CliError(
      "update_check_failed",
      [
        `连不上 GitHub，查不到最新版本（${error?.message ?? "网络错误"}；国内网络常见）。`,
        `可以用浏览器打开 ${LATEST_DOWNLOAD_URL} 下载安装包，再运行：${manual("<下载的文件>")}`,
      ].join("\n"),
      { exitCode: 1 },
    );
  }
  if (cacheFile) writeUpdateCache(cacheFile, { checkedAt: new Date(now()).toISOString(), latest: release.version });

  if (compareVersions(release.version, current) <= 0) {
    return { updated: false, current, latest: release.version, message: `已是最新 v${current}` };
  }

  if (!prefix) {
    throw new CliError(
      "update_unsupported_install",
      [
        `有新版 v${release.version}（当前 v${current}），但这份 quriov 不是用 npm install -g 装的（在 ${packageRoot}），没法自动升级。`,
        `按安装说明重装：${INSTALL_DOC_URL}`,
      ].join("\n"),
      { exitCode: 1 },
    );
  }

  log(`发现新版 v${release.version}（当前 v${current}），正在下载 ${release.downloadUrl} …`);
  // 临时目录和文件是本机真实路径，用本机的路径规则拼。
  const dir = mkdtempSync(join(tmpDir, "quriov-update-"));
  const file = join(dir, ASSET_NAME);
  try {
    const bytes = await withTimeout(async (signal) => {
      const response = await fetchImpl(release.downloadUrl, { headers: { "User-Agent": USER_AGENT }, signal });
      if (!response?.ok) throw new CliError("update_download_failed", `HTTP ${response?.status ?? "?"}`);
      return Buffer.from(await response.arrayBuffer());
    }, DOWNLOAD_TIMEOUT_MS);
    if (!bytes.length) throw new CliError("update_download_failed", "下载到的文件是空的");
    writeFileSync(file, bytes);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new CliError(
      "update_download_failed",
      [
        `新版 v${release.version} 下载失败（${error?.message ?? "网络错误"}；国内网络连 GitHub 常见）。`,
        `可以用浏览器打开 ${release.downloadUrl} 下载，再运行：${manual("<下载的文件>")}`,
      ].join("\n"),
      { exitCode: 1 },
    );
  }

  const args = ["install", "-g", "--prefix", prefix, file];
  log(`正在安装：${manual(file)}`);
  const result = await runNpm({ command: npmCommand(platform), args, platform });
  if (result.code !== 0) {
    const output = `${result.output ?? ""}\n${result.error?.message ?? ""}`;
    // 装失败时留着下载好的文件，给人照着命令手动装。
    if (result.error?.code === "ENOENT") {
      throw new CliError(
        "update_install_failed",
        `找不到 ${npmCommand(platform)}（npm 不在 PATH 里）。安装包已下载到 ${file}，装好 Node.js 后运行：${manual(file)}`,
        { exitCode: 1 },
      );
    }
    if (/\b(EACCES|EPERM)\b/.test(output)) {
      throw new CliError(
        "update_install_failed",
        [
          `没有权限写 ${prefix}（EACCES）。安装包已下载到 ${file}。`,
          // 这里要让 shell 展开 $HOME / %USERPROFILE%，所以前缀用双引号，不走 quoteArg。
          `按安装说明（${INSTALL_DOC_URL}）「报权限错误」那条：改装到自己的目录 ${npmCommand(platform)} install -g --prefix ${platform === "win32" ? '"%USERPROFILE%\\.quriov-cli"' : '"$HOME/.quriov-cli"'} ${quoteArg(file, platform)}，`,
          `之后的 quriov 都写成 ${platform === "win32" ? "%USERPROFILE%\\.quriov-cli\\quriov.cmd" : '"$HOME/.quriov-cli/bin/quriov"'}。`,
        ].join("\n"),
        { exitCode: 1 },
      );
    }
    throw new CliError(
      "update_install_failed",
      [`npm 安装没成功（退出码 ${result.code ?? "?"}）：`, tail(output), `安装包已下载到 ${file}，可以手动运行：${manual(file)}`].join("\n"),
      { exitCode: 1 },
    );
  }
  rmSync(dir, { recursive: true, force: true });
  let refreshed = [];
  try {
    refreshed = await afterInstall();
  } catch {
    // 技能没同步不影响升级本身；doctor 会指出来
  }
  return {
    updated: true,
    current,
    latest: release.version,
    prefix,
    refreshedSkills: refreshed,
    message: `已更新到 v${release.version}（原来 v${current}），装在 ${prefix}。`,
  };
}
