import assert from "node:assert/strict";
import test from "node:test";

import {
  ENDPOINT,
  EXPECTED_TOOLS,
  parseArgs,
  runDoctor,
} from "../bin/quriov-mcp-doctor.mjs";

const TEST_KEY = "unit-test-key-never-print";
const PRIVATE_ACCOUNT_VALUE = "private-account-value-never-print";
const RAW_UPSTREAM_BODY = "raw-upstream-body-never-print";

function jsonResponse(payload, { status = 200, sessionId } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (sessionId) headers.set("mcp-session-id", sessionId);
  return new Response(JSON.stringify(payload), { status, headers });
}

function sseResponse(payload, { sessionId } = {}) {
  const headers = new Headers({ "content-type": "text/event-stream" });
  if (sessionId) headers.set("mcp-session-id", sessionId);
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers,
  });
}

function createProtocolFetch({ sse = false, toolNames = EXPECTED_TOOLS } = {}) {
  const calls = [];
  const response = sse ? sseResponse : jsonResponse;

  const fetchImpl = async (url, init) => {
    assert.equal(url, ENDPOINT);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, `Bearer ${TEST_KEY}`);
    const request = JSON.parse(init.body);
    calls.push({ request, sessionId: init.headers["Mcp-Session-Id"] ?? null });

    if (request.method === "initialize") {
      return response(
        {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "quriov", version: "1.0.0" },
          },
        },
        { sessionId: "test-session" },
      );
    }

    assert.equal(init.headers["Mcp-Session-Id"], "test-session");

    if (request.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (request.method === "tools/list") {
      return response({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: toolNames.map((name) => ({ name })) },
      });
    }
    if (request.method === "tools/call") {
      assert.equal(request.params.name, "get_account");
      return response({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: PRIVATE_ACCOUNT_VALUE }],
          isError: false,
        },
      });
    }
    throw new Error(`Unexpected test method: ${request.method}`);
  };

  return { calls, fetchImpl };
}

test("validates initialize, exact tools, and redacted get_account", async () => {
  const { calls, fetchImpl } = createProtocolFetch();

  const result = await runDoctor({ key: TEST_KEY, fetchImpl });
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, true);
  assert.equal(result.checks.initialize.status, "pass");
  assert.equal(result.checks.tools.count, 8);
  assert.deepEqual(result.checks.tools.names, [...EXPECTED_TOOLS].sort());
  assert.deepEqual(result.checks.getAccount, {
    status: "pass",
    redacted: true,
  });
  assert.deepEqual(
    calls.map(({ request }) => request.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/call"],
  );
  assert.equal(serialized.includes(TEST_KEY), false);
  assert.equal(serialized.includes(PRIVATE_ACCOUNT_VALUE), false);
});

test("accepts event-stream MCP responses", async () => {
  const { fetchImpl } = createProtocolFetch({ sse: true });
  const result = await runDoctor({ key: TEST_KEY, fetchImpl });
  assert.equal(result.ok, true);
});

test("fails closed when the tool contract drifts", async () => {
  const { fetchImpl } = createProtocolFetch({
    toolNames: EXPECTED_TOOLS.slice(0, -1),
  });

  await assert.rejects(
    runDoctor({ key: TEST_KEY, fetchImpl }),
    (error) => {
      assert.equal(error.stage, "tools");
      assert.match(error.message, /exact eight-tool contract/i);
      assert.equal(error.message.includes(TEST_KEY), false);
      return true;
    },
  );
});

test("reports HTTP status without exposing an upstream body", async () => {
  const fetchImpl = async () =>
    new Response(RAW_UPSTREAM_BODY, { status: 401 });

  await assert.rejects(
    runDoctor({ key: TEST_KEY, fetchImpl }),
    (error) => {
      assert.equal(error.stage, "initialize");
      assert.match(error.message, /HTTP 401/);
      assert.equal(error.message.includes(TEST_KEY), false);
      assert.equal(error.message.includes(RAW_UPSTREAM_BODY), false);
      return true;
    },
  );
});

test("rejects key and endpoint command-line arguments", () => {
  assert.deepEqual(parseArgs(["--json", "--key-stdin"]), {
    json: true,
    keyStdin: true,
    help: false,
  });
  assert.throws(() => parseArgs(["--key", TEST_KEY]), /unsupported argument/i);
  assert.throws(
    () => parseArgs(["--endpoint", "https://example.com/mcp"]),
    /unsupported argument/i,
  );
});
