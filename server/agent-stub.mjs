// agent-stub.mjs — keyword-based fallback for /api/agent/chat.
//
// When MiniMax is unavailable (no key, network error, etc.), we run a tiny
// deterministic stub: parse the last user message for color / role / body /
// animation keywords and emit a sequence of tool calls that, when run on
// the client, produce a sensible character.
//
// This is deliberately NOT a general-purpose LLM — it exists so the demo
// works without keys. Real interactions should go through minimax-client.mjs.

const COLOR_KEYWORDS = [
  ["red", "红", "红色", "红发"],
  ["blue", "蓝", "蓝色"],
  ["green", "绿", "绿色"],
  ["black", "黑", "黑色"],
  ["white", "白", "白色"],
  ["purple", "紫", "紫色"],
  ["gold", "金", "金色"],
  ["silver", "银", "银色"],
  ["orange", "橙", "橙色"],
  ["brown", "棕", "棕色", "棕发"],
  ["gray", "灰", "灰色"],
  ["light", "light", "浅", "浅色"],
  ["dark", "dark", "深", "深色"],
];

const BODY_KEYWORDS = [
  ["male", "男", "男性", "man"],
  ["female", "女", "女性", "woman"],
  ["teen", "青少年", "少年", "teenager"],
  ["child", "儿童", "小孩", "kid"],
  ["muscular", "肌肉", "壮", "muscle"],
  ["pregnant", "孕妇", "孕"],
];

const ANIMATION_KEYWORDS = [
  ["walk", "走", "行走", "walking"],
  ["run", "跑", "奔跑", "running"],
  ["slash", "砍", "挥砍", "挥"],
  ["shoot", "射", "射击"],
  ["thrust", "刺", "突刺"],
  ["idle", "待", "待机", "站", "站立"],
  ["sit", "坐", "坐下"],
  ["jump", "跳", "跳跃"],
  ["climb", "爬", "攀爬"],
  ["hurt", "受伤", "hurt"],
  ["spellcast", "施法", "法术", "spell"],
];

const ROLE_PRESETS = {
  mage: {
    bodyType: "female",
    color: "blue",
    animation: "spellcast",
    extra: ["torso/clothes/robe_strap_long.png"],
  },
  warrior: {
    bodyType: "muscular",
    color: "red",
    animation: "slash",
    extra: ["torso/armor/chainmail.png"],
  },
  archer: {
    bodyType: "female",
    color: "green",
    animation: "shoot",
    extra: ["torso/clothes/longsleeve.png"],
  },
  knight: {
    bodyType: "muscular",
    color: "silver",
    animation: "combat",
    extra: ["torso/armor/plate_cuirass.png"],
  },
  thief: {
    bodyType: "teen",
    color: "black",
    animation: "walk",
    extra: ["torso/clothes/hood_longsleeve.png"],
  },
  ninja: {
    bodyType: "teen",
    color: "black",
    animation: "slash",
    extra: [],
  },
};

const ROLE_KEYWORDS = [
  ["mage", "法师", "wizard"],
  ["warrior", "战士", "warrior"],
  ["archer", "弓箭手", "archer"],
  ["knight", "骑士", "knight"],
  ["thief", "盗贼", "rogue"],
  ["ninja", "忍者", "ninja"],
];

// Role / usage presets for selective animation export.
// Each entry: [keywords..., label, animations[]]
// Empty animations[] means "full sheet" (player / hero).
const USAGE_PRESETS = [
  [["摆件", "静态", "装饰", "柱子", "火炬", "招牌", "箱子", "prop", "static"], "静态摆件", ["idle"]],
  [["村民", "npc", "老板", "平民", "villager", "老人", "小孩", "路人"], "普通 NPC", ["idle", "walk"]],
  [["商人", "商店", "黑商", "merchant", "banker", "柜员"], "商人", ["idle", "emote"]],
  [["坐", "椅子", "王座", "throne", "sit", "赌桌", "吧台"], "坐着的角色", ["idle", "sit"]],
  [["门卫", "守卫", "guard", "哨兵", "sentry", "士兵"], "守卫", ["idle", "walk", "hurt"]],
  [["小怪", "杂兵", "enemy", "monster", "怪", "小兵"], "普通怪物", ["idle", "walk", "hurt", "slash"]],
  [["远程怪", "弓手", "法师怪", "archer", "caster", "mage enemy"], "远程怪物", ["idle", "walk", "hurt", "shoot", "spellcast"]],
  [["boss", "首领", "精英", "elite", "头目"], "BOSS", ["idle", "walk", "run", "hurt", "slash", "spellcast", "jump"]],
  [["坐骑", "宠物", "mount", "pet", "马", "狗", "猫"], "坐骑/宠物", ["idle", "walk", "run", "hurt"]],
  [["攀爬", "爬梯", "梯子", "climb", "藤蔓"], "攀爬角色", ["idle", "walk", "climb"]],
  [["玩家", "主角", "player", "hero", "可操作", "pc", "完整版", "全部动作", "完整"], "玩家主角", []],
];

