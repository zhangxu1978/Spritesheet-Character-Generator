// tests/agent/mcp-protocol_spec.js — unit tests for the MCP protocol layer
// (server/mcp/protocol.mjs) and the MCP tool handlers (server/mcp/tools.mjs).
// Pure functions only: no stdin/stdout, no browser. generate_spritesheet runs
// against an injected fake renderer; file output goes to a tmp dir.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const {
  createProtocolState,
  handleMessage,
  parseErrorResponse,
  toolErrorResult,
} = await import(
  pathToFileURL(path.join(PROJECT_ROOT, "server", "mcp", "protocol.mjs")).href
);
const { MCP_TOOLS, createToolContext, callTool, validateConfig } = await import(
  pathToFileURL(path.join(PROJECT_ROOT, "server", "mcp", "tools.mjs")).href
);

const SERVER_INFO = { name: "lpc-spritesheet-test", version: "0.0.0-test" };

function makeState() {
  return createProtocolState({
    serverInfo: SERVER_INFO,
    tools: MCP_TOOLS,
    callTool: (name, args) => callTool(name, args, makeToolContext()),
  });
}

// 1x1 red PNG — enough for the fake renderer; nothing decodes it here.
const FAKE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeToolContext() {
  return createToolContext({
    renderer: {
      async render(config) {
        return {
          base64: FAKE_PNG_BASE64,
          width: 832,
          height: config.animations?.length
            ? config.animations.length * 4 * 64
            : 3456,
          fullWidth: 832,
          fullHeight: 3456,
          includedAnimations: config.animations ?? [],
        };
      },
    },
  });
}

// ─── Protocol layer ────────────────────────────────────────────────────────

test("initialize echoes client protocolVersion", async () => {
  const state = makeState();
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  assert.equal(res.jsonrpc, "2.0");
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2024-11-05");
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.equal(res.result.serverInfo.name, SERVER_INFO.name);
});

test("initialize falls back to default protocolVersion", async () => {
  const res = await handleMessage(makeState(), {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
  });
  assert.equal(res.result.protocolVersion, "2025-06-18");
});

test("notifications/initialized yields no response", async () => {
  const state = makeState();
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(res, null);
  assert.equal(state.initialized, true);
});

test("ping answers empty result", async () => {
  const res = await handleMessage(makeState(), {
    jsonrpc: "2.0",
    id: 3,
    method: "ping",
  });
  assert.deepEqual(res.result, {});
});

test("tools/list returns the 8 tools", async () => {
  const res = await handleMessage(makeState(), {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/list",
  });
  const names = res.result.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "list_body_types",
    "list_animations",
    "list_categories",
    "list_items",
    "get_item",
    "suggest_animation_preset",
    "build_config",
    "generate_spritesheet",
  ]);
  for (const tool of res.result.tools) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("unknown method with id → -32601", async () => {
  const res = await handleMessage(makeState(), {
    jsonrpc: "2.0",
    id: 5,
    method: "no/such",
  });
  assert.equal(res.error.code, -32601);
});

test("unknown notification yields no response", async () => {
  const res = await handleMessage(makeState(), {
    jsonrpc: "2.0",
    method: "no/such",
  });
  assert.equal(res, null);
});

test("malformed (non-object, method-less) message → -32600", async () => {
  const res = await handleMessage(makeState(), { jsonrpc: "2.0", id: 6 });
  assert.equal(res.error.code, -32600);
});

test("batch messages produce one array of non-null responses", async () => {
  const res = await handleMessage(makeState(), [
    { jsonrpc: "2.0", id: 10, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 11, method: "no/such" },
  ]);
  assert.ok(Array.isArray(res));
  assert.equal(res.length, 2);
  assert.equal(res[0].id, 10);
  assert.equal(res[1].id, 11);
});

test("all-notification batch → null", async () => {
  const res = await handleMessage(makeState(), [
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]);
  assert.equal(res, null);
});

test("parseErrorResponse is a -32700 with null id", () => {
  const res = parseErrorResponse();
  assert.equal(res.id, null);
  assert.equal(res.error.code, -32700);
});

