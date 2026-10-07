// tests/agent/spritesheet-meta_spec.js — assertions for the spritesheet
// meta generator. Exercises the JS mirror at server/spritesheet-meta.mjs
// (kept in sync with sources/agent/spritesheet-meta.ts by the drift
// guard test at the bottom of this file).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const meta = await import(
  pathToFileURL(path.join(PROJECT_ROOT, "server", "spritesheet-meta.mjs")).href
);

const { buildSpritesheetMeta, makePngFilename, makeMetaFilename } = meta;

const FULL_SHEET_WIDTH = 832;
const FULL_SHEET_HEIGHT = 3456;

const EXPORTABLE_ANIMATIONS = [
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
];

// ─── Filename helpers ───────────────────────────────────────────────────

test("makePngFilename produces character-<tag>-<ts>.png", () => {
  assert.equal(
    makePngFilename("full", 1700000000000),
    "character-full-1700000000000.png",
  );
  assert.equal(makePngFilename("idle_walk", 42), "character-idle_walk-42.png");
});

test("makeMetaFilename swaps .png for .json", () => {
  assert.equal(
    makeMetaFilename("character-full-1700000000000.png"),
    "character-full-1700000000000.json",
  );
  // case-insensitive on the extension
  assert.equal(
    makeMetaFilename("character-idle_walk-42.PNG"),
    "character-idle_walk-42.json",
  );
});

// ─── Full sheet ─────────────────────────────────────────────────────────

test("full sheet: 15 exportable animations, correct grid size", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "character-full-1.png",
    pngBytes: 12345,
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: FULL_SHEET_HEIGHT,
    bodyType: "male",
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(m.pngFilename, "character-full-1.png");
  assert.equal(m.pngBytes, 12345);
  assert.equal(m.sheetWidth, FULL_SHEET_WIDTH);
  assert.equal(m.sheetHeight, FULL_SHEET_HEIGHT);
  assert.equal(m.frameWidth, 64);
  assert.equal(m.frameHeight, 64);
  assert.equal(m.frameColumns, 13);
  assert.equal(m.frameRows, 4);
  assert.deepEqual(m.directions, ["up", "left", "down", "right"]);
  assert.equal(m.bodyType, "male");
  assert.equal(m.generatedAt, "2026-01-01T00:00:00.000Z");
  // No includedAnimations when exporting the full sheet.
  assert.equal(m.includedAnimations, undefined);
});

test("full sheet: skips noExport animations (watering, 1h_slash)", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: FULL_SHEET_HEIGHT,
    bodyType: "male",
  });
  for (const name of EXPORTABLE_ANIMATIONS) {
    assert.ok(m.animations[name], `expected ${name} to be present`);
  }
  assert.equal(m.animations["watering"], undefined);
  assert.equal(m.animations["1h_slash"], undefined);
});

test("full sheet: spellcast starts at (0, 0); walk starts at (64, 512)", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: FULL_SHEET_HEIGHT,
    bodyType: "male",
  });
  const spellcastFrames = m.animations.spellcast.frames;
  assert.equal(spellcastFrames[0].x, 0);
  assert.equal(spellcastFrames[0].y, 0);
  assert.equal(spellcastFrames[0].frameNumber, 0);
  assert.equal(spellcastFrames[0].direction, 0);
  assert.equal(spellcastFrames[0].directionLabel, "up");

  // walk: row=8, so y=8*64=512. cycle[0]=1, so x=1*64=64.
  const walkFrames = m.animations.walk.frames;
  assert.equal(walkFrames[0].x, 64);
  assert.equal(walkFrames[0].y, 512);
  assert.equal(walkFrames[0].frameNumber, 1);
});

test("full sheet: single-direction anims (hurt/climb) emit directionLabel 'single'", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: FULL_SHEET_HEIGHT,
    bodyType: "male",
  });
  assert.equal(m.animations.hurt.directions, 1);
  assert.equal(m.animations.hurt.frames[0].directionLabel, "single");
  assert.equal(m.animations.climb.directions, 1);
  assert.equal(m.animations.climb.frames[0].directionLabel, "single");
});

test("full sheet: cycle array is preserved verbatim", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: FULL_SHEET_HEIGHT,
    bodyType: "male",
  });
  assert.deepEqual(
    m.animations.shoot.cycle,
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  assert.deepEqual(m.animations.idle.cycle, [0, 0, 1]);
});