function detectUsagePreset(text) {
  const t = text.toLowerCase();
  for (const [keywords, label, animations] of USAGE_PRESETS) {
    if (keywords.some((kw) => t.includes(kw.toLowerCase()))) {
      return { label, animations };
    }
  }
  return null;
}

/**
 * Translate one user message into a sequence of tool calls.
 * Returns a structured result: { assistantText, toolCalls }.
 *
 * @param {string} userText
 * @param {ToolDef[]} toolDefs   for validation (unused for now)
 * @returns {{ assistantText: string, toolCalls: Array<{name:string, arguments:object}> }}
 */
export function planFromKeywords(userText, toolDefs) {
  void toolDefs;
  const text = (userText || "").toLowerCase();
  const calls = [];

  // 1. bodyType
  let bodyType = null;
  for (const [val, ...keys] of BODY_KEYWORDS) {
    if (keys.some((k) => text.includes(k.toLowerCase()))) {
      bodyType = val;
      break;
    }
  }

  // 2. color
  let color = null;
  for (const [val, ...keys] of COLOR_KEYWORDS) {
    if (keys.some((k) => text.includes(k.toLowerCase()))) {
      color = val;
      break;
    }
  }

  // 3. role preset (may override bodyType/color)
  let role = null;
  for (const [val, ...keys] of ROLE_KEYWORDS) {
    if (keys.some((k) => text.includes(k.toLowerCase()))) {
      role = val;
      break;
    }
  }
  let preset = null;
  if (role && ROLE_PRESETS[role]) {
    preset = ROLE_PRESETS[role];
    if (!bodyType) bodyType = preset.bodyType;
    if (!color) color = preset.color;
  }

  // 4. animation
  let animation = null;
  for (const [val, ...keys] of ANIMATION_KEYWORDS) {
    if (keys.some((k) => text.includes(k.toLowerCase()))) {
      animation = val;
      break;
    }
  }
  if (!animation && preset) animation = preset.animation;

  if (bodyType) {
    calls.push({ name: "set_body_type", arguments: { bodyType } });
  }
  if (color) {
    // Pick the body item with the matching recolor.
    calls.push({
      name: "set_selection",
      arguments: {
        typeName: "body",
        selection: {
          itemId: "body",
          name: `Body (${color})`,
          recolor: color,
          variant: null,
        },
      },
    });
    calls.push({
      name: "set_selection",
      arguments: {
        typeName: "head",
        selection: {
          itemId: "heads_human_male",
          name: `Head (${color})`,
          recolor: color,
          variant: null,
        },
      },
    });
  }
  if (animation) {
    calls.push({ name: "set_animation", arguments: { animation } });
  }

  // 5. Usage preset (NPC / BOSS / player / ...) → selective animation export
  const usage = detectUsagePreset(userText);

  // Always end with a render so the user gets an image.
  const renderArgs = { includeImage: true };
  if (usage && usage.animations.length > 0) {
    renderArgs.animations = usage.animations;
  }
  calls.push({
    name: "render_spritesheet",
    arguments: renderArgs,
  });

  const assistantText = describePlan({ role, bodyType, color, animation, usage });
  return { assistantText, toolCalls: calls };
}

function describePlan(p) {
  const parts = [];
  if (p.role) parts.push(`职业：${p.role}`);
  if (p.bodyType) parts.push(`身体类型：${p.bodyType}`);
  if (p.color) parts.push(`主色：${p.color}`);
  if (p.animation) parts.push(`演示动作：${p.animation}`);
  if (p.usage) {
    if (p.usage.animations.length > 0) {
      parts.push(`用途：${p.usage.label}（精简导出 ${p.usage.animations.length} 个动作：${p.usage.animations.join("、")}）`);
    } else {
      parts.push(`用途：${p.usage.label}（完整大表）`);
    }
  }
  return parts.length
    ? `已为你生成角色：${parts.join("，")}。`
    : "已渲染当前角色。";
}