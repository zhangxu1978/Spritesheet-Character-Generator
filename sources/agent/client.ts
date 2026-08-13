// Agent client — browser side. Two modes:
//
//   - "server" (default): POST messages to /api/agent/chat; the server decides
//     whether to call MiniMax or the echo stub. Tool calls come back in the
//     response and the client replays them on the local session so the
//     preview updates. render_spritesheet is replayed locally to actually
//     produce the PNG (the server can't render in plain Node).
//   - "browser": execute tools directly in this tab with a tiny keyword
//     matcher. Useful for offline demos.
//
// The Agent page (AgentApp.ts) drives this client; messages and tool calls
// surface through the returned stream.

import type {
  ChatFinalResponse,
  ChatMessage,
  ChatToolCall,
  ToolContext,
  ToolResult,
} from "./types.ts";
import {
  AgentSession,
  createOrGetSession,
} from "./session.ts";
import { runTool, getToolSchemas } from "./tools.ts";

export type AgentMode = "browser" | "server";

export interface AgentClientOptions {
  mode?: AgentMode;
  /** Base URL for /api/agent/* (only used in "server" mode). */
  baseUrl?: string;
  /** Stable id so reloading the page reuses the same session. */
  sessionId?: string;
  /** When true, tool calls are surfaced via onToolCall as they execute. */
  onToolCall?: (call: ChatToolCall, result: ToolResult) => void;
  /** When true, the final PNG (if any) is delivered via onImage. */
  onImage?: (base64: string, mimeType: string) => void;
  /** Surfaced when the server reports which provider answered. */
  onMeta?: (meta: { provider?: string; fallback?: "echo"; error?: string }) => void;
}

export class AgentClient {
  private mode: AgentMode;
  private baseUrl: string;
  private session: AgentSession;
  private sessionId: string;
  private opts: AgentClientOptions;
  private aborted = false;

  constructor(opts: AgentClientOptions = {}) {
    // Default to "server" so the Agent page actually hits MiniMax (via the
    // project's /api/agent/chat). Switch back to "browser" for offline demos
    // or tests by passing mode: "browser".
    this.mode = opts.mode ?? "server";
    this.baseUrl = opts.baseUrl ?? "";
    this.opts = opts;
    this.sessionId = opts.sessionId ?? "default";
    this.session = createOrGetSession(this.sessionId);
  }

  getSession(): AgentSession {
    return this.session;
  }

  abort(): void {
    this.aborted = true;
  }

  async send(messages: ChatMessage[]): Promise<ChatFinalResponse> {
    this.aborted = false;
    if (this.mode === "browser") {
      return this.runBrowser(messages);
    }
    return this.runServer(messages);
  }

  /** Detect role keywords and return an animations preset for selective export. */
  private detectRolePreset(text: string): string[] | undefined {
    const t = text.toLowerCase();
    const presets: Array<{ keys: string[]; animations: string[]; label: string }> = [
      { keys: ["摆件", "静态", "装饰", "柱子", "火炬", "招牌", "箱子", "prop", "static"],
        animations: ["idle"], label: "静态摆件" },
      { keys: ["村民", "npc", "老板", "平民", "villager", "老人", "小孩", "路人"],
        animations: ["idle", "walk"], label: "普通 NPC" },
      { keys: ["商人", "商店", "黑商", "merchant", "banker", "柜员"],
        animations: ["idle", "emote"], label: "商人" },
      { keys: ["门卫", "守卫", "guard", "哨兵", "sentry", "士兵"],
        animations: ["idle", "walk", "hurt"], label: "守卫" },
      { keys: ["近战小怪", "近战怪", "杂兵", "enemy melee", "slasher"],
        animations: ["idle", "walk", "hurt", "slash"], label: "近战小怪" },
      { keys: ["远程怪", "弓手", "法师怪", "archer", "caster", "mage enemy"],
        animations: ["idle", "walk", "hurt", "shoot", "spellcast"], label: "远程小怪" },
      { keys: ["boss", "首领", "精英", "elite", "头目"],
        animations: ["idle", "walk", "run", "hurt", "slash", "spellcast", "jump"],
        label: "BOSS" },
      { keys: ["坐骑", "宠物", "mount", "pet", "马", "狗", "猫"],
        animations: ["idle", "walk", "run", "hurt"], label: "坐骑/宠物" },
      { keys: ["攀爬", "爬梯", "梯子", "climb", "藤蔓"],
        animations: ["idle", "walk", "climb"], label: "攀爬角色" },
      { keys: ["玩家", "主角", "player", "hero", "可操作", "pc", "完整版", "全部动作", "完整"],
        animations: [], label: "完整大表（玩家）" },
    ];
    const match = presets.find((p) =>
      p.keys.some((kw) => t.includes(kw.toLowerCase())),
    );
    // undefined ⇒ full sheet; empty array is also full sheet per render_spritesheet semantics
    if (!match) return undefined;
    // Match "player/full" preset (empty animations) → return undefined to mean full sheet
    if (match.animations.length === 0) return undefined;
    return match.animations;
  }

