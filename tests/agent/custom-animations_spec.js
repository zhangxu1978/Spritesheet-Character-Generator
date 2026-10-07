// tests/agent/custom-animations_spec.js — asserts for the server-side custom
// animation registry (server/custom-animations.mjs) and a drift guard against
// the browser TypeScript source (sources/custom-animations.ts).
//
// The registry is what MCP agents see in list_animations / get_item
// animationGuide — it must stay in sync with the definitions the renderer
// actually uses, otherwise agents would be told to request animations that
// render differently (or not at all).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const {
  CUSTOM_ANIMATIONS,
  listCustomAnimations,
  customAnimationNames,
  isCustomAnimation,
} = await import(
  pathToFileURL(path.join(PROJECT_ROOT, "server", "custom-animations.mjs")).href
);

test("registry covers the tool / oversize / 128 animations", () => {
  for (const name of [
    "tool_axe",
    "tool_hammer",
    "tool_whip",
    "tool_rod",
    "wheelchair",
    "slash_128",
    "backslash_128",
    "halfslash_128",
    "thrust_128",
    "walk_128",
    "slash_oversize",
    "thrust_oversize",
    "slash_reverse_oversize",
    "whip_oversize",
  ]) {
    assert.ok(CUSTOM_ANIMATIONS[name], `registry missing ${name}`);
  }
});

test("every entry has a positive frame size/count and a standard base animation", () => {
  for (const [name, def] of Object.entries(CUSTOM_ANIMATIONS)) {
    assert.ok(def.frameSize >= 64, `${name} frameSize`);
    assert.ok(def.frameCount > 0, `${name} frameCount`);
    assert.ok(def.label, `${name} label`);
    assert.ok(def.baseAnimation, `${name} baseAnimation`);
    assert.ok(def.note, `${name} note`);
  }
});

test("listCustomAnimations / customAnimationNames / isCustomAnimation agree", () => {
  const names = customAnimationNames();
  const listed = listCustomAnimations();
  assert.equal(listed.length, names.length);
  for (const name of names) {
    assert.equal(isCustomAnimation(name), true);
  }
  assert.equal(isCustomAnimation("slash"), false);
  assert.equal(isCustomAnimation("nonsense"), false);
  // Standard animations must never leak into the custom registry.
  for (const standard of [
    "spellcast",
    "thrust",
    "walk",
    "slash",
    "shoot",
    "hurt",
    "climb",
    "idle",
    "jump",
    "sit",
    "emote",
    "run",
    "combat",
    "1h_backslash",
    "1h_halfslash",
  ]) {
    assert.equal(
      isCustomAnimation(standard),
      false,
      `${standard} must stay a standard animation`,
    );
  }
});

// ─── Drift guard (TS vs MJS) ─────────────────────────────────────────────

test("sources/custom-animations.ts stays in sync with server/custom-animations.mjs", () => {
  const ts = fs.readFileSync(
    path.join(PROJECT_ROOT, "sources", "custom-animations.ts"),
    "utf8",
  );
  // Parse the TS definitions block by block: an entry opens with
  // `  name: {` (2-space indent) and closes with `  },`. Inside, grab the
  // `frameSize: N` value (key order varies — walk_128 sets
  // skipFirstFrameInPreview first).
  const tsByName = new Map();
  let current = null;
  for (const line of ts.split("\n")) {
    const open = line.match(/^ {2}(\w+): \{$/);
    if (open) {
      current = open[1];
      tsByName.set(current, null);
      continue;
    }
    if (current === null) continue;
    const size = line.match(/^ {4}frameSize: (\d+),$/);
    if (size) tsByName.set(current, Number(size[1]));
    if (/^ {2}\},?$/.test(line)) current = null;
  }
  assert.ok(tsByName.size > 0, "no definitions found in custom-animations.ts");

  for (const [name, size] of tsByName) {
    assert.ok(
      CUSTOM_ANIMATIONS[name],
      `TS defines "${name}" but the server registry does not`,
    );
    assert.ok(size !== null, `"${name}" has no frameSize in TS`);
    assert.equal(
      CUSTOM_ANIMATIONS[name].frameSize,
      size,
      `${name} frameSize drifted between TS and the server registry`,
    );
  }
  for (const name of Object.keys(CUSTOM_ANIMATIONS)) {
    assert.ok(
      tsByName.has(name),
      `server registry has "${name}" but sources/custom-animations.ts does not`,
    );
  }
});
