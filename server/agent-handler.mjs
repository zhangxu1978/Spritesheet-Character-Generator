// agent-handler.mjs — pure HTTP handler for /api/agent/*.
//
// Exposes a single `handle(req, res)` function so the same code can run
// under Express (server/index.mjs) and under Vite's dev middleware
// (vite/vite-plugin-agent-api.js). Pure functions = easy to test.
//
// Routes:
//   GET  /api/agent/tools                  → JSON array of ToolDef
//   POST /api/agent/run                    → { tool, arguments, snapshot? } → result
//   POST /api/agent/chat                   → { messages, snapshot?, sessionId? }
//                                             → MiniMax-driven tool loop OR echo
//
// Headless / node-canvas caveat:
//   The LPC renderer uses `document.createElement("canvas")`, so it can't run
//   in plain Node. To keep this server dependency-free, we execute only the
//   non-rendering tools on the server (set_selection / set_body_type / etc.)
//   and defer `render_spritesheet` to the browser — the client always
//   replays tool calls locally (see sources/agent/client.ts).

import { loadConfig } from "./llm-config.mjs";
import { chatCompletion } from "./minimax-client.mjs";
import { planFromKeywords } from "./agent-stub.mjs";
import { loadCatalogSnapshot } from "./catalog-snapshot.mjs";
import { suggestAnimationPresetData } from "./animation-presets.mjs";