test("full sheet: cycleIndex maps 1:1 across frames", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: FULL_SHEET_HEIGHT,
    bodyType: "male",
  });
  // shoot has 4 directions × 13 cycle steps = 52 frames
  assert.equal(m.animations.shoot.frames.length, 4 * 13);
  // first 13 belong to direction 0 (up); cycleIndex 0..12
  for (let i = 0; i < 13; i++) {
    assert.equal(m.animations.shoot.frames[i].direction, 0);
    assert.equal(m.animations.shoot.frames[i].cycleIndex, i);
  }
  // next 13 belong to direction 1 (left)
  for (let i = 0; i < 13; i++) {
    assert.equal(m.animations.shoot.frames[13 + i].direction, 1);
    assert.equal(m.animations.shoot.frames[13 + i].cycleIndex, i);
    assert.equal(m.animations.shoot.frames[13 + i].directionLabel, "left");
  }
});

// ─── Selective export ───────────────────────────────────────────────────

test("selective export: idle + walk packs to 2×4×64 = 512px", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "character-idle_walk-1.png",
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: FULL_SHEET_HEIGHT,
    bodyType: "female",
    includedAnimations: ["idle", "walk"],
  });
  // idle uses 4 rows, walk uses 4 rows → 8 rows → 512 px.
  assert.equal(m.sheetHeight, 8 * 64);
  assert.equal(m.sheetWidth, FULL_SHEET_WIDTH);
  assert.deepEqual(m.includedAnimations, ["idle", "walk"]);
  assert.equal(m.bodyType, "female");

  // Only those two keys exist.
  assert.deepEqual(Object.keys(m.animations).sort(), ["idle", "walk"]);

  // idle occupies rows 0..3, walk occupies rows 4..7.
  assert.equal(m.animations.idle.row, 0);
  assert.equal(m.animations.walk.row, 4);
  assert.equal(m.animations.walk.frames[0].y, 4 * 64);
});

test("selective export: preserves caller order, dedupes", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: FULL_SHEET_HEIGHT,
    bodyType: "male",
    includedAnimations: ["walk", "idle", "walk", "slash"],
  });
  // walk first → row 0; idle second → row 4; slash third → row 8.
  assert.deepEqual(Object.keys(m.animations), ["walk", "idle", "slash"]);
  assert.equal(m.animations.walk.row, 0);
  assert.equal(m.animations.idle.row, 4);
  assert.equal(m.animations.slash.row, 8);
  assert.deepEqual(m.includedAnimations, ["walk", "idle", "slash"]);
  assert.equal(m.sheetHeight, 12 * 64);
});

test("selective export: skips unknown animation names silently", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: FULL_SHEET_HEIGHT,
    bodyType: "male",
    includedAnimations: ["idle", "nonsense", "walk"],
  });
  // The unknown key is dropped from both the animation map and the order list.
  assert.deepEqual(Object.keys(m.animations).sort(), ["idle", "walk"]);
  assert.deepEqual(m.includedAnimations, ["idle", "walk"]);
});

test("selective export: empty includedAnimations falls back to full sheet", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: FULL_SHEET_HEIGHT,
    bodyType: "male",
    includedAnimations: [],
  });
  // Full-sheet semantics: height stays caller-supplied.
  assert.equal(m.sheetHeight, FULL_SHEET_HEIGHT);
  assert.equal(m.includedAnimations, undefined);
  assert.equal(m.animations.spellcast.row, 0);
});

test("selective export: y-coordinate of every frame matches PNG pixels", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: FULL_SHEET_WIDTH,
    sheetHeight: 512,
    bodyType: "male",
    includedAnimations: ["idle", "walk"],
  });
  for (const name of ["idle", "walk"]) {
    const a = m.animations[name];
    for (let dirIdx = 0; dirIdx < a.directions; dirIdx++) {
      for (let cycleIdx = 0; cycleIdx < a.cycle.length; cycleIdx++) {
        const f = a.frames[dirIdx * a.cycle.length + cycleIdx];
        const expectedY = (a.row + dirIdx) * 64;
        assert.equal(f.y, expectedY, `${name} dir=${dirIdx} cycle=${cycleIdx}`);
      }
    }
  }
});

// ─── Custom animations (tool_axe, …) ────────────────────────────────────

const AXE_LAYOUT = {
  name: "tool_axe",
  frameSize: 128,
  frameCount: 10,
  yOffset: 3456,
};

