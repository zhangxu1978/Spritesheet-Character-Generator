// animation-presets.mjs — role → recommended animation list, shared by
// server/agent-handler.mjs (/api/agent/suggest_animation_preset) and
// server/mcp/tools.mjs (suggest_animation_preset MCP tool).
//
// Extracted from agent-handler.mjs so the table lives in exactly one server
// module (it is also mirrored in sources/agent/tools.ts for the browser —
// kept in sync by tests/agent/tools_spec.js).

const FULL_SHEET_ANIMATIONS = [
  "spellcast", "thrust", "walk", "slash", "shoot", "hurt", "climb",
  "idle", "jump", "sit", "emote", "run", "combat",
  "1h_backslash", "1h_halfslash",
];

const ANIMATION_PRESETS = [
  { keywords: ["摆件", "静态", "装饰", "prop", "static", "柱子", "火炬", "招牌", "箱子"],
    label: "静态摆件", animations: ["idle"],
    rationale: "没有移动，只需要一个待机帧即可；通常只占 1 行 (256px 高)。" },
  { keywords: ["村民", "npc", "老板", "平民", "villager", "shop", "老人", "小孩", "路人"],
    label: "普通 NPC / 村民", animations: ["idle", "walk"],
    rationale: "大部分时间站着说话，偶尔走动；不需要战斗相关动作。约 2 行 (512px)。" },
  { keywords: ["商人", "商店", "黑商", "merchant", "banker", "柜员"],
    label: "商人 / 柜员", animations: ["idle", "emote"],
    rationale: "站在柜台后，只需待机 + 表情/招呼。" },
  { keywords: ["坐", "椅子", "王座", "throne", "sit", "赌桌", "吧台"],
    label: "坐着的角色", animations: ["idle", "sit"],
    rationale: "有「坐下」动画的 NPC（酒馆、王座、赌场）。" },
  { keywords: ["门卫", "守卫", "guard", "哨兵", "sentry", "士兵"],
    label: "守卫 / 哨兵", animations: ["idle", "walk", "hurt"],
    rationale: "巡逻 + 受击；无需挥砍/射击（除非剧情需要）。" },
  { keywords: ["小怪", "杂兵", "enemy", "monster", "怪", "小兵"],
    label: "普通怪物 / 杂兵", animations: ["idle", "walk", "hurt", "slash"],
    rationale: "需要追击 + 挨打 + 近战攻击；远程再补上 shoot。" },
  { keywords: ["远程怪", "弓手", "法师怪", "archer", "caster", "mage enemy"],
    label: "远程怪物", animations: ["idle", "walk", "hurt", "shoot", "spellcast"],
    rationale: "附带射击或施法动作。" },
  { keywords: ["boss", "首领", "精英", "elite", "头目"],
    label: "BOSS / 精英怪", animations: ["idle", "walk", "run", "hurt", "slash", "spellcast", "jump"],
    rationale: "动作越丰富越好；需要时再加 thrust / shoot 等。" },
  { keywords: ["玩家", "主角", "player", "hero", "可操作", "pc"],
    label: "玩家 / 主角（完整版）",
    animations: ["spellcast", "thrust", "walk", "slash", "shoot", "hurt", "climb", "idle", "jump", "sit", "emote", "run"],
    rationale: "所有常用动作全部打包。" },
  { keywords: ["坐骑", "宠物", "mount", "pet", "马", "狗", "猫"],
    label: "坐骑 / 宠物", animations: ["idle", "walk", "run", "hurt"],
    rationale: "跑走 + 受击即可；复杂的再加 jump / emote。" },
  { keywords: ["攀爬", "爬梯", "梯子", "climb", "rope", "藤蔓"],
    label: "需要攀爬的场景角色", animations: ["idle", "walk", "climb"],
    rationale: "带攀爬专用动画。" },
];

/**
 * Pure function: recommend an animation preset for a role description.
 * Empty/blank role → return the full preset menu with a hint instead.
 */
export function suggestAnimationPresetData(role) {
  const raw = ((role ?? "") + "").toLowerCase();
  const weaponAnimationNote =
    "武器/工具专属动作提醒：斧/镐的攻击动作是 tool_axe、锤是 tool_hammer、鞭是 tool_whip、法杖/钓竿是 tool_rod，" +
    "这些不是标准 slash/thrust；大剑/长柄/弓等还有加大动作（slash_oversize / thrust_oversize / walk_128 等）。" +
    "装备哪件武器就先用 get_item 查它的 animations 字段，把其中列出的动作名加进导出列表，否则导出的角色没有武器攻击帧。";
  if (!raw.trim()) {
    return {
      hint: "请先告诉我这个角色的用途",
      presets: ANIMATION_PRESETS.map((p) => ({ label: p.label, animations: p.animations })),
      weaponAnimationNote,
    };
  }
  let best = ANIMATION_PRESETS.find((p) => p.keywords.some((kw) => raw.includes((kw + "").toLowerCase())));
  if (!best) best = ANIMATION_PRESETS[1]; // villager fallback
  const matches = ANIMATION_PRESETS.filter((p) => p.keywords.some((kw) => raw.includes((kw + "").toLowerCase())));
  return {
    matchedRole: role,
    recommended: { label: best.label, animations: best.animations, rationale: best.rationale },
    alternatives: matches
      .filter((m) => m.label !== best.label)
      .map((m) => ({ label: m.label, animations: m.animations, rationale: m.rationale })),
    fullSheetAnimations: FULL_SHEET_ANIMATIONS.slice(),
    weaponAnimationNote,
  };
}
