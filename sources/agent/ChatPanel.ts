// ChatPanel — left pane of the Agent page. Renders the message log and an
// input box. The actual conversation is driven by AgentClient (client.ts);
// this component only renders + emits user input.
//
// Visual style: dark gradient panel, bubbles aligned by role, collapsible
// tool-call cards, suggested-prompt chips on empty state.

import m from "mithril";
import type {
  ChatMessage,
  ChatToolCall,
  ToolResult,
} from "./types.ts";

export interface ChatEntry {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** When set, this entry is rendered as a tool call/result pair. */
  toolCall?: ChatToolCall;
  toolResult?: ToolResult;
}

interface Attrs {
  entries: ChatEntry[];
  pending: boolean;
  provider?: string;
  fallback?: "echo";
  error?: string;
  onSend: (text: string) => void;
  onAbort: () => void;
  onClear: () => void;
  onPickPrompt?: (text: string) => void;
}

interface State {
  draft: string;
  expandedTools: Record<string, boolean>;
}

const SUGGESTED_PROMPTS: string[] = [
  "给我一个穿蓝袍子拿法杖的女法师，演示施法动作",
  "做一个肌肉男战士，双手持剑，挥砍演示",
  "一个戴红头巾的盗贼，走路 + 跑",
  "随机一个男性角色，做站立动作",
];

let entryIdSeq = 0;
export function nextEntryId(): string {
  return `e-${Date.now().toString(36)}-${(entryIdSeq++).toString(36)}`;
}

export const ChatPanel: m.Component<Attrs, State> = {
  oninit(vnode) {
    vnode.state.draft = "";
    vnode.state.expandedTools = {};
  },

  view(vnode) {
    const providerBadge = renderProviderBadge(vnode.attrs.provider, vnode.attrs.fallback);
    return m("div.chat-panel", [
      m("div.chat-panel__header", [
        m("div.chat-panel__title", [
          m("span.chat-panel__dot"),
          m("h2", "Agent 对话"),
          providerBadge,
        ]),
        m("div.chat-panel__actions", [
          m(
            "button.chat-panel__iconbtn",
            {
              title: "清空对话",
              onclick: () => vnode.attrs.onClear(),
              disabled: vnode.attrs.entries.length === 0,
            },
            m("span", "✕"),
          ),
        ]),
      ]),

      vnode.attrs.error
        ? m("div.chat-panel__error", [
            m("span", "⚠"),
            m("span", vnode.attrs.error),
          ])
        : null,

      m(
        "div.chat-panel__log",
        {
          oncreate: (vn: m.VnodeDOM) => scrollToBottom(vn.dom),
          onupdate: (vn: m.VnodeDOM) => scrollToBottom(vn.dom),
        },
        vnode.attrs.entries.length === 0
          ? m("div.chat-panel__empty", [
              m("p.chat-panel__empty-title", "试试这样问"),
              m(
                "div.chat-panel__suggestions",
                SUGGESTED_PROMPTS.map((p) =>
                  m(
                    "button.chat-panel__chip",
                    {
                      onclick: () => vnode.attrs.onPickPrompt?.(p),
                    },
                    p,
                  ),
                ),
              ),
            ])
          : vnode.attrs.entries.map((entry) => renderEntry(entry, vnode.state)),
      ),

      vnode.attrs.pending
        ? m("div.chat-panel__pending", [
            m("div.chat-panel__pending-dots", [
              m("span"),
              m("span"),
              m("span"),
            ]),
            m("span.chat-panel__pending-text", "Agent 正在思考…"),
            m(
              "button.chat-panel__abort",
              { onclick: () => vnode.attrs.onAbort() },
              "取消",
            ),
          ])
        : null,

      m("div.chat-panel__composer", [
        m("textarea.chat-panel__textarea", {
          rows: 2,
          placeholder: "描述你想要的角色（Enter 发送 / Shift+Enter 换行）…",
          value: vnode.state.draft,
          oninput: (e: Event) => {
            vnode.state.draft = (e.target as HTMLTextAreaElement).value;
          },
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submitDraft(vnode);
            }
          },
          disabled: vnode.attrs.pending,
        }),
        m("div.chat-panel__composer-row", [
          m("span.chat-panel__hint", [
            "由 ",
            m("strong", "MiniMax"),
            " 驱动",
          ]),
          m(
            "button.chat-panel__send",
            {
              disabled:
                vnode.attrs.pending || vnode.state.draft.trim().length === 0,
              onclick: () => submitDraft(vnode),
            },
            [
              m("span", "发送"),
              m("span.chat-panel__send-icon", "→"),
            ],
          ),
        ]),
      ]),
    ]);
  },
};

function submitDraft(vnode: m.Vnode<Attrs, State>): void {
  const text = vnode.state.draft.trim();
  if (!text) return;
  vnode.state.draft = "";
  vnode.attrs.onSend(text);
}

function scrollToBottom(dom: Element): void {
  const el = dom as HTMLDivElement;
  queueMicrotask(() => {
    el.scrollTop = el.scrollHeight;
  });
}