test("custom animation: full sheet entry uses its own frame size and absolute yOffset", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: 1280,
    sheetHeight: 3456 + 4 * 128,
    bodyType: "male",
    customAnimations: [AXE_LAYOUT],
  });
  const a = m.animations.tool_axe;
  assert.ok(a, "tool_axe entry present");
  assert.equal(a.custom, true);
  assert.equal(a.frameWidth, 128);
  assert.equal(a.frameHeight, 128);
  assert.equal(a.yOffset, 3456);
  assert.equal(a.columns, 10);
  assert.deepEqual(a.cycle, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(a.rows, 4);
  // 4 directions × 10 columns = 40 frames; frame rects use 128px.
  assert.equal(a.frames.length, 40);
  assert.equal(a.frames[0].x, 0);
  assert.equal(a.frames[0].y, 3456);
  assert.equal(a.frames[0].width, 128);
  assert.equal(a.frames[9].x, 9 * 128);
  // direction 1 (left) starts one 128px row below the area top.
  assert.equal(a.frames[10].y, 3456 + 128);
  assert.equal(a.frames[10].directionLabel, "left");
  // Standard animations keep their fixed rows.
  assert.equal(m.animations.walk.row, 8);
  // sheetHeight stays caller-provided (the real PNG height).
  assert.equal(m.sheetHeight, 3456 + 512);
});

test("custom animation: unknown custom names are filtered", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: 832,
    sheetHeight: 3456,
    bodyType: "male",
    customAnimations: [
      { name: "not_a_custom_anim", frameSize: 128, frameCount: 4 },
    ],
  });
  assert.equal(m.animations.not_a_custom_anim, undefined);
  assert.equal(Object.keys(m.animations).length, EXPORTABLE_ANIMATIONS.length);
});

test("custom animation: selective export packs mixed 64px/128px blocks", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: 1280,
    sheetHeight: 0,
    bodyType: "male",
    includedAnimations: ["walk", "tool_axe", "idle"],
    customAnimations: [AXE_LAYOUT],
  });
  // walk (4×64=256) + tool_axe (4×128=512) + idle (4×64=256) = 1024px.
  assert.equal(m.sheetHeight, 1024);
  assert.deepEqual(m.includedAnimations, ["walk", "tool_axe", "idle"]);
  assert.equal(m.animations.walk.row, 0);
  assert.equal(m.animations.tool_axe.row, 4); // 256px / 64
  assert.equal(m.animations.tool_axe.yOffset, 256);
  assert.equal(m.animations.tool_axe.frames[0].y, 256);
  assert.equal(m.animations.tool_axe.frames[0].width, 128);
  assert.equal(m.animations.idle.row, 12); // 256 + 512 = 768 → row 12
  assert.equal(m.animations.idle.frames[0].y, 12 * 64);
});

test("custom animation: selective export skips custom names without layout", () => {
  const m = buildSpritesheetMeta({
    pngFilename: "x.png",
    sheetWidth: 832,
    sheetHeight: 0,
    bodyType: "male",
    includedAnimations: ["walk", "tool_axe"],
  });
  // No customAnimations layout → tool_axe silently dropped.
  assert.deepEqual(m.includedAnimations, ["walk"]);
  assert.equal(m.animations.tool_axe, undefined);
  assert.equal(m.sheetHeight, 4 * 64);
});

// ─── Drift guard (TS vs MJS) ────────────────────────────────────────────

test("sources/agent/spritesheet-meta.ts stays in sync with server/spritesheet-meta.mjs", () => {
  const ts = fs.readFileSync(
    path.join(PROJECT_ROOT, "sources", "agent", "spritesheet-meta.ts"),
    "utf8",
  );
  // Required API surface.
  for (const symbol of [
    "SpriteFrame",
    "SpriteAnimationMeta",
    "SpritesheetMeta",
    "buildSpritesheetMeta",
    "makePngFilename",
    "makeMetaFilename",
  ]) {
    assert.match(
      ts,
      new RegExp(`\\b${symbol}\\b`),
      `TS file missing ${symbol}`,
    );
  }
  // The constants block must reference FRAME_SIZE / STANDARD_ANIMATION_FRAMES_PER_ROW /
  // ANIMATIONS / ANIMATION_OFFSETS / ANIMATION_CONFIGS / DIRECTIONS to keep parity
  // with constants.ts.
  for (const c of [
    "FRAME_SIZE",
    "STANDARD_ANIMATION_FRAMES_PER_ROW",
    "ANIMATIONS",
    "ANIMATION_OFFSETS",
    "ANIMATION_CONFIGS",
    "DIRECTIONS",
  ]) {
    assert.match(ts, new RegExp(`\\b${c}\\b`), `TS file missing ${c} import`);
  }
});
