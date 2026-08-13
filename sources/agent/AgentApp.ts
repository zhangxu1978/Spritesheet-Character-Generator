// AgentApp — top-level Agent page component. Two columns:
//   left  = ChatPanel
//   right = AgentPreview
//
// Owns the AgentClient (server | browser mode), the chat entries list, and
// the latest rendered PNG. Hands the same AgentSession to both panes so they
// always agree on what is being shown.

import m from "mithril";
import { AgentClient } from "./client.ts";
import { AgentPreview } from "./AgentPreview.ts";
import {
  ChatPanel,
  nextEntryId,
  entriesToMessages,
  type ChatEntry,
} from "./ChatPanel.ts";
import type { ChatMessage } from "./types.ts";

interface Attrs {
  /** Override base URL for /api/agent/* (mostly for tests). */
  baseUrl?: string;
  /** Force a mode; default is "server" so MiniMax actually drives the page. */
  mode?: "browser" | "server";
}

interface State {
  client: AgentClient;
  entries: ChatEntry[];
  pending: boolean;
  lastPngBase64?: string;
  lastError?: string;
  provider?: string;
  fallback?: "echo";
  lastToolCount?: number;
  draft?: string;
}

export const AgentApp: m.Component<Attrs, State> = {
  oninit(vnode) {
    // mithril leaves vnode.attrs undefined when the component is mounted via
    // m.mount(root, Component) or m(Component). Default to {} so reads like
    // vnode.attrs.baseUrl are safe.
    const attrs = vnode.attrs ?? {};
    vnode.state.client = new AgentClient({
      mode: attrs.mode ?? "server",
      baseUrl: attrs.baseUrl ?? "",
      sessionId: "default",
      onMeta: (meta) => {
        vnode.state.provider = meta.provider;
        vnode.state.fallback = meta.fallback;
        if (meta.error) {
          vnode.state.lastError = meta.error;
        }
        m.redraw();
      },
      onImage: (b64) => {
        vnode.state.lastPngBase64 = b64;
        m.redraw();
      },
    });
    vnode.state.entries = [];
    vnode.state.pending = false;
    vnode.state.lastError = undefined;
    // Expose the AgentSession so DevTools can inspect its selections / canvas
    // — invaluable when tracking down "why isn't this body rendering?".
    (globalThis as { __agentSession?: unknown }).__agentSession =
      vnode.state.client.getSession();
  },

  onremove(vnode) {
    vnode.state.client.abort();
  },

  view(vnode) {
    const session = vnode.state.client.getSession();
    return m("div.agent-app", [
      m("div.agent-app__header", [
        m("div.agent-app__title", [
          m("h1", "Agent 对话生成"),
          m(
            "span.agent-app__subtitle",
            "用自然语言描述角色，由 MiniMax 驱动工具调用并实时渲染精灵表。",
          ),
        ]),
        m("div.agent-app__nav", [
          m("a.agent-app__navlink", { href: "./index.html" }, "← 返回主页"),
        ]),
      ]),

      m("div.agent-app__layout", [
        m(ChatPanel, {
          entries: vnode.state.entries,
          pending: vnode.state.pending,
          provider: vnode.state.provider,
          fallback: vnode.state.fallback,
          error: vnode.state.lastError,
          onSend: (text: string) => void onSend(vnode, text),
          onAbort: () => {
            vnode.state.client.abort();
            vnode.state.pending = false;
            m.redraw();
          },
          onClear: () => {
            vnode.state.entries = [];
            vnode.state.lastError = undefined;
            m.redraw();
          },
          onPickPrompt: (text: string) => {
            vnode.state.draft ||= text;
            void onSend(vnode, text);
          },
        }),
        m(AgentPreview, {
          session,
          lastPngBase64: vnode.state.lastPngBase64,
          pending: vnode.state.pending,
          toolCount: vnode.state.lastToolCount,
          onDownload: (anims) => onDownload(vnode, anims),
          onAnimationChange: () => m.redraw(),
        }),
      ]),
    ]);
  },
};

async function onSend(vnode: m.Vnode<Attrs, State>, text: string): Promise<void> {
  vnode.state.entries.push({
    id: nextEntryId(),
    role: "user",
    content: text,
  });
  vnode.state.pending = true;
  vnode.state.lastError = undefined;
  m.redraw();

  // Subscribe to per-tool events before sending so that intermediate
  // tool calls become visible in the chat as they execute.
  const session = vnode.state.client.getSession();
  const attrs = vnode.attrs ?? {};
  const baseUrl = attrs.baseUrl ?? "";
  // Replace the client so per-call callbacks bind to the latest vnode.
  vnode.state.client.abort();
  vnode.state.client = new AgentClient({
    mode: attrs.mode ?? "server",
    baseUrl,
    sessionId: "default",
    onToolCall: (call, result) => {
      vnode.state.entries.push({
        id: nextEntryId(),
        role: "tool",
        content: "",
        toolCall: call,
        toolResult: result,
      });
      m.redraw();
    },
    onImage: (b64) => {
      vnode.state.lastPngBase64 = b64;
      m.redraw();
    },
    onMeta: (meta) => {
      vnode.state.provider = meta.provider;
      vnode.state.fallback = meta.fallback;
      if (meta.error) vnode.state.lastError = meta.error;
      m.redraw();
    },
  });

  try {
    const messages: ChatMessage[] = entriesToMessages(vnode.state.entries);
    const response = await vnode.state.client.send(messages);
    vnode.state.lastToolCount = response.toolCalls?.length ?? 0;
    vnode.state.entries.push({
      id: nextEntryId(),
      role: "assistant",
      content:
        response.assistantText ??
        (response.toolCalls.length === 0 ? "(没有产生工具调用)" : ""),
    });
    if (response.finalImageBase64) {
      vnode.state.lastPngBase64 = response.finalImageBase64;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    vnode.state.lastError = msg;
    vnode.state.entries.push({
      id: nextEntryId(),
      role: "system",
      content: `请求失败：${msg}`,
    });
  } finally {
    vnode.state.pending = false;
    m.redraw();
  }
  // Avoid "unused" warning — session is already threaded into the client
  // and reused across sends; just touch it here so V8 doesn't optimize the
  // import away.
  void session;
}

function onDownload(
  vnode: m.Vnode<Attrs, State>,
  selectedAnimations?: string[],
): void {
  const session = vnode.state.client.getSession();
  const canvas = session.getCanvasForAnimations(selectedAnimations) ?? session.getCanvas();
  if (!canvas) return;
  const tag =
    selectedAnimations && selectedAnimations.length > 0
      ? selectedAnimations.join("_")
      : "full";
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `character-${tag}-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}