function renderProviderBadge(provider?: string, fallback?: "echo"): m.Vnode | null {
  if (fallback === "echo") {
    return m("span.chat-panel__badge.chat-panel__badge--echo", "echo 回退");
  }
  if (provider === "MiniMax" || provider === "minimax") {
    return m("span.chat-panel__badge.chat-panel__badge--live", "MiniMax");
  }
  if (provider === "browser") {
    return m("span.chat-panel__badge.chat-panel__badge--local", "本地");
  }
  return null;
}

function renderEntry(entry: ChatEntry, state: State): m.Vnode {
  switch (entry.role) {
    case "user":
      return m("div.chat-msg.chat-msg--user", [
        m("div.chat-msg__avatar", "U"),
        m("div.chat-msg__bubble", entry.content),
      ]);
    case "assistant":
      return m("div.chat-msg.chat-msg--assistant", [
        m("div.chat-msg__avatar.chat-msg__avatar--ai", "AI"),
        m(
          "div.chat-msg__bubble",
          entry.content
            ? renderMarkdownish(entry.content)
            : m("em.has-text-grey", "(模型没有额外说明)"),
        ),
      ]);
    case "system":
      return m("div.chat-msg.chat-msg--system", [
        m("div.chat-msg__avatar.chat-msg__avatar--sys", "!"),
        m("div.chat-msg__bubble.chat-msg__bubble--system", entry.content),
      ]);
    case "tool":
      return renderToolEntry(entry, state);
  }
}

/** Lightweight text rendering: collapse long whitespace, escape-ish.
 *  Avoids pulling in a markdown dep for the v1 redesign. */
function renderMarkdownish(text: string): m.Children {
  // Drop chain-of-thought blocks the model sometimes leaks into assistant
  // content — those are noisy and meant for internal use.
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!cleaned) return m("em.has-text-grey", "(模型没有额外说明)");
  return cleaned;
}

function renderToolEntry(entry: ChatEntry, state: State): m.Vnode {
  const expanded = !!state.expandedTools[entry.id];
  const name = entry.toolCall?.name ?? "(unknown)";
  const ok = entry.toolResult?.ok ?? false;
  const summary = summarizeResultShort(entry.toolResult);

  return m(
    "div.chat-msg.chat-msg--tool",
    m(
      "div.chat-tool",
      {
        onclick: () => {
          state.expandedTools[entry.id] = !expanded;
        },
      },
      [
        m("div.chat-tool__head", [
          m("span.chat-tool__icon", ok ? "✓" : "✗"),
          m("span.chat-tool__name", name),
          summary ? m("span.chat-tool__summary", summary) : null,
          m(
            "span.chat-tool__caret",
            { class: expanded ? "is-open" : "" },
            "▾",
          ),
        ]),
        expanded
          ? m("div.chat-tool__body", [
              entry.toolCall?.arguments
                ? m("div.chat-tool__section", [
                    m("div.chat-tool__label", "参数"),
                    m(
                      "pre.chat-tool__pre",
                      JSON.stringify(entry.toolCall.arguments, null, 2),
                    ),
                  ])
                : null,
              entry.toolResult
                ? m("div.chat-tool__section", [
                    m("div.chat-tool__label", "结果"),
                    m(
                      "pre.chat-tool__pre",
                      entry.toolResult.ok
                        ? JSON.stringify(summarizeResult(entry.toolResult), null, 2)
                        : JSON.stringify(entry.toolResult.error, null, 2),
                    ),
                  ])
                : null,
            ])
          : null,
      ],
    ),
  );
}

function summarizeResultShort(r: ToolResult | undefined): string | null {
  if (!r) return null;
  if (!r.ok) return r.error.kind;
  const d = r.data;
  if (Array.isArray(d)) return `${d.length} 项`;
  if (d && typeof d === "object") {
    const dd = d as Record<string, unknown>;
    if (typeof dd.base64 === "string") {
      const k = Math.round(dd.base64.length / 1024);
      return `PNG · ${k} KB`;
    }
    if ("bodyType" in dd) return `body=${String(dd.bodyType)}`;
    if ("animation" in dd) return `anim=${String(dd.animation)}`;
    if ("cleared" in dd) return String(dd.cleared ? "removed" : "noop");
    const keys = Object.keys(dd);
    return keys.length > 0 ? `{${keys.slice(0, 3).join(", ")}}` : "{}";
  }
  return null;
}

function summarizeResult(r: ToolResult): unknown {
  if (!r.ok) return { error: r.error };
  const d = r.data;
  if (d && typeof d === "object" && "base64" in (d as Record<string, unknown>)) {
    const dd = d as Record<string, unknown>;
    return {
      mimeType: dd.mimeType,
      width: dd.width,
      height: dd.height,
      base64Length: typeof dd.base64 === "string" ? dd.base64.length : 0,
      bodyType: dd.bodyType,
      animation: dd.animation,
    };
  }
  return d;
}

/** Build the messages array to send to /api/agent/chat from a list of entries. */
export function entriesToMessages(entries: ChatEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of entries) {
    if (e.role === "user" || e.role === "assistant") {
      out.push({ role: e.role, content: e.content });
    }
    // We don't surface tool call/result back into the wire format here — the
    // server replays tool calls itself and the browser mirrors results
    // locally. The server knows what the model actually emitted.
  }
  return out;
}