test("tools/call with unknown tool → -32601", async () => {
  const res = await handleMessage(makeState(), {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "not_a_tool", arguments: {} },
  });
  assert.equal(res.error.code, -32601);
});

test("tools/call without name → -32602", async () => {
  const res = await handleMessage(makeState(), {
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {},
  });
  assert.equal(res.error.code, -32602);
});

test("tool crash in callTool → -32603 internal error", async () => {
  const state = createProtocolState({
    serverInfo: SERVER_INFO,
    tools: [{ name: "boom", description: "", inputSchema: { type: "object" } }],
    callTool: async () => {
      throw new Error("kaboom");
    },
  });
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: { name: "boom", arguments: {} },
  });
  assert.equal(res.error.code, -32603);
  assert.match(res.error.message, /kaboom/);
});

test("toolErrorResult shape", () => {
  const r = toolErrorResult("bad input");
  assert.equal(r.isError, true);
  assert.equal(r.content[0].type, "text");
  assert.equal(r.content[0].text, "bad input");
});

// ─── Tool handlers (via callTool directly) ────────────────────────────────

test("list_body_types / list_animations / suggest_animation_preset", async () => {
  const ctx = makeToolContext();
  const bodies = await callTool("list_body_types", {}, ctx);
  assert.deepEqual(
    bodies.content[0].text ? JSON.parse(bodies.content[0].text) : [],
    ["male", "female", "teen", "child", "muscular", "pregnant"],
  );

  const anims = await callTool("list_animations", {}, ctx);
  const animList = JSON.parse(anims.content[0].text);
  assert.ok(animList.length >= 15);
  assert.ok(animList.every((a) => typeof a.value === "string"));

  const preset = await callTool(
    "suggest_animation_preset",
    { role: "村民" },
    ctx,
  );
  const presetData = JSON.parse(preset.content[0].text);
  assert.equal(presetData.recommended.label, "普通 NPC / 村民");
  assert.deepEqual(presetData.recommended.animations, ["idle", "walk"]);
});

test("list_items + get_item round-trip a real catalog item", async () => {
  const ctx = makeToolContext();
  const listed = await callTool("list_items", { typeName: "hair" }, ctx);
  const { count, items } = JSON.parse(listed.content[0].text);
  assert.ok(count > 0);
  const first = items[0];
  const got = await callTool("get_item", { itemId: first.itemId }, ctx);
  const rec = JSON.parse(got.content[0].text);
  assert.equal(rec.itemId, first.itemId);
  assert.equal(rec.typeName, first.type_name);

  const missing = await callTool(
    "get_item",
    { itemId: "nope-does-not-exist" },
    ctx,
  );
  assert.equal(missing.isError, true);
});

// ─── validateConfig / build_config ─────────────────────────────────────────

test("validateConfig completes the default trio when selections are empty", () => {
  const v = validateConfig({});
  assert.equal(v.ok, true);
  const sel = Object.values(v.config.selections);
  assert.ok(sel.length >= 3);
  const itemIds = sel.map((s) => s.itemId);
  assert.ok(itemIds.includes("body"));
  assert.ok(itemIds.some((id) => id.startsWith("heads_human_")));
  assert.ok(itemIds.includes("face_neutral"));
  assert.equal(v.config.version, 2);
  assert.equal(v.config.bodyType, "male");
  assert.deepEqual(v.config.animations, []);
});

test("validateConfig rejects unknown bodyType / itemId / animation", () => {
  assert.equal(validateConfig({ bodyType: "giant" }).ok, false);

  const badItem = validateConfig({ selections: { torso: { itemId: "nope" } } });
  assert.equal(badItem.ok, false);
  assert.match(badItem.message, /不存在/);

  const badAnim = validateConfig({ animations: ["flying"] });
  assert.equal(badAnim.ok, false);
  assert.match(badAnim.message, /未知动作/);
});

