// tests/agent/mcp-protocol_spec.js — unit tests for the MCP protocol layer
// (server/mcp/protocol.mjs) and the MCP tool handlers (server/mcp/tools.mjs).
// Pure functions only: no stdio, no browser, no renderer.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const protocol = await import(
  pathToFileURL(path.join(PROJECT_ROOT, "server", "mcp", "protocol.mjs")).href
);
const tools = await import(
  pathToFileURL(path.join(PROJECT_ROOT, "server", "mcp", "tools.mjs")).href
);

const { createMcpState, handleMessage, parseLine, SERVER_INFO } = protocol;
const { MCP_TOOLS, callTool, _validateConfig } = tools;

function makeState() {
  return createMcpState({ tools: MCP_TOOLS, callTool });
}

/** Full handshake: initialize + notifications/initialized. */
async function handshake(state) {
  const initRes = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    },
  });
  assert.equal(initRes.result.protocolVersion, "2025-06-18");
  await handleMessage(state, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
}

// ─── parseLine ─────────────────────────────────────────────────────────────

test("parseLine: blank lines return null", () => {
  assert.equal(parseLine(""), null);
  assert.equal(parseLine("   \n"), null);
  assert.equal(parseLine(null), null);
});

test("parseLine: invalid JSON returns a parse-error response", () => {
  const r = parseLine("{not json");
  assert.ok(r.error);
  assert.equal(r.error.error.code, -32768);
  assert.equal(r.error.id, null);
});

test("parseLine: valid JSON returns the message", () => {
  const r = parseLine('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.deepEqual(r.error ?? undefined, undefined);
  assert.equal(r.message.method, "ping");
});

// ─── initialize / handshake ────────────────────────────────────────────────

test("initialize echoes the client protocolVersion and advertises tools", async () => {
  const state = makeState();
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", clientInfo: { name: "c" } },
  });
  assert.equal(res.jsonrpc, "2.0");
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2024-11-05");
  assert.deepEqual(res.result.capabilities, { tools: { listChanged: false } });
  assert.equal(res.result.serverInfo.name, SERVER_INFO.name);
  assert.equal(state.clientInfo.name, "c");
});

test("initialize without a protocolVersion falls back to the default", async () => {
  const state = makeState();
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
  });
  assert.equal(typeof res.result.protocolVersion, "string");
  assert.ok(res.result.protocolVersion.length > 0);
});

test("requests before initialize are rejected with -32002 (ping excepted)", async () => {
  const state = makeState();
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
  });
  assert.equal(res.error.code, -32002);
  const ping = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 4,
    method: "ping",
  });
  assert.deepEqual(ping.result, {});
});

// ─── notifications / unknown methods ──────────────────────────────────────

test("notifications return null (no response)", async () => {
  const state = makeState();
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(res, null);
  const unknownNotif = await handleMessage(state, {
    jsonrpc: "2.0",
    method: "notifications/whatever",
  });
  assert.equal(unknownNotif, null);
});

test("unknown request method returns -32601", async () => {
  const state = makeState();
  await handshake(state);
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 9,
    method: "prompts/list",
  });
  assert.equal(res.error.code, -32601);
});

test("malformed messages return -32600", async () => {
  const state = makeState();
  const res1 = await handleMessage(state, null);
  assert.equal(res1.error.code, -32600);
  const res2 = await handleMessage(state, [42]);
  assert.ok(Array.isArray(res2));
  assert.equal(res2[0].error.code, -32600);
});

// ─── tools/list ────────────────────────────────────────────────────────────

test("tools/list serves all 8 MCP tools with valid schemas", async () => {
  const state = makeState();
  await handshake(state);
  const res = await handleMessage(state, { jsonrpc: "2.0", id: 5, method: "tools/list" });
  const names = res.result.tools.map((t) => t.name);
  assert.deepEqual(
    [...names].sort(),
    [
      "build_config",
      "generate_spritesheet",
      "get_item",
      "list_animations",
      "list_body_types",
      "list_categories",
      "list_items",
      "suggest_animation_preset",
    ],
  );
  for (const t of res.result.tools) {
    assert.equal(typeof t.description, "string");
    assert.ok(t.description.length > 0);
    assert.equal(t.inputSchema.type, "object");
  }
});

// ─── tools/call (catalog + config tools; no rendering) ────────────────────