// Minimal in-memory schema mirror so the server doesn't import the TS module.
// Keeping this in sync with sources/agent/tools.ts is enforced by the
// tools_spec.js test which reads both files.
const TOOL_SCHEMAS = [
  {
    name: "list_categories",
    description: "列出全部可装备的部件分类。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_items",
    description: "按 typeName/category 列出物品。",
    parameters: {
      type: "object",
      properties: {
        typeName: { type: "string" },
        category: { type: "string" },
        detailed: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_item",
    description: "获取单个物品的完整元数据。",
    parameters: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_body_types",
    description: "列出可选的身体类型。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_animations",
    description: "列出可选的动作。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "suggest_animation_preset",
    description:
      "根据角色用途（玩家 / NPC / 村民 / BOSS / 怪物 / 摆件 / 坐骑 等）给出推荐的动作打包清单。" +
      "纯咨询工具，不会修改 session。在第一次 render_spritesheet 之前使用，可以先给出建议让用户确认。",
    parameters: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description: "用户描述的角色定位，例如「村民 NPC」「最终 BOSS」「可操作玩家」",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_state",
    description: "获取当前 session 状态。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "set_body_type",
    description: "切换身体类型。",
    parameters: {
      type: "object",
      properties: { bodyType: { type: "string" } },
      required: ["bodyType"],
      additionalProperties: false,
    },
  },
  {
    name: "set_selection",
    description:
      "写入一个 Selection（装备部件）。selection 含 itemId / name；recolor / variant 应从 get_item 返回的 recolors / variants 里选。" +
      "有 recolors 的部件（胸甲/裤子/靴子/头发/帽子等调色板部件）如果不给 recolor，会自动填默认色。",
    parameters: {
      type: "object",
      properties: {
        typeName: { type: "string" },
        itemId: { type: "string" },
        selection: { type: "object" },
      },
      required: ["selection"],
      additionalProperties: false,
    },
  },
  {
    name: "clear_selection",
    description: "移除一个 typeName 的选择。",
    parameters: {
      type: "object",
      properties: { typeName: { type: "string" }, itemId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "set_animation",
    description: "切换预览动作（仅影响预览时显示的行，不影响导出 PNG 的内容）。",
    parameters: {
      type: "object",
      properties: { animation: { type: "string" } },
      required: ["animation"],
      additionalProperties: false,
    },
  },
  {
    name: "render_spritesheet",
    description:
      "把当前 session 渲染并导出 PNG（base64）。默认导出完整精灵表（所有动作，标准部分高 3456px；装备专属动作武器/工具时下方还有更大的动作区）。" +
      "如果是 NPC / 小怪 / 摆件等无需全套动作的角色，务必传 animations 数组只打包需要的动作，这样 PNG 会小很多。" +
      "装备武器/工具时，把 get_item 查到的专属动作名（如 tool_axe）也放进 animations，否则没有武器攻击帧。",
    parameters: {
      type: "object",
      properties: {
        animation: { type: "string", description: "可选：仅切换预览动作" },
        includeImage: { type: "boolean", description: "默认 true；false 时仅返回元数据" },
        animations: {
          type: "array",
          items: { type: "string" },
          description:
            "可选：要打包进 PNG 的动作列表（如 [\"idle\",\"walk\"]）。" +
            "可含专属动作名（tool_axe / tool_rod / slash_oversize 等，见 get_item 的 animations 字段）。" +
            "不传 / 传空数组 → 导出完整大表。",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "reset_to_defaults",
    description: "重置 session 到默认值。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

const SYSTEM_PROMPT = `你是一个精灵图（LPC spritesheet）生成助手。你的工作方式分为「理解意图 → 给出建议 → 确认后执行」三步，不要一上来就直接渲染大表！

## 工作流程（严格遵守）

1. **先理解用户意图**：用户描述角色后，先在心里回答这几个问题：
   - 这个角色是「可操作玩家 / 主角」还是「NPC」？是哪一类 NPC（村民/商人/门卫/BOSS/小怪/摆件/坐骑）？
   - 这个角色需要战斗动作吗？需要施法 / 射击吗？需要坐下 / 攀爬吗？
   - 从用户的描述里提取出外观偏好（性别、头发、衣服颜色、武器等）。

2. **给出建议再动手**：
   - 调用 suggest_animation_preset(role=...) 工具拿到匹配的推荐动作清单；
   - 在回复里用自然语言告诉用户：
     * 「我理解这个角色是 xxx（玩家 / 村民 NPC / 小怪 …）」
     * 「我建议只导出这几个动作：[idle, walk, ...]，理由是 …；这样输出 PNG 大约 N 行 / 比完整表小 70%」
     * 「如果没问题我就按这个清单生成；想要完整大表 / 想增减动作请直接说」
   - **第一次对话不要调用 render_spritesheet**，先等用户确认或修改。

3. **用户确认后再执行**：
   - 用 list_categories / list_items / get_item 查找部件；
   - 用 set_body_type / set_selection 装备外观；
   - 用 set_animation 切换预览（只是方便用户看，不影响 PNG 内容）；
   - 最后调用 render_spritesheet 时 **务必带上 animations: [...] 参数**（除非用户明确要求完整大表），把上一步确认过的动作列表传进去。

## 武器/工具 → 动作映射（重要经验，序列帧必读）

- 每个部件只渲染其元数据 animations 数组里列出的动作；标准动作（spellcast / thrust / walk / slash / shoot / hurt / climb / idle / jump / sit / emote / run / combat / 1h_backslash / 1h_halfslash）对所有部件通用。
- 工具有「专属动作」（custom），标准 slash/thrust 行里不会出现它们：
  * 斧/镐 → tool_axe（128px 劈砍）；锤 → tool_hammer（128px 锤击）；鞭 → tool_whip（192px 抽击）；法杖/钓竿 → tool_rod（128px 挥动，且鱼竿只有这一个动作）；
  * 超大武器用 192px：slash_oversize（大剑/军刀/细剑/锤/镰刀/战斧）、thrust_oversize（长柄/法杖）、slash_reverse_oversize（长剑/棍棒/回旋镖）；
  * 加大 128px：slash_128 / backslash_128 / halfslash_128 / thrust_128 / walk_128（武士刀/弯刀/武装剑/弓等）。
- **装备武器后必须先 get_item(武器itemId)**：返回的 animations 字段就是该武器支持的全部动作（也是唯一权威来源）。要攻击帧就把其中的专属动作名加进 render_spritesheet 的 animations；不加 → 导出的角色行走时手里有武器，但没有武器攻击帧。
- 例：「持斧士兵」= 军团胸甲 + 军团头盔 + 斧，animations 用 ["idle","walk","tool_axe"]；「持长剑骑士」攻击帧用 get_item 返回的 ["slash_oversize","thrust_oversize",…]；「渔夫」只有 ["tool_rod"]。
- list_animations 返回里 custom:true 的条目带 usedBy 字段（哪些武器/工具声明了它），可用来反查。

## 其它规则
- itemId 必须从 list_items / get_item 返回的字段里直接复制，不要编造；
- selection 必须含 itemId + name，以及 variant 或 recolor；
- **recolor / variant 必须从 get_item 的 recolors / variants 返回值里选**：胸甲、裤子、靴子、头发、帽子等调色板部件（get_item 返回 recolors 非空）都要配 recolor（如 "steel" / "brown"），漏了会自动填默认色但可能不符合用户要求的配色；
- set_selection 必传 typeName（body / head / torso / legs / feet / hair / weapon 等）；
- 如果用户说「随便 / 随机」，先给 NPC / 村民保守配置而不是完整大表；
- 不要在 text 里堆砌结果说明，用工具完成动作，text 只做意图确认和建议。`;

/**
 * Pure HTTP handler. Returns nothing on success (writes to res); throws on
 * unrecoverable error.
 *
 * @param {{method:string, url:string, headers:object, on:Function}} req
 * @param {{statusCode:number, setHeader:Function, end:Function}} res
 * @param {{readBody?: () => Promise<string>}} [helpers]
 */
export async function handle(req, res, helpers = {}) {
  const readBody = helpers.readBody ?? defaultReadBody(req);
  const url = req.url ?? "";
  const method = (req.method ?? "GET").toUpperCase();

  try {
    if (method === "GET" && url.startsWith("/api/agent/tools")) {
      return json(res, 200, TOOL_SCHEMAS);
    }
    if (method === "POST" && url.startsWith("/api/agent/run")) {
      const body = JSON.parse(await readBody());
      const result = await runToolCall(body, body.snapshot ?? {});
      return json(res, 200, result);
    }
    if (method === "POST" && url.startsWith("/api/agent/chat")) {
      const body = JSON.parse(await readBody());
      const result = await runChat(body);
      return json(res, 200, result);
    }
    return json(res, 404, { ok: false, error: { kind: "not-found", message: url } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(res, 500, { ok: false, error: { kind: "internal", message: msg } });
  }
}

function defaultReadBody(req) {
  return () =>
    new Promise((resolve, reject) => {
      let buf = "";
      req.on("data", (chunk) => (buf += chunk));
      req.on("end", () => resolve(buf));
      req.on("error", reject);
    });
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// ─── Headless session state mutations ────────────────────────────────────
// Server-side we don't draw pixels; we only mutate the session JSON so
// subsequent calls in the same chat see the right "current state". The
// browser replays each call on its own session to actually render.

const SESSIONS = new Map();

function getOrCreateSession(id) {
  if (!SESSIONS.has(id)) {
    SESSIONS.set(id, {
      selections: {},
      bodyType: "male",
      animation: "walk",
    });
  }
  return SESSIONS.get(id);
}

async function runToolCall(body, snapshot) {
  const sessionId = body.sessionId ?? "default";
  const session = snapshot.selections
    ? { ...getOrCreateSession(sessionId), ...snapshot }
    : getOrCreateSession(sessionId);
  SESSIONS.set(sessionId, session);

  const toolName = body.tool;
  const args = body.arguments ?? {};

  try {
    const result = applyTool(toolName, args, session);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { kind: "internal", message: msg } };
  }
}

function applyTool(name, args, session) {
  switch (name) {
    case "list_body_types":
      return { ok: true, data: ["male", "female", "teen", "child", "muscular", "pregnant"] };
    case "list_animations":
      return {
        ok: true,
        data: [
          "spellcast", "thrust", "walk", "slash", "shoot", "hurt", "climb",
          "idle", "jump", "sit", "emote", "run", "combat",
          "1h_backslash", "1h_halfslash",
        ].map((v) => ({ value: v, label: v })),
      };
    case "suggest_animation_preset":
      return { ok: true, data: suggestAnimationPresetData(args.role) };
    case "list_categories":
      return {
        ok: true,
        data: loadCatalogSnapshot().categories,
      };
    case "list_items": {
      const snap = loadCatalogSnapshot();
      let rows = snap.items;
      if (args.typeName) rows = rows.filter((r) => r.typeName === args.typeName);
      if (args.category)
        rows = rows.filter((r) =>
          (r.name ?? r.itemId).toLowerCase().includes(args.category.toLowerCase()),
        );
      return {
        ok: true,
        data: rows.map((r) => ({
          itemId: r.itemId,
          name: r.name,
          type_name: r.typeName,
          variants: r.variants,
        })),
      };
    }
    case "get_item": {
      const snap = loadCatalogSnapshot();
      const rec = snap.items.find((r) => r.itemId === args.itemId);
      if (!rec) {
        return { ok: false, error: { kind: "not-found", message: `item ${args.itemId} not in server catalog` } };
      }
      return { ok: true, data: rec };
    }
    case "get_state":
      return { ok: true, data: snapshot(session) };

    case "set_body_type":
      if (!["male", "female", "teen", "child", "muscular", "pregnant"].includes(args.bodyType)) {
        return { ok: false, error: { kind: "invalid-args", message: `unknown bodyType ${args.bodyType}` } };
      }
      session.bodyType = args.bodyType;
      return { ok: true, data: { bodyType: session.bodyType } };

    case "set_selection": {
      if (!args.selection || typeof args.selection.itemId !== "string") {
        return { ok: false, error: { kind: "invalid-args", message: "missing selection.itemId" } };
      }
      const group = args.typeName ?? args.selection.itemId;
      session.selections[group] = {
        itemId: args.selection.itemId,
        name: args.selection.name ?? args.selection.itemId,
        variant: args.selection.variant ?? null,
        recolor: args.selection.recolor ?? null,
        subId: args.selection.subId ?? null,
      };
      return { ok: true, data: { typeName: group, selection: session.selections[group] } };
    }

    case "clear_selection": {
      let group = args.typeName;
      if (!group && args.itemId) {
        group = args.itemId;
      }
      if (!group) {
        return { ok: false, error: { kind: "invalid-args", message: "must provide typeName or itemId" } };
      }
      const existed = group in session.selections;
      delete session.selections[group];
      return { ok: true, data: { typeName: group, cleared: existed } };
    }

    case "set_animation":
      session.animation = args.animation;
      return { ok: true, data: { animation: session.animation } };

    case "render_spritesheet":
      // Cannot render in plain Node (no DOM/canvas). Signal to the client
      // that it should re-run this tool locally to produce the PNG.
      session.animation = args.animation ?? session.animation;
      // Pass through the animations filter so the client replay uses it.
      const wantAnims = Array.isArray(args.animations) ? args.animations : undefined;
      return {
        ok: true,
        data: {
          deferred: true,
          message: "render_spritesheet runs in the browser; client will replay it.",
          requestedAnimations: wantAnims,
          selective: !!(wantAnims && wantAnims.length > 0),
          session: snapshot(session),
        },
      };

    case "reset_to_defaults":
      session.selections = {};
      session.bodyType = "male";
      session.animation = "walk";
      return { ok: true, data: snapshot(session) };

    default:
      return {
        ok: false,
        error: { kind: "invalid-args", message: `unsupported tool on server: ${name}` },
      };
  }
}

// ─── /api/agent/chat ─────────────────────────────────────────────────────

async function runChat(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const session = getOrCreateSession(body.sessionId ?? "default");
  if (body.snapshot && body.snapshot.selections) {
    session.selections = body.snapshot.selections;
    session.bodyType = body.snapshot.bodyType ?? session.bodyType;
    session.animation = body.snapshot.animation ?? session.animation;
  }

  const cfg = loadConfig();
  let provider = cfg?.provider ?? null;
  let toolCalls = [];
  let assistantText;

  // Try the configured provider (MiniMax). Fall back to echo on any error.
  if (provider) {
    try {
      const loopMessages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages,
      ];
      // Allow up to 5 tool-call rounds so the model can iterate.
      for (let i = 0; i < 5; i++) {
        const resp = await chatCompletion({
          messages: loopMessages,
          tools: TOOL_SCHEMAS,
        });
        if (resp.text) assistantText = resp.text;
        if (!resp.toolCalls.length) break;
        const assistantMsg = {
          role: "assistant",
          content: resp.text ?? "",
          tool_calls: resp.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
        loopMessages.push(assistantMsg);
        for (const tc of resp.toolCalls) {
          const result = applyTool(tc.name, tc.arguments, session);
          toolCalls.push({ call: tc, result });
          loopMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: JSON.stringify(result),
          });
          if (tc.name === "render_spritesheet" && result.ok) {
            // Stop the loop once we ask for a render — client will produce
            // the PNG locally and surface it via /api/agent/run or the
            // /api/agent/chat response finalImageBase64.
            i = 5;
            break;
          }
        }
      }
      const finalRender = [...toolCalls].reverse().find((t) => t.call.name === "render_spritesheet");
      return {
        finalImageBase64: undefined, // client produces locally
        toolCalls,
        assistantText,
        provider,
        session: snapshot(session),
      };
    } catch (e) {
      console.warn(`[agent] ${provider} failed: ${e instanceof Error ? e.message : e}; using echo`);
      provider = null;
      toolCalls = [];
    }
  }

  // Echo fallback
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const plan = planFromKeywords(lastUser?.content ?? "", TOOL_SCHEMAS);
  for (const call of plan.toolCalls) {
    const result = applyTool(call.name, call.arguments, session);
    toolCalls.push({ call, result });
  }
  return {
    finalImageBase64: undefined,
    toolCalls,
    assistantText: plan.assistantText,
    fallback: "echo",
    provider: provider ?? "echo",
    session: snapshot(session),
  };
}

function snapshot(session) {
  return {
    selections: { ...session.selections },
    bodyType: session.bodyType,
    animation: session.animation,
  };
}

export { TOOL_SCHEMAS };