// quriov setup / doctor / uninstall：把 MCP 写进本机装了的 Claude Code / Codex / Cursor，装技能，自检。
//
// 边界（见 AGENTS.md）：
// - 只动这三个客户端的用户级配置里名为 quriov 的那一项，其余原样保留；解析不了的文件不碰，报出路径。
// - 钥匙只写进这些用户配置文件（图形版客户端读不到 shell 里的环境变量），文件权限收到仅本人可读写。
// - 技能只写 <技能目录>/quriov/SKILL.md；卸载只删我们装的那一份。

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { CliError, MCP_ENDPOINT, sha256, writeAtomic } from "./common.mjs";

export const SERVER_NAME = "quriov";
export const SKILL_NAME = "quriov";
// 自检只看这几个核心工具在不在，不比总数：服务端以后加工具，已装的命令行照样自检通过。
export const CORE_TOOLS = Object.freeze(["list_capabilities", "estimate_cost", "generate_image", "get_account"]);
export const SKILL_SOURCE = new URL("../skill/SKILL.md", import.meta.url);

const KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{16,512}$/;

export function checkKeyShape(key) {
  if (!KEY_PATTERN.test(key ?? "")) {
    throw new CliError(
      "invalid_key_format",
      "这不像一把 Quriov 钥匙（钥匙只含字母、数字和 _ - 等符号，没有空格、引号或中文）。请从网页重新复制完整的钥匙。",
      { exitCode: 2 },
    );
  }
}

function onPath(name, { env, platform }) {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
  return dirs.some((dir) => exts.some((ext) => existsSync(join(dir, `${name}${ext.toLowerCase()}`)) || existsSync(join(dir, `${name}${ext}`))));
}

// 三个客户端各自的用户级 MCP 配置文件和技能目录。
export function clientTargets({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const cursorDir = join(home, ".cursor");
  const header = (key) => ({ Authorization: `Bearer ${key}` });
  const claudeConfig = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
  return [
    {
      id: "claude",
      name: "Claude Code",
      format: "json",
      config: claudeConfig,
      skills: join(claudeDir, "skills"),
      installed: existsSync(claudeConfig) || existsSync(claudeDir) || onPath("claude", { env, platform }),
      entry: (key) => ({ type: "http", url: MCP_ENDPOINT, headers: header(key) }),
    },
    {
      id: "codex",
      name: "Codex",
      format: "toml",
      config: join(codexHome, "config.toml"),
      skills: join(home, ".agents", "skills"),
      installed: existsSync(codexHome) || onPath("codex", { env, platform }),
    },
    {
      id: "cursor",
      name: "Cursor",
      format: "json",
      config: join(cursorDir, "mcp.json"),
      skills: null, // Cursor 没有用户级技能目录，只装 MCP
      installed: existsSync(cursorDir) || onPath("cursor", { env, platform }),
      entry: (key) => ({ url: MCP_ENDPOINT, headers: header(key) }),
    },
  ];
}

// ---------------------------------------------------------------------------
// 配置文件：纯函数（文本进、文本出），方便测试；不认识的形状一律拒绝改。
// ---------------------------------------------------------------------------

function unsafe(detail) {
  return new CliError("unsafe_config", detail, { exitCode: 1 });
}

function parseJsonConfig(text) {
  if (!text.trim()) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw unsafe("文件不是合法的 JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw unsafe("文件顶层不是 JSON 对象");
  if (data.mcpServers !== undefined && (typeof data.mcpServers !== "object" || data.mcpServers === null || Array.isArray(data.mcpServers))) {
    throw unsafe("mcpServers 不是 JSON 对象");
  }
  return data;
}

export function upsertJsonServer(text, entry) {
  const data = parseJsonConfig(text);
  data.mcpServers = { ...(data.mcpServers ?? {}), [SERVER_NAME]: entry };
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function removeJsonServer(text) {
  const data = parseJsonConfig(text);
  if (!data.mcpServers || !(SERVER_NAME in data.mcpServers)) return null;
  delete data.mcpServers[SERVER_NAME];
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function readJsonServer(text) {
  return parseJsonConfig(text).mcpServers?.[SERVER_NAME] ?? null;
}

const TOML_HEADER = /^\s*\[{1,2}([^\[\]]+)\]{1,2}\s*(?:#.*)?$/;
const normalizeTable = (raw) => raw.replace(/\s+/g, "").replace(/["']/g, "");
const isOurTable = (name) => name === `mcp_servers.${SERVER_NAME}` || name.startsWith(`mcp_servers.${SERVER_NAME}.`);

// 删掉 [mcp_servers.quriov] 及其子表（[mcp_servers.quriov.xxx]）。遇到用别的写法定义的 quriov 就拒绝。
export function removeTomlServer(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let table = "";
  let removed = false;
  for (const line of lines) {
    const header = line.match(TOML_HEADER);
    if (header) table = normalizeTable(header[1]);
    if (isOurTable(table)) {
      removed = true;
      continue;
    }
    if (!header) {
      const inlineRoot = table === "" && new RegExp(`^\\s*mcp_servers\\s*\\.\\s*["']?${SERVER_NAME}["']?\\s*[.=]`).test(line);
      const inlineTable = table === "mcp_servers" && new RegExp(`^\\s*["']?${SERVER_NAME}["']?\\s*[.=]`).test(line);
      if (inlineRoot || inlineTable) throw unsafe(`${SERVER_NAME} 是用行内写法定义的，不能安全替换`);
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), removed };
}

export function tomlServerBlock(key) {
  return `[mcp_servers.${SERVER_NAME}]\nurl = "${MCP_ENDPOINT}"\nhttp_headers = { Authorization = "Bearer ${key}" }\n`;
}

export function upsertTomlServer(text, key) {
  const rest = removeTomlServer(text).text.replace(/\s+$/, "");
  return `${rest ? `${rest}\n\n` : ""}${tomlServerBlock(key)}`;
}

export function readTomlServer(text) {
  const lines = text.split(/\r?\n/);
  let table = "";
  const found = { present: false, url: null, authorization: null };
  for (const line of lines) {
    const header = line.match(TOML_HEADER);
    if (header) {
      table = normalizeTable(header[1]);
      if (table === `mcp_servers.${SERVER_NAME}`) found.present = true;
      continue;
    }
    if (table !== `mcp_servers.${SERVER_NAME}`) continue;
    const url = line.match(/^\s*url\s*=\s*"([^"]*)"/);
    if (url) found.url = url[1];
    const auth = line.match(/^\s*http_headers\s*=\s*\{.*Authorization\s*=\s*"([^"]*)"/);
    if (auth) found.authorization = auth[1];
  }
  return found.present ? found : null;
}

// ---------------------------------------------------------------------------
// 读写真实文件
// ---------------------------------------------------------------------------

// 配置文件可能是指向 dotfiles 仓的软链：写到链接指向的真文件，别把软链换成普通文件。
function realTarget(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path);
  } catch {
    // 不存在：就写这个路径
  }
  return path;
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw unsafe("读不了这个文件（没有权限？）");
  }
}

function writeSecretFile(path, content) {
  const target = realTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  writeAtomic(target, content, { mode: 0o600 });
  try {
    chmodSync(target, 0o600); // 里面有钥匙：仅本人可读写（Windows 上不生效，文件本来就在用户目录下）
  } catch {
    // 忽略
  }
}

function entryState(target, text, key) {
  if (text === null) return { status: "missing" };
  let url;
  let authorization;
  if (target.format === "toml") {
    const found = readTomlServer(text);
    if (!found) return { status: "missing" };
    ({ url, authorization } = found);
  } else {
    const entry = readJsonServer(text);
    if (!entry) return { status: "missing" };
    url = entry.url;
    authorization = entry.headers?.Authorization;
  }
  if (url !== MCP_ENDPOINT) return { status: "wrong_url" };
  if (!authorization) return { status: "no_key" };
  if (key && authorization !== `Bearer ${key}`) return { status: "other_key" };
  return { status: "ok" };
}

export function writeClientConfig(target, key, { dryRun = false } = {}) {
  let text;
  let next;
  try {
    text = readText(target.config) ?? "";
    next = target.format === "toml" ? upsertTomlServer(text, key) : upsertJsonServer(text, target.entry(key));
  } catch (error) {
    if (error instanceof CliError) return { status: "skipped", reason: error.message };
    throw error;
  }
  if (dryRun) return { status: "planned" };
  writeSecretFile(target.config, next);
  const check = entryState(target, readText(target.config), key); // 写完读回来核对
  return check.status === "ok" ? { status: "written" } : { status: "skipped", reason: "写入后读回核对没通过" };
}

export function removeClientConfig(target, { dryRun = false } = {}) {
  const text = readText(target.config);
  if (text === null) return { status: "absent" };
  let next;
  try {
    if (target.format === "toml") {
      const result = removeTomlServer(text);
      next = result.removed ? `${result.text.replace(/\s+$/, "")}\n` : null;
    } else {
      next = removeJsonServer(text);
    }
  } catch (error) {
    if (error instanceof CliError) return { status: "skipped", reason: error.message };
    throw error;
  }
  if (next === null) return { status: "absent" };
  if (!dryRun) writeSecretFile(target.config, next);
  return { status: dryRun ? "planned" : "removed" };
}

// ---------------------------------------------------------------------------
// 技能
// ---------------------------------------------------------------------------

export function skillFile(skillsDir) {
  return join(skillsDir, SKILL_NAME, "SKILL.md");
}

// 同一个技能目录可能被两个客户端共用（比如 ~/.agents/skills 软链到 ~/.claude/skills）：去重。
export function skillDirsFor(targets) {
  const seen = new Map();
  for (const target of targets) {
    if (!target.skills) continue;
    let real = target.skills;
    try {
      real = realpathSync(target.skills);
    } catch {
      // 还不存在
    }
    const entry = seen.get(real) ?? { dir: target.skills, clients: [] };
    entry.clients.push(target.name);
    seen.set(real, entry);
  }
  return [...seen.values()];
}

function readSkillSource(skillSource) {
  return readFileSync(skillSource, "utf8");
}

export function installSkill(skillsDir, { dryRun = false, skillSource = SKILL_SOURCE } = {}) {
  const content = readSkillSource(skillSource);
  const file = skillFile(skillsDir);
  if (dryRun) return { status: "planned", file };
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, content);
  return { status: "written", file };
}

function isOurSkill(file) {
  const text = readText(file);
  return text !== null && new RegExp(`^---\\s*\\r?\\nname:\\s*${SKILL_NAME}\\s*$`, "m").test(text);
}

export function removeSkill(skillsDir, { dryRun = false } = {}) {
  const file = skillFile(skillsDir);
  if (!existsSync(file)) return { status: "absent", file };
  if (!isOurSkill(file)) return { status: "skipped", file, reason: "不是 quriov setup 装的技能，没动" };
  if (!dryRun) rmSync(dirname(file), { recursive: true, force: true });
  return { status: dryRun ? "planned" : "removed", file };
}

function skillState(skillsDir, skillSource) {
  const text = readText(skillFile(skillsDir));
  if (text === null) return "missing";
  return sha256(text) === sha256(readSkillSource(skillSource)) ? "ok" : "outdated";
}

// ---------------------------------------------------------------------------
// 自检：四项。只读，不打印钥匙和账户数据。
// ---------------------------------------------------------------------------

// 任何失败都翻成一句中文原因；不是命令行自己的报错（意外异常）也不往外甩英文堆栈。
function reason(error) {
  if (error instanceof CliError) return error.message;
  return `命令行内部出错（${error?.name ?? "Error"}），请把这行发给 Quriov 管理员`;
}

export async function runDoctor({ client, targets, skillSource = SKILL_SOURCE }) {
  const checks = [];
  let accountOk = false;
  try {
    await client.account();
    accountOk = true;
    checks.push({ ok: true, label: `钥匙可用（正在用${client.keySource ?? "当前钥匙"}）` });
  } catch (error) {
    checks.push({ ok: false, label: "钥匙可用", detail: reason(error) });
  }
  const key = client.key; // 换过备选钥匙时，以真正能用的那把核对客户端配置

  if (!accountOk) {
    checks.push({ ok: false, label: "MCP 连得上、核心工具齐全", detail: "钥匙没通过，没法检查" });
  } else {
    try {
      const names = await client.listTools();
      const missing = CORE_TOOLS.filter((name) => !names.includes(name));
      checks.push(
        missing.length
          ? { ok: false, label: "MCP 连得上、核心工具齐全", detail: `缺少：${missing.join("、")}（服务端问题，请联系 Quriov 管理员）` }
          : { ok: true, label: `MCP 连得上、核心工具齐全（服务端共 ${names.length} 个工具）` },
      );
    } catch (error) {
      checks.push({ ok: false, label: "MCP 连得上、核心工具齐全", detail: reason(error) });
    }
  }

  const clientLines = [];
  const clientProblems = [];
  const skillProblems = [];
  const skillOk = [];
  for (const target of targets) {
    let state;
    try {
      state = entryState(target, readText(target.config), key);
    } catch (error) {
      state = { status: "unreadable", detail: error.message };
    }
    if (!target.installed && state.status === "missing") continue;
    if (state.status === "ok") clientLines.push(target.name);
    else {
      const why = {
        missing: "还没配置",
        wrong_url: "地址不对",
        no_key: "没带钥匙",
        other_key: "配的是另一把钥匙",
        unreadable: `读不了（${state.detail ?? ""}）`,
      }[state.status];
      clientProblems.push(`${target.name} ${why}（${target.config}）`);
    }
    if (target.skills && target.installed) {
      const s = skillState(target.skills, skillSource);
      if (s === "ok") skillOk.push(target.name);
      else skillProblems.push(`${target.name} ${s === "missing" ? "没装" : "是旧版本"}（${skillFile(target.skills)}）`);
    }
  }
  if (clientProblems.length) {
    checks.push({ ok: false, label: "客户端配置正确", detail: `${clientProblems.join("；")}。运行 quriov setup 修好` });
  } else if (clientLines.length) {
    checks.push({ ok: true, label: `客户端配置正确：${clientLines.join("、")}` });
  } else {
    checks.push({ ok: true, label: "客户端配置：本机没发现 Claude Code / Codex / Cursor（只装了命令行）" });
  }
  if (skillProblems.length) {
    checks.push({ ok: false, label: "技能已装", detail: `${skillProblems.join("；")}。运行 quriov setup 修好` });
  } else if (skillOk.length) {
    checks.push({ ok: true, label: `技能已装：${skillOk.join("、")}` });
  } else {
    checks.push({ ok: true, label: "技能：没有需要装技能的客户端" });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export function renderDoctor(result) {
  const lines = result.checks.map((c) => `  [${c.ok ? "通过" : "没过"}] ${c.label}${c.detail ? `：${c.detail}` : ""}`);
  return lines.join("\n");
}