test("validateConfig does not duplicate trio when user supplied equivalents", () => {
  const v = validateConfig({
    bodyType: "female",
    selections: {
      body: { itemId: "body", recolor: "red" },
      heads: { itemId: "heads_human_female" },
      expression: { itemId: "face_neutral" },
    },
  });
  assert.equal(v.ok, true);
  const itemIds = Object.values(v.config.selections).map((s) => s.itemId);
  assert.equal(itemIds.filter((id) => id === "body").length, 1);
  assert.equal(itemIds.filter((id) => id === "face_neutral").length, 1);
});

test("build_config returns version-2 config + metaPreview via tools/call", async () => {
  const state = makeState();
  const res = await handleMessage(state, {
    jsonrpc: "2.0",
    id: 20,
    method: "tools/call",
    params: {
      name: "build_config",
      arguments: { animations: ["idle", "walk"] },
    },
  });
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, undefined);
  assert.equal(res.result.structuredContent.config.version, 2);
  const metaPreview = JSON.parse(res.result.content[0].text).metaPreview;
  assert.equal(metaPreview.frameWidth, 64);
  assert.equal(metaPreview.frameColumns, 13);
  // idle(4 dirs) + walk(4 dirs) = 8 rows → 512px
  assert.equal(metaPreview.sheetHeight, 512);
  assert.ok(metaPreview.animations.idle);
  assert.ok(metaPreview.animations.walk);
});

test("build_config validation failure surfaces as isError result", async () => {
  const res = await handleMessage(makeState(), {
    jsonrpc: "2.0",
    id: 21,
    method: "tools/call",
    params: {
      name: "build_config",
      arguments: { bodyType: "titan" },
    },
  });
  assert.equal(res.error, undefined);
  assert.equal(res.result.isError, true);
});

// ─── generate_spritesheet with fake renderer ──────────────────────────────

test("generate_spritesheet renders via injected renderer and writes files", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-spritesheet-"));
  try {
    const ctx = makeToolContext();
    const result = await callTool(
      "generate_spritesheet",
      {
        bodyType: "female",
        animations: ["idle", "walk"],
        includeImage: true,
        outputDir: tmp,
        filePrefix: "smoke",
      },
      ctx,
    );
    assert.equal(result.isError, undefined);

    const image = result.content.find((c) => c.type === "image");
    assert.ok(image, "image content present");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.data, FAKE_PNG_BASE64);

    const summary = JSON.parse(
      result.content.find((c) => c.type === "text").text,
    );
    assert.equal(summary.png.width, 832);
    assert.deepEqual(summary.png.includedAnimations, ["idle", "walk"]);
    assert.ok(summary.files.png && summary.files.meta && summary.files.config);

    assert.ok(fs.existsSync(summary.files.png));
    assert.ok(fs.existsSync(summary.files.meta));
    assert.ok(fs.existsSync(summary.files.config));

    const meta = JSON.parse(fs.readFileSync(summary.files.meta, "utf8"));
    assert.equal(meta.frameWidth, 64);
    assert.equal(meta.sheetWidth, 832);
    // 2 animations × 4 directions = 8 rows × 64 = 512
    assert.equal(meta.sheetHeight, 512);
    assert.equal(meta.bodyType, "female");

    const config = JSON.parse(fs.readFileSync(summary.files.config, "utf8"));
    assert.equal(config.version, 2);
    assert.equal(config.bodyType, "female");
    assert.deepEqual(config.animations, ["idle", "walk"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate_spritesheet with includeImage:false omits image content", async () => {
  const ctx = makeToolContext();
  const result = await callTool(
    "generate_spritesheet",
    { animations: ["idle"], includeImage: false },
    ctx,
  );
  assert.equal(
    result.content.find((c) => c.type === "image"),
    undefined,
  );
  assert.ok(result.structuredContent.meta);
});

test("generate_spritesheet invalid config → isError", async () => {
  const ctx = makeToolContext();
  const result = await callTool(
    "generate_spritesheet",
    { animations: ["teleport"] },
    ctx,
  );
  assert.equal(result.isError, true);
});
