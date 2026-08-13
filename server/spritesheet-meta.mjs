// spritesheet-meta.mjs — JS mirror of sources/agent/spritesheet-meta.ts.
//
// Exists so `tests/agent/spritesheet-meta_spec.js` can exercise the real
// algorithm under `node --test` (which has no TS loader). The two files
// share the same constants from sources/state/constants.ts — kept in sync
// by the test that runs in CI.
//
// Why JS and not just the TS file:
//   - The TS module has zero DOM dependencies and is pure; duplicating it
//     here lets us avoid adding a TS loader to the test runner.
//   - The duplication is small (~80 lines) and the assertions in
//     spritesheet-meta_spec.js guard against drift.

const FRAME_SIZE = 64;
const STANDARD_ANIMATION_FRAMES_PER_ROW = 13;

const ANIMATIONS = [
  { value: "spellcast", label: "施法" },
  { value: "thrust", label: "突刺" },
  { value: "walk", label: "行走" },
  { value: "slash", label: "挥砍" },
  { value: "shoot", label: "射击" },
  { value: "hurt", label: "受伤" },
  { value: "climb", label: "攀爬" },
  { value: "idle", label: "待机" },
  { value: "jump", label: "跳跃" },
  { value: "sit", label: "坐下" },
  { value: "emote", label: "表情" },
  { value: "run", label: "奔跑" },
  { value: "watering", label: "浇水", noExport: true },
  { value: "combat", label: "战斗待机", folderName: "combat_idle" },
  { value: "1h_slash", label: "单手挥砍", folderName: "backslash", noExport: true },
  { value: "1h_backslash", label: "单手反挥", folderName: "backslash" },
  { value: "1h_halfslash", label: "单手半挥", folderName: "halfslash" },
];

const ANIMATION_OFFSETS = {
  spellcast: 0,
  thrust: 4 * FRAME_SIZE,
  walk: 8 * FRAME_SIZE,
  slash: 12 * FRAME_SIZE,
  shoot: 16 * FRAME_SIZE,
  hurt: 20 * FRAME_SIZE,
  climb: 21 * FRAME_SIZE,
  idle: 22 * FRAME_SIZE,
  jump: 26 * FRAME_SIZE,
  sit: 30 * FRAME_SIZE,
  emote: 34 * FRAME_SIZE,
  run: 38 * FRAME_SIZE,
  combat_idle: 42 * FRAME_SIZE,
  backslash: 46 * FRAME_SIZE,
  halfslash: 50 * FRAME_SIZE,
};

