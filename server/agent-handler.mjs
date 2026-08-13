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
    description: "写入一个 Selection。",
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
    description: "切换预览动作。",
    parameters: {
      type: "object",
      properties: { animation: { type: "string" } },
      required: ["animation"],
      additionalProperties: false,
    },
  },
  {
    name: "render_spritesheet",
    description: "把当前 session 渲染成 PNG（base64）。",
    parameters: {
      type: "object",
      properties: { animation: { type: "string" }, includeImage: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "reset_to_defaults",
    description: "重置 session 到默认值。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

const SYSTEM_PROMPT = `你是一个精灵图生成助手。
用户会用自然语言描述他们想要的角色（例如「红色头发的女法师，演示施法动作」）。
你必须通过调用工具来构建和渲染角色：
- 用 list_categories / list_items / get_item / list_body_types / list_animations 检索可选部件；
- 用 set_body_type 切换身体类型；
- 用 set_selection 装备具体部件（必传 selection.itemId / name + variant 或 recolor；typeName 必填，例如 body / head / torso / legs / feet / hair / weapon）；
- 用 set_animation 切换预览动作；
- 最后调用 render_spritesheet（includeImage=true）返回 PNG。
注意：itemId 必须从 list_items / get_item 返回的字段里直接复制，不要凭空编造。
不要在 text 里直接描述结果，把所有动作通过工具完成。`;

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
      return {
        ok: true,
        data: {
          deferred: true,
          message: "render_spritesheet runs in the browser; client will replay it.",
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