test("tools/call list_body_types returns 6 body types", async () => {
  const state = makeState();
  await handshake(state);
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "list_body_types", arguments: {} },
  });
  assert.equal(res.result.isError, undefined);
  assert.deepEqual(res.result.structuredContent.bodyTypes, [
    "male",
    "female",
    "teen",
    "child",
    "muscular",
    "pregnant",
  ]);
});

test("tools/call unknown tool returns -32602", async () => {
  const state = makeState();
  await handshake(state);
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "no_such_tool" },
  });
  assert.equal(res.error.code, -32602);
});

test("tools/call list_items filters by typeName", async () => {
  const state = makeState();
  await handshake(state);
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "list_items", arguments: { typeName: "weapon" } },
  });
  const { items } = res.result.structuredContent;
  assert.ok(items.length > 0);
  for (const it of items) {
    assert.equal(it.typeName, "weapon");
    assert.ok(it.itemId);
  }
});

test("tools/call get_item returns metadata; missing item is an isError result", async () => {
  const state = makeState();
  await handshake(state);
  const ok = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "get_item", arguments: { itemId: "body" } },
  });
  assert.equal(ok.result.structuredContent.itemId, "body");

  const bad = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "get_item", arguments: { itemId: "does_not_exist" } },
  });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /not in catalog/);
});

test("tools/call suggest_animation_preset recommends a set for a role", async () => {
  const state = makeState();
  await handshake(state);
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "suggest_animation_preset", arguments: { role: "最终 BOSS" } },
  });
  const sc = res.result.structuredContent;
  assert.equal(sc.recommended.label, "BOSS / 精英怪");
  assert.ok(sc.recommended.animations.includes("slash"));
});

// ─── validateConfig + build_config ────────────────────────────────────────

test("validateConfig fills the default body/head/expression trio", () => {
  const res = _validateConfig({ bodyType: "female" });
  assert.equal(res.ok, true);
  const sel = res.config.selections;
  assert.equal(sel.body.itemId, "body");
  assert.match(sel.head.itemId, /^heads_human_(female|male)$/);
  assert.equal(sel.expression.itemId, "face_neutral");
  assert.equal(res.config.version, 2);
  assert.equal(res.config.selectedAnimation, "walk");
});

test("validateConfig accepts the map form and preserves empty-string variants", () => {
  const res = _validateConfig({
    bodyType: "male",
    selections: {
      head: { itemId: "heads_human_male", variant: "", recolor: "light" },
    },
    animations: ["idle", "walk", "walk"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.config.selections.head.itemId, "heads_human_male");
  assert.equal(res.config.selections.head.variant, "");
  // duplicates de-duplicated, order kept
  assert.deepEqual(res.config.animations, ["idle", "walk"]);
});

test("validateConfig rejects unknown bodyType / animations / itemId", () => {
  assert.equal(_validateConfig({ bodyType: "robot" }).ok, false);
  assert.equal(_validateConfig({ animations: ["fly"] }).ok, false);
  const badItem = _validateConfig({
    selections: [{ itemId: "definitely_not_an_item" }],
  });
  assert.equal(badItem.ok, false);
  assert.match(badItem.message, /not found in catalog/);
});

test("tools/call build_config returns a re-importable version-2 document", async () => {
  const state = makeState();
  await handshake(state);
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "build_config",
      arguments: {
        bodyType: "male",
        selections: [
          { typeName: "hair", itemId: "hair_natural", variant: "violet" },
        ],
        animations: ["idle", "walk"],
      },
    },
  });
  const cfg = res.result.structuredContent;
  assert.equal(cfg.version, 2);
  assert.equal(cfg.bodyType, "male");
  assert.equal(cfg.selections.hair.itemId, "hair_natural");
  assert.equal(cfg.selectedAnimation, "idle");
  assert.ok(cfg.selections.body, "default body trio still present");
});

test("tools/call build_config invalid args produce isError results", async () => {
  const state = makeState();
  await handshake(state);
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: { name: "build_config", arguments: { bodyType: "alien" } },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /unsupported bodyType/);
});

test("generate_spritesheet with a bad config fails before any rendering", async () => {
  const state = makeState();
  await handshake(state);
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: {
      name: "generate_spritesheet",
      arguments: { animations: ["teleport"] },
    },
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /unknown animations/);
});