  /** Direct tool execution on the local session. The "browser" mode does
   *  one loop: pick the last user message, look for keyword hints, and call
   *  a couple of tools. This is intentionally simple — the LLM lives on
   *  the server. */
  private async runBrowser(messages: ChatMessage[]): Promise<ChatFinalResponse> {
    const ctx: ToolContext = { session: this.session };
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";

    const calls: Array<{ call: ChatToolCall; result: ToolResult }> = [];
    let finalImageBase64: string | undefined;
    let assistantText = `（本地模式）收到：${text}`;
    const lowerText = text.toLowerCase();

    // ─────────────────────────────────────────────────────────────────────
    // Intent parser. Maps keywords → tool calls. Server uses MiniMax; this
    // branch is just a quick offline demo.
    // ─────────────────────────────────────────────────────────────────────

    // 1. Body type
    const bodyKeywords: Array<{ key: string; value: string }> = [
      { key: "女", value: "female" }, { key: "female", value: "female" },
      { key: "woman", value: "female" }, { key: "女孩", value: "female" },
      { key: "男", value: "male" }, { key: "male", value: "male" },
      { key: "man", value: "male" }, { key: "男孩", value: "male" },
      { key: "teen", value: "teen" }, { key: "teenager", value: "teen" },
      { key: "少年", value: "teen" }, { key: "child", value: "child" },
      { key: "kid", value: "child" }, { key: "小孩", value: "child" },
      { key: "儿童", value: "child" }, { key: "muscular", value: "muscular" },
      { key: "壮", value: "muscular" },
    ];
    const bodyHit = bodyKeywords.find((row) => lowerText.includes(row.key.toLowerCase()));
    if (bodyHit) {
      const call: ChatToolCall = {
        name: "set_body_type",
        arguments: { bodyType: bodyHit.value },
      };
      const result = await runTool(ctx, call.name, call.arguments);
      calls.push({ call, result });
      this.opts.onToolCall?.(call, result);
    }

    // 2. Animation (preview)
    const animList: Array<{ keys: string[]; value: string }> = [
      { keys: ["walk", "走", "走路"], value: "walk" },
      { keys: ["run", "跑", "奔跑"], value: "run" },
      { keys: ["jump", "跳", "跳跃"], value: "jump" },
      { keys: ["hurt", "受伤", "被打"], value: "hurt" },
      { keys: ["idle", "站", "站立", "待机"], value: "idle" },
      { keys: ["sit", "坐", "坐下"], value: "sit" },
      { keys: ["climb", "爬", "攀爬"], value: "climb" },
      { keys: ["slash", "斩", "挥砍"], value: "slash" },
      { keys: ["thrust", "刺", "突刺"], value: "thrust" },
      { keys: ["shoot", "射", "射击"], value: "shoot" },
      { keys: ["spellcast", "施法", "法术", "魔法", "法杖"], value: "spellcast" },
      { keys: ["emote", "表情"], value: "emote" },
      { keys: ["combat", "战斗"], value: "combat" },
      { keys: ["1h_backslash", "反手"], value: "1h_backslash" },
      { keys: ["1h_halfslash", "半斩"], value: "1h_halfslash" },
    ];
    const wantAnims = animList
      .filter((row) => row.keys.some((kw) => lowerText.includes(kw.toLowerCase())))
      .map((row) => row.value);
    if (wantAnims.length > 0) {
      const anim = wantAnims[wantAnims.length - 1]!;
      const call: ChatToolCall = { name: "set_animation", arguments: { animation: anim } };
      const result = await runTool(ctx, call.name, call.arguments);
      calls.push({ call, result });
      this.opts.onToolCall?.(call, result);
    }

    // 3. Role-based selective export (NPC / BOSS / player / ...)
    const roleAnims = this.detectRolePreset(text);

    // 4. Render with selective animations when we could detect a role.
    const renderCall: ChatToolCall = {
      name: "render_spritesheet",
      arguments: {
        includeImage: true,
        ...(roleAnims !== undefined ? { animations: roleAnims } : {}),
      },
    };
    const renderResult = await runTool(ctx, renderCall.name, renderCall.arguments);
    calls.push({ call: renderCall, result: renderResult });
    this.opts.onToolCall?.(renderCall, renderResult);
    let included: string[] = [];
    if (renderResult.ok && typeof renderResult.data === "object" && renderResult.data !== null) {
      const d = renderResult.data as {
        base64?: string; mimeType?: string;
        includedAnimations?: string[]; selective?: boolean;
        width?: number; height?: number; fullHeight?: number;
      };
      included = d.includedAnimations ?? [];
      if (d.base64) {
        finalImageBase64 = d.base64;
        this.opts.onImage?.(d.base64, d.mimeType ?? "image/png");
      }
    }

    // Build a friendly assistant message.
    const lines: string[] = [];
    if (calls.some((c) => c.call.name === "set_body_type")) {
      lines.push(`已切换身体类型到 ${this.session.getBodyType()}。`);
    }
    if (calls.some((c) => c.call.name === "set_animation")) {
      lines.push(`预览动作设置为 ${this.session.getAnimation()}。`);
    }
    if (roleAnims) {
      lines.push(`根据「${text}」判断为 NPC 类角色，自动只导出 [${roleAnims.join(", ")}]；想要完整大表说「完整」即可。`);
    } else if (text.match(/玩家|主角|player|hero|完整|全部动作/)) {
      lines.push(`已按玩家 / 主角模式导出完整大表。`);
    }
    if (renderResult.ok) {
      const size = included.length > 0 ? `（精简 ${included.length} 个动作）` : "";
      lines.push(`已渲染精灵表${size}（包含 ${Object.keys(this.session.getSelections()).length} 个部件）。`);
    } else {
      lines.push(`渲染失败：${(renderResult.error?.message) ?? "unknown"}`);
    }
    assistantText = `（本地模式）${lines.join(" ")}`;

    return {
      finalImageBase64,
      toolCalls: calls,
      assistantText,
      provider: "browser",
    };
  }

  private async runServer(messages: ChatMessage[]): Promise<ChatFinalResponse> {
    const url = `${this.baseUrl}/api/agent/chat`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: this.sessionId,
          snapshot: this.session.serialize(),
          messages,
        }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.opts.onMeta?.({ error: `网络错误：${msg}` });
      throw new Error(`网络错误：${msg}`);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const msg = `服务器返回 ${resp.status}${text ? `: ${text.slice(0, 200)}` : ""}`;
      this.opts.onMeta?.({ error: msg });
      throw new Error(msg);
    }
    const body = (await resp.json()) as ChatFinalResponse;
    this.opts.onMeta?.({ provider: body.provider, fallback: body.fallback });

    // Replay tool calls onto the local session so the preview updates.
    // server-side render_spritesheet is a no-op (returns deferred:true) so we
    // re-run it locally to actually produce the PNG.
    const ctx: ToolContext = { session: this.session };
    let localImageBase64: string | undefined;
    for (const entry of body.toolCalls ?? []) {
      if (this.aborted) break;
      const result = await runTool(ctx, entry.call.name, entry.call.arguments);
      entry.result = result;
      this.opts.onToolCall?.(entry.call, result);
      if (
        entry.call.name === "render_spritesheet" &&
        result.ok &&
        typeof result.data === "object" &&
        result.data !== null
      ) {
        const d = result.data as { base64?: string; mimeType?: string };
        if (d.base64) localImageBase64 = d.base64;
      }
    }
    const finalImageBase64 = localImageBase64 ?? body.finalImageBase64;
    if (finalImageBase64) {
      this.opts.onImage?.(finalImageBase64, "image/png");
    }
    return { ...body, finalImageBase64 };
  }
}

export { AgentSession, getToolSchemas };