const ANIMATION_CONFIGS = {
  spellcast: { row: 0, num: 4, cycle: [0, 1, 2, 3, 4, 5, 6] },
  thrust: { row: 4, num: 4, cycle: [0, 1, 2, 3, 4, 5, 6, 7] },
  walk: { row: 8, num: 4, cycle: [1, 2, 3, 4, 5, 6, 7, 8] },
  slash: { row: 12, num: 4, cycle: [0, 1, 2, 3, 4, 5] },
  shoot: { row: 16, num: 4, cycle: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  hurt: { row: 20, num: 1, cycle: [0, 1, 2, 3, 4, 5] },
  climb: { row: 21, num: 1, cycle: [0, 1, 2, 3, 4, 5] },
  idle: { row: 22, num: 4, cycle: [0, 0, 1] },
  jump: { row: 26, num: 4, cycle: [0, 1, 2, 3, 4, 1] },
  sit: {
    row: 30,
    num: 4,
    cycle: [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2],
  },
  emote: {
    row: 34,
    num: 4,
    cycle: [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2],
  },
  run: { row: 38, num: 4, cycle: [0, 1, 2, 3, 4, 5, 6, 7] },
  watering: { row: 4, num: 4, cycle: [0, 1, 4, 4, 4, 4, 5] },
  combat: { row: 42, num: 4, cycle: [0, 0, 1] },
  "1h_slash": { row: 46, num: 4, cycle: [0, 1, 2, 3, 4, 5, 6] },
  "1h_backslash": {
    row: 46,
    num: 4,
    cycle: [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12],
  },
  "1h_halfslash": { row: 50, num: 4, cycle: [0, 1, 2, 3, 4, 5] },
};

const DIRECTIONS = ["up", "left", "down", "right"];

function isExportable(a) {
  return !a.noExport;
}

function cycleFor(name) {
  const cfg = ANIMATION_CONFIGS[name];
  if (!cfg || !Array.isArray(cfg.cycle)) return null;
  return cfg.cycle.slice();
}

function directionsFor(name) {
  const cfg = ANIMATION_CONFIGS[name];
  return cfg?.num ?? 4;
}

export function buildSpritesheetMeta(opts) {
  const now = opts.now ?? new Date();
  const allExportable = ANIMATIONS.filter(isExportable);

  let chosen;
  let includedOrder;
  if (opts.includedAnimations && opts.includedAnimations.length > 0) {
    const seen = new Set();
    const ordered = [];
    for (const name of opts.includedAnimations) {
      if (seen.has(name)) continue;
      const meta = allExportable.find((a) => a.value === name);
      if (!meta) continue;
      seen.add(name);
      ordered.push(meta);
    }
    chosen = ordered;
    includedOrder = ordered.map((a) => a.value);
  } else {
    // ANIMATION_OFFSETS is in pixels (multiples of FRAME_SIZE); convert
    // back to row indices for the JSON.
    chosen = allExportable.slice().sort(
      (a, b) =>
        (ANIMATION_OFFSETS[a.value] ?? 0) / FRAME_SIZE -
        (ANIMATION_OFFSETS[b.value] ?? 0) / FRAME_SIZE,
    );
  }

  const animations = {};
  let runningRow = 0;
  let sheetRows = 0;

  for (const meta of chosen) {
    const cycle = cycleFor(meta.value);
    if (!cycle) continue;
    const directions = directionsFor(meta.value);
    const fullSheetRow =
      (ANIMATION_OFFSETS[meta.value] ?? runningRow * FRAME_SIZE) / FRAME_SIZE;
    const isSelective =
      opts.includedAnimations && opts.includedAnimations.length > 0;
    const row = isSelective ? runningRow : fullSheetRow;

    const frames = [];
    for (let dirIdx = 0; dirIdx < directions; dirIdx++) {
      const directionLabel =
        directions === DIRECTIONS.length ? DIRECTIONS[dirIdx] ?? "single" : "single";
      const rowPx = (row + dirIdx) * FRAME_SIZE;
      for (let cycleIdx = 0; cycleIdx < cycle.length; cycleIdx++) {
        const frameNumber = cycle[cycleIdx] ?? 0;
        frames.push({
          direction: dirIdx,
          directionLabel,
          cycleIndex: cycleIdx,
          frameNumber,
          x: frameNumber * FRAME_SIZE,
          y: rowPx,
          width: FRAME_SIZE,
          height: FRAME_SIZE,
        });
      }
    }

    animations[meta.value] = {
      name: meta.value,
      label: meta.label,
      row,
      rows: directions,
      directions,
      columns: STANDARD_ANIMATION_FRAMES_PER_ROW,
      cycle,
      frames,
    };

    runningRow += directions;
    sheetRows += directions;
  }

  const isSelective =
    opts.includedAnimations && opts.includedAnimations.length > 0;
  const sheetHeight = isSelective ? sheetRows * FRAME_SIZE : opts.sheetHeight;

  return {
    pngFilename: opts.pngFilename,
    ...(opts.pngBytes !== undefined ? { pngBytes: opts.pngBytes } : {}),
    sheetWidth: opts.sheetWidth,
    sheetHeight,
    frameWidth: FRAME_SIZE,
    frameHeight: FRAME_SIZE,
    frameColumns: STANDARD_ANIMATION_FRAMES_PER_ROW,
    frameRows: DIRECTIONS.length,
    directions: DIRECTIONS.slice(),
    bodyType: opts.bodyType,
    generatedAt: now.toISOString(),
    ...(includedOrder && includedOrder.length > 0
      ? { includedAnimations: includedOrder }
      : {}),
    animations,
  };
}

export function makePngFilename(tag, ts = Date.now()) {
  return `character-${tag}-${ts}.png`;
}

export function makeMetaFilename(pngFilename) {
  return pngFilename.replace(/\.png$/i, ".json");
}