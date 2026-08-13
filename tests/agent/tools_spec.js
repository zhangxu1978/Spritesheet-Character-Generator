// tests/agent/tools_spec.js — schema-level smoke tests for the Agent tools.
//
// We don't need a DOM for this; we import the JSON Schema definitions and
// assert they are well-formed and contain the tools we promise to expose.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// We extract the schemas from the TS source by string match (no TS compiler
// in node:test). This keeps the test dependency-free.

function readToolsTs() {
  return fs.readFileSync(
    path.join(PROJECT_ROOT, "sources", "agent", "tools.ts"),
    "utf8",
  );
}

function readHandlerSchemas() {
  const m = fs
    .readFileSync(
      path.join(PROJECT_ROOT, "server", "agent-handler.mjs"),
      "utf8",
    )
    .match(/const TOOL_SCHEMAS = \[([\s\S]*?)\n\];/);
  if (!m) throw new Error("TOOL_SCHEMAS not found in agent-handler.mjs");
  const names = [
    ...m[1].matchAll(/name:\s*"([^"]+)"/g),
  ].map((x) => x[1]);
  return names;
}

test("tools.ts exports the 12 expected tool names", () => {
  const src = readToolsTs();
  const expected = [
    "list_categories",
    "list_items",
    "get_item",
    "list_body_types",
    "list_animations",
    "get_state",
    "set_body_type",
    "set_selection",
    "clear_selection",
    "set_animation",
    "render_spritesheet",
    "reset_to_defaults",
  ];
  for (const name of expected) {
    assert.match(src, new RegExp(`name:\\s*"${name}"`), `tools.ts missing ${name}`);
  }
});

test("agent-handler.mjs exposes the same tool names", () => {
  const ts = readToolsTs();
  const handlerNames = readHandlerSchemas();
  const tsNames = [...ts.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  // Drop duplicates (each tool is registered once).
  const uniqueTs = [...new Set(tsNames)];
  // The handler may include some duplicate string-literal references (e.g.
  // for body_type enum values) — filter to known tool prefixes.
  const handlerTools = handlerNames.filter((n) =>
    [
      "list_",
      "get_",
      "set_",
      "clear_",
      "render_",
      "reset_",
      "suggest_",
    ].some((p) => n.startsWith(p)),
  );
  for (const name of uniqueTs) {
    assert.ok(
      handlerTools.includes(name),
      `handler schemas missing ${name}`,
    );
  }
});

test("echo stub produces a render_spritesheet tool call for any input", async () => {
  const stub = await import(
    pathToFileURL(
      path.join(PROJECT_ROOT, "server", "agent-stub.mjs"),
    ).href
  );
  const plan = stub.planFromKeywords("红色长发的女法师走一下", []);
  assert.ok(Array.isArray(plan.toolCalls));
  assert.ok(plan.toolCalls.length >= 1);
  const last = plan.toolCalls[plan.toolCalls.length - 1];
  assert.equal(last.name, "render_spritesheet");
});

test("echo stub picks bodyType and color from keywords", async () => {
  const stub = await import(
    pathToFileURL(
      path.join(PROJECT_ROOT, "server", "agent-stub.mjs"),
    ).href
  );
  const plan = stub.planFromKeywords("蓝色法师 施法", []);
  const names = plan.toolCalls.map((c) => c.name);
  assert.ok(names.includes("set_body_type"));
  assert.ok(names.includes("set_selection"));
  const setBody = plan.toolCalls.find((c) => c.name === "set_body_type");
  assert.ok(setBody, "set_body_type missing");
  // Body type default for "法师" role is female.
  assert.equal(setBody.arguments.bodyType, "female");
  const setSel = plan.toolCalls.find(
    (c) => c.name === "set_selection" && c.arguments.typeName === "body",
  );
  assert.ok(setSel, "body selection missing");
  assert.equal(setSel.arguments.selection.recolor, "blue");
});

test("echo stub falls back to walk when no animation keyword", async () => {
  const stub = await import(
    pathToFileURL(
      path.join(PROJECT_ROOT, "server", "agent-stub.mjs"),
    ).href
  );
  const plan = stub.planFromKeywords("随便生成一个角色", []);
  // No animation keyword present, so no set_animation tool call is expected.
  const names = plan.toolCalls.map((c) => c.name);
  assert.equal(names.includes("set_animation"), false);
  // But a render call should still happen.
  assert.ok(names.includes("render_spritesheet"));
});