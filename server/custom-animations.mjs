// custom-animations.mjs — server-side registry of the custom (non-standard)
// animations defined in sources/custom-animations.ts.
//
// Why a JS mirror: sources/custom-animations.ts is browser TypeScript (no TS
// loader under `node --test` / the MCP stdio server). Only the export-relevant
// metadata is mirrored here — frame layout (which source frames map where) is
// NOT needed server-side; the headless renderer reuses the real TS definitions.
// Kept in sync by the drift-guard test in tests/agent/custom-animations_spec.js.
//
// Semantics (matches how runRenderCharacter draws these):
//   - A custom animation is bound to specific items via two signals:
//       1. the item JSON's `animations` array lists the custom name
//          (e.g. sheet_definitions/tools/tool_axe.json → ["walk", "tool_axe"])
//       2. the item's layers carry `custom_animation: "<name>"`
//     An item WITHOUT the custom name in `animations` (e.g. a dagger) simply
//     participates in the standard rows (slash/thrust/…) instead.
//   - When such an item is equipped, the renderer appends a dedicated area
//     BELOW the standard 832x3456 sheet: 4 direction rows (n/w/s/e) of
//     `frameSize` px, `frameCount` columns, column j = frame j (cycle 0..n-1).
//   - `baseAnimation` names the standard animation whose body frames are
//     re-projected into the custom area (e.g. tool_axe re-draws slash frames
//     at 128px, so the body actually swings while the axe chops).

export const STANDARD_EXPORTABLE = [
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

export const CUSTOM_ANIMATIONS = {
  wheelchair: {
    label: "轮椅",
    frameSize: 64,
    frameCount: 2,
    baseAnimation: "sit",
    kind: "mobility",
    note: "轮椅移动（基于 sit 帧），只有 body/wheelchair 声明它。",
  },
  tool_rod: {
    label: "工具·挥杖",
    frameSize: 128,
    frameCount: 13,
    baseAnimation: "thrust",
    kind: "tool",
    note: "法杖/钓竿类工具的专用挥动动作，替代标准 thrust。",
  },
  slash_128: {
    label: "挥砍 128px",
    frameSize: 128,
    frameCount: 6,
    baseAnimation: "slash",
    kind: "weapon",
    note: "128px 加大挥砍，武士刀/弯刀/长剑·alt/武装剑声明它。",
  },
  backslash_128: {
    label: "单手反挥 128px",
    frameSize: 128,
    frameCount: 13,
    baseAnimation: "backslash",
    kind: "weapon",
    note: "128px 加大单手反挥。",
  },
  halfslash_128: {
    label: "单手半挥 128px",
    frameSize: 128,
    frameCount: 6,
    baseAnimation: "halfslash",
    kind: "weapon",
    note: "128px 加大单手半挥。",
  },
  thrust_128: {
    label: "突刺 128px",
    frameSize: 128,
    frameCount: 8,
    baseAnimation: "thrust",
    kind: "weapon",
    note: "128px 加大突刺。",
  },
  walk_128: {
    label: "行走 128px",
    frameSize: 128,
    frameCount: 9,
    baseAnimation: "walk",
    kind: "weapon",
    note: "128px 加大行走（武器在行走姿势下也画大帧）。弓/长柄/部分刀剑声明它。",
  },
  slash_oversize: {
    label: "挥砍 192px",
    frameSize: 192,
    frameCount: 6,
    baseAnimation: "slash",
    kind: "weapon",
    note: "192px 超大挥砍，大剑/军刀/细剑/锤/镰刀/战斧声明它。",
  },
  thrust_oversize: {
    label: "突刺 192px",
    frameSize: 192,
    frameCount: 8,
    baseAnimation: "thrust",
    kind: "weapon",
    note: "192px 超大突刺，长柄武器与法杖声明它。",
  },
  slash_reverse_oversize: {
    label: "反手挥砍 192px",
    frameSize: 192,
    frameCount: 6,
    baseAnimation: "slash",
    kind: "weapon",
    note: "192px 反向（上挑）挥砍，长剑/棍棒/回旋镖声明它。",
  },
  whip_oversize: {
    label: "鞭击 192px",
    frameSize: 192,
    frameCount: 8,
    baseAnimation: "slash",
    kind: "weapon",
    note: "192px 鞭类武器专用抽击。",
  },
  tool_whip: {
    label: "工具·挥鞭",
    frameSize: 192,
    frameCount: 8,
    baseAnimation: "slash",
    kind: "tool",
    note: "鞭子工具的专用抽击动作，替代标准 slash。",
  },
  tool_axe: {
    label: "工具·挥斧",
    frameSize: 128,
    frameCount: 10,
    baseAnimation: "slash",
    kind: "tool",
    note: "斧/镐的专用劈砍动作，替代标准 slash；tool_axe 与 tool_pickaxe 声明它。",
  },
  tool_hammer: {
    label: "工具·锤击",
    frameSize: 128,
    frameCount: 9,
    baseAnimation: "slash",
    kind: "tool",
    note: "锤子的专用敲击动作，替代标准 slash。",
  },
};

export function isCustomAnimation(name) {
  return Object.prototype.hasOwnProperty.call(CUSTOM_ANIMATIONS, name);
}

/** Registry entries as [{ value, label, frameSize, frameCount, baseAnimation, kind, note }] */
export function listCustomAnimations() {
  return Object.entries(CUSTOM_ANIMATIONS).map(([value, def]) => ({
    value,
    label: def.label,
    custom: true,
    frameSize: def.frameSize,
    frameCount: def.frameCount,
    baseAnimation: def.baseAnimation,
    kind: def.kind,
    note: def.note,
  }));
}

export function customAnimationNames() {
  return Object.keys(CUSTOM_ANIMATIONS);
}
