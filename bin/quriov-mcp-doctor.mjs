#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const ENDPOINT = "https://quriovai.com/mcp/v1";
export const PROTOCOL_VERSION = "2025-06-18";
export const EXPECTED_TOOLS = Object.freeze([
  "cancel_generation",
  "check_generation",
  "estimate_cost",
  "generate_image",
  "generate_video",
  "get_account",
  "list_capabilities",
  "list_generations",
]);

const CLIENT_INFO = Object.freeze({
  name: "quriov-mcp-doctor",
  version: "1.0.0",
});

export class DoctorError extends Error {
  constructor(stage, message, code = "doctor_failed") {
    super(message);
    this.name = "DoctorError";
    this.stage = stage;
    this.code = code;
  }
}

export function parseArgs(argv) {
  const options = { json: false, keyStdin: false, help: false };

  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument === "--key-stdin") options.keyStdin = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else {
      throw new DoctorError(
        "arguments",
        "Unsupported argument. Keys and endpoints are never accepted as arguments.",
        "unsupported_argument",
      );
    }
  }

  return options;
}

function parseSse(text, stage) {
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");

  for (const data of dataLines) {
    try {
      return JSON.parse(data);
    } catch {
      // Continue to the next event without exposing response content.
    }
  }

  throw new DoctorError(
    stage,
    `Invalid MCP event stream during ${stage}.`,
    "invalid_response",
  );
}

function parsePayload(text, contentType, stage) {
  if (contentType.includes("text/event-stream")) {
    return parseSse(text, stage);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new DoctorError(
      stage,
      `Invalid MCP response during ${stage}.`,
      "invalid_response",
    );
  }
}

async function postRpc({
  key,
  fetchImpl,
  payload,
  sessionId,
  stage,
  allowEmpty = false,
}) {
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (error instanceof DoctorError) throw error;
    throw new DoctorError(
      stage,
      `Network request failed during ${stage}.`,
      "network_error",
    );
  }

  if (!response.ok) {
    throw new DoctorError(
      stage,
      `HTTP ${response.status} during ${stage}.`,
      "http_error",
    );
  }

  const nextSessionId = response.headers.get("mcp-session-id") ?? sessionId;
  if (allowEmpty && [202, 204].includes(response.status)) {
    return { payload: null, sessionId: nextSessionId };
  }

  const text = await response.text();
  if (allowEmpty && !text.trim()) {
    return { payload: null, sessionId: nextSessionId };
  }
  const parsed = parsePayload(
    text,
    response.headers.get("content-type") ?? "",
    stage,
  );

  if (parsed?.error) {
    const errorCode =
      typeof parsed.error.code === "number" || typeof parsed.error.code === "string"
        ? parsed.error.code
        : "unknown";
    throw new DoctorError(
      stage,
      `${stage} returned MCP error ${errorCode}.`,
      "mcp_error",
    );
  }
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
    throw new DoctorError(
      stage,
      `Missing MCP result during ${stage}.`,
      "invalid_response",
    );
  }

  return { payload: parsed, sessionId: nextSessionId };
}

function verifyTools(payload) {
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new DoctorError(
      "tools",
      "Missing tool list in MCP response.",
      "invalid_response",
    );
  }

  const names = tools
    .map((tool) => tool?.name)
    .filter((name) => typeof name === "string")
    .sort();
  const expected = [...EXPECTED_TOOLS].sort();

  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new DoctorError(
      "tools",
      "The server did not expose the exact eight-tool contract.",
      "tool_contract_mismatch",
    );
  }
  return names;
}

export async function runDoctor({ key, fetchImpl = globalThis.fetch }) {
  if (typeof key !== "string" || !key.trim()) {
    throw new DoctorError(
      "credential",
      "A Quriov MCP key is required through stdin or QURIOV_MCP_ACCESS_KEY.",
      "missing_credential",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new DoctorError(
      "runtime",
      "This Node.js runtime does not provide fetch.",
      "unsupported_runtime",
    );
  }

  const initialize = await postRpc({
    key,
    fetchImpl,
    stage: "initialize",
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
    },
  });
  const negotiatedVersion = initialize.payload?.result?.protocolVersion;
  if (typeof negotiatedVersion !== "string") {
    throw new DoctorError(
      "initialize",
      "Initialize did not negotiate a protocol version.",
      "invalid_response",
    );
  }

  await postRpc({
    key,
    fetchImpl,
    sessionId: initialize.sessionId,
    stage: "initialized",
    allowEmpty: true,
    payload: {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
  });

  const toolsResponse = await postRpc({
    key,
    fetchImpl,
    sessionId: initialize.sessionId,
    stage: "tools",
    payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  const toolNames = verifyTools(toolsResponse.payload);

  const accountResponse = await postRpc({
    key,
    fetchImpl,
    sessionId: initialize.sessionId,
    stage: "get_account",
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_account", arguments: {} },
    },
  });
  if (accountResponse.payload?.result?.isError === true) {
    throw new DoctorError(
      "get_account",
      "get_account returned an error result.",
      "tool_error",
    );
  }

  return {
    ok: true,
    endpoint: ENDPOINT,
    checks: {
      initialize: { status: "pass", protocolVersion: negotiatedVersion },
      tools: { status: "pass", count: toolNames.length, names: toolNames },
      getAccount: { status: "pass", redacted: true },
    },
  };
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

function printHelp() {
  process.stdout.write(
    [
      "Quriov MCP read-only doctor",
      "",
      "Usage:",
      "  quriov-mcp-doctor --json --key-stdin",
      "  QURIOV_MCP_ACCESS_KEY=<secret> quriov-mcp-doctor --json",
      "",
      "The key and endpoint are never accepted as command-line values.",
      "The doctor does not install, write configuration, generate, or revoke.",
      "",
    ].join("\n"),
  );
}

function printHuman(result) {
  process.stdout.write(
    [
      "PASS initialize",
      `PASS exact tools (${result.checks.tools.count})`,
      "PASS get_account (redacted)",
      "",
    ].join("\n"),
  );
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }

    const key = options.keyStdin
      ? await readStdin()
      : (process.env.QURIOV_MCP_ACCESS_KEY ?? "").trim();
    const result = await runDoctor({ key });
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else printHuman(result);
  } catch (error) {
    const safe =
      error instanceof DoctorError
        ? { ok: false, stage: error.stage, code: error.code, error: error.message }
        : {
            ok: false,
            stage: "runtime",
            code: "doctor_failed",
            error: "Doctor failed safely.",
          };
    process.stdout.write(`${JSON.stringify(safe)}\n`);
    process.exitCode = 1;
  }
}

const isDirect =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href.toLowerCase() ===
    import.meta.url.toLowerCase();
if (isDirect) await main();
