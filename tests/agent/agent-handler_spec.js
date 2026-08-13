// tests/agent/agent-handler_spec.js — integration smoke tests for the HTTP
// handler. We synthesize a fake Node req/res, dispatch through handle(), and
// assert response shape. No network, no DOM.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const { handle, TOOL_SCHEMAS } = await import(
  pathToFileURL(
    path.join(PROJECT_ROOT, "server", "agent-handler.mjs"),
  ).href
);

function fakeRes() {
  const headers = {};
  return {
    statusCode: 0,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    _body: "",
    _headers: headers,
    end(chunk) {
      this._body += chunk;
    },
    json() {
      return JSON.parse(this._body);
    },
  };
}

function fakeReq({ method = "GET", url = "/", body = "" } = {}) {
  return {
    method,
    url,
    on(event, fn) {
      if (event === "data") {
        if (body) fn(body);
      } else if (event === "end") {
        fn();
      }
    },
  };
}

test("GET /api/agent/tools returns schemas", async () => {
  const res = fakeRes();
  await handle(fakeReq({ url: "/api/agent/tools" }), res);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body));
  assert.ok(body.length > 0);
  const names = body.map((t) => t.name);
  assert.ok(names.includes("render_spritesheet"));
});

test("POST /api/agent/run mutates session", async () => {
  const res = fakeRes();
  await handle(
    fakeReq({
      method: "POST",
      url: "/api/agent/run",
      body: JSON.stringify({
        sessionId: "test-run-1",
        tool: "set_body_type",
        arguments: { bodyType: "muscular" },
      }),
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.bodyType, "muscular");
});

test("POST /api/agent/chat responds with tool calls (provider or echo)", { skip: process.env.AGENT_SKIP_LIVE === "1" }, async () => {
  // In CI / local dev with a real config.json this will hit MiniMax and
  // produce a long tool-call chain (echo stub only triggers when config
  // is missing). Either way we expect at least one tool call. Set
  // AGENT_SKIP_LIVE=1 to skip when running offline.
  const res = fakeRes();
  await handle(
    fakeReq({
      method: "POST",
      url: "/api/agent/chat",
      body: JSON.stringify({
        sessionId: "test-chat-1",
        messages: [{ role: "user", content: "蓝色法师 施法" }],
      }),
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.toolCalls.length > 0);
  // The response is well-formed regardless of which provider answered.
  assert.ok(["MiniMax", "echo"].includes(body.provider));
});

test("POST /api/agent/run rejects unknown tool", async () => {
  const res = fakeRes();
  await handle(
    fakeReq({
      method: "POST",
      url: "/api/agent/run",
      body: JSON.stringify({
        tool: "no_such_tool",
        arguments: {},
      }),
    }),
    res,
  );
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, "invalid-args");
});

test("POST /api/agent/run enforces bodyType enum", async () => {
  const res = fakeRes();
  await handle(
    fakeReq({
      method: "POST",
      url: "/api/agent/run",
      body: JSON.stringify({
        sessionId: "test-bt",
        tool: "set_body_type",
        arguments: { bodyType: "robot" },
      }),
    }),
    res,
  );
  const body = res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, "invalid-args");
});

test("GET on unknown route returns 404", async () => {
  const res = fakeRes();
  await handle(fakeReq({ url: "/api/agent/nope" }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().ok, false);
});

test("TOOL_SCHEMAS includes expected tool names", () => {
  const names = TOOL_SCHEMAS.map((t) => t.name);
  for (const expected of [
    "list_items",
    "set_body_type",
    "set_selection",
    "render_spritesheet",
  ]) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});