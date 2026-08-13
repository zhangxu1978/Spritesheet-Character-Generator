// AgentPreview — right pane of the Agent page. Shows the current AgentSession's
// offscreen canvas at the currently-selected animation row, with controls to
// switch the animation and download the rendered PNG.
//
// Why we don't reuse the main UI's AnimationPreview:
//   - That preview draws onto a shared preview canvas module-level state
//     (previewCanvas / previewCtx in canvas/preview-canvas.ts) and reads the
//     global renderer canvas. Agent must be isolated.
//   - So this component reads from `AgentSession.getCanvas()` and runs its
//     own minimal rAF loop. The drawing math is identical to
//     canvas/preview-animation.ts paintPreviewFrameForCycleIndex — kept inline
//     so this component has no cross-talk with the main UI.

import m from "mithril";
import {
  ANIMATION_CONFIGS,
  ANIMATIONS,
  FRAME_SIZE,
} from "../state/constants.ts";
import type { AgentSession } from "./session.ts";

interface Attrs {
  session: AgentSession;
  /** Latest PNG (base64) produced by the most recent render. */
  lastPngBase64?: string;
  /** Triggered when user clicks "Download PNG" with selected animations list. */
  onDownload?: (selectedAnimations?: string[]) => void;
  /** Notifies parent when this component changes the animation. */
  onAnimationChange?: (animation: string) => void;
  /** Whether a request is in flight (used to dim the preview). */
  pending?: boolean;
  /** Total tool calls executed in the last round (displayed in footer). */
  toolCount?: number;
}

interface State {
  rafId: number | null;
  cycleIndex: number;
  lastFrame: number;
  // Animation that the component is currently displaying.
  animation: string;
  fpsCounter: number;
  fpsLastTs: number;
  fps: number;
  /** Download dialog state: open + which animations are checked */
  downloadDialogOpen: boolean;
  downloadSelection: Record<string, boolean>;
  /** Preset shortcut picked in download dialog */
  downloadPreset: string;
}

/** Presets available in the download dialog (keep labels short). */
const DOWNLOAD_PRESETS: Array<{ key: string; label: string; animations: string[] }> = [
  { key: "full", label: "完整大表", animations: [] },
  { key: "static", label: "静态摆件", animations: ["idle"] },
  { key: "npc", label: "NPC (待机+走)", animations: ["idle", "walk"] },
  { key: "shop", label: "商人 (待机+表情)", animations: ["idle", "emote"] },
  { key: "guard", label: "守卫", animations: ["idle", "walk", "hurt"] },
  { key: "enemy", label: "近战小怪", animations: ["idle", "walk", "hurt", "slash"] },
  { key: "ranged", label: "远程小怪", animations: ["idle", "walk", "hurt", "shoot", "spellcast"] },
  { key: "boss", label: "BOSS", animations: ["idle", "walk", "run", "hurt", "slash", "spellcast", "jump"] },
  { key: "player", label: "玩家主角", animations: [
      "spellcast", "thrust", "walk", "slash", "shoot", "hurt",
      "climb", "idle", "jump", "sit", "emote", "run",
    ]
  },
  { key: "mount", label: "坐骑/宠物", animations: ["idle", "walk", "run", "hurt"] },
];

export const AgentPreview: m.Component<Attrs, State> = {
  oninit(vnode) {
    vnode.state.rafId = null;
    vnode.state.cycleIndex = 0;
    vnode.state.lastFrame = 0;
    vnode.state.animation = vnode.attrs.session.getAnimation();
    vnode.state.fpsCounter = 0;
    vnode.state.fpsLastTs = performance.now();
    vnode.state.fps = 0;
    vnode.state.downloadDialogOpen = false;
    vnode.state.downloadSelection = {};
    vnode.state.downloadPreset = "full";
    // Default download selection: full sheet (all on, but preset=full means "export everything")
    for (const a of ANIMATIONS) vnode.state.downloadSelection[a.value] = true;
  },

  oncreate(vnode) {
    const canvas = vnode.dom.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return;
    canvas.width = FRAME_SIZE * 4; // 4 directions
    canvas.height = FRAME_SIZE;
    vnode.state.rafId = requestAnimationFrame((now) => oncreateTick(vnode, canvas, now));
  },

  onremove(vnode) {
    if (vnode.state.rafId !== null) {
      cancelAnimationFrame(vnode.state.rafId);
      vnode.state.rafId = null;
    }
  },

  onupdate(vnode) {
    const want = vnode.attrs.session.getAnimation();
    if (want !== vnode.state.animation) {
      vnode.state.animation = want;
      vnode.state.cycleIndex = 0;
    }
  },

  view(vnode) {
    const session = vnode.attrs.session;
    const current = vnode.state.animation;
    const cfg = ANIMATION_CONFIGS[current as keyof typeof ANIMATION_CONFIGS];
    const cycleLen = cfg?.cycle.length ?? 0;
    const selections = session.getSelections();
    const equippedCount = Object.keys(selections).length;

    return m("div.agent-preview", [
      m("div.agent-preview__toolbar", [
        m("div.agent-preview__select", [
          m("label", "动作"),
          m(
            "select",
            {
              onchange: (e: Event) => {
                const v = (e.target as HTMLSelectElement).value;
                vnode.state.animation = v;
                session.setAnimation(v);
                vnode.attrs.onAnimationChange?.(v);
              },
            },
            ANIMATIONS.map((a) =>
              m(
                "option",
                { value: a.value, selected: a.value === current },
                `${a.value}${a.label && a.label !== a.value ? ` (${a.label})` : ""}`,
              ),
            ),
          ),
        ]),
        m("div.agent-preview__toolbar-right", [
          m("div.agent-preview__counter", [
            m("span.agent-preview__counter-num", String(vnode.state.cycleIndex)),
            m("span.agent-preview__counter-sep", "/"),
            m("span.agent-preview__counter-total", String(Math.max(cycleLen - 1, 0))),
          ]),
          m(
            "button.agent-preview__download",
            {
              onclick: () => {
                vnode.state.downloadDialogOpen = true;
                // Reset selection to all-on when opening, matches preset=full
                for (const a of ANIMATIONS) vnode.state.downloadSelection[a.value] = true;
                vnode.state.downloadPreset = "full";
                m.redraw();
              },
              title: "选择要导出的动作，再下载 PNG",
            },
            [
              m("span.agent-preview__download-icon", "↓"),
              m("span", "下载 PNG…"),
            ],
          ),
        ]),
      ]),
      vnode.state.downloadDialogOpen
        ? renderDownloadDialog(vnode)
        : null,

      m("div.agent-preview__stage", [
        m("canvas.agent-preview__canvas", {
          style: "image-rendering: pixelated;",
        }),
        vnode.attrs.pending
          ? m("div.agent-preview__overlay", [
              m("div.agent-preview__spinner"),
              m("span", "正在渲染…"),
            ])
          : null,
        !session.getCanvas()
          ? m("div.agent-preview__hint", [
              m("span", "👋"),
              m("p", "还没有画面。在左侧对话框里描述你想要的角色。"),
            ])
          : null,
      ]),

      m("div.agent-preview__footer", [
        m("div.agent-preview__chip", [
          m("span.agent-preview__chip-key", "身体"),
          m("span.agent-preview__chip-val", session.getBodyType()),
        ]),
        m("div.agent-preview__chip", [
          m("span.agent-preview__chip-key", "部件"),
          m("span.agent-preview__chip-val", String(equippedCount)),
        ]),
        m("div.agent-preview__chip", [
          m("span.agent-preview__chip-key", "动作"),
          m("span.agent-preview__chip-val", current),
        ]),
        typeof vnode.attrs.toolCount === "number"
          ? m("div.agent-preview__chip", [
              m("span.agent-preview__chip-key", "工具调用"),
              m("span.agent-preview__chip-val", String(vnode.attrs.toolCount)),
            ])
          : null,
      ]),
    ]);
  },
};

// ─── Download dialog ────────────────────────────────────────────────────

function renderDownloadDialog(vnode: m.Vnode<Attrs, State>): m.Vnode {
  const sel = vnode.state.downloadSelection;
  // Exportable animations (exclude internal-only marked with noExport)
  const exportable = ANIMATIONS.filter((a) => !(a as { noExport?: boolean }).noExport);
  const checkedCount = exportable.filter((a) => sel[a.value]).length;
  const isFull = vnode.state.downloadPreset === "full";

  const applyPreset = (presetKey: string) => {
    vnode.state.downloadPreset = presetKey;
    const preset = DOWNLOAD_PRESETS.find((p) => p.key === presetKey);
    if (!preset) return;
    if (preset.animations.length === 0) {
      // full → select every exportable
      for (const a of exportable) vnode.state.downloadSelection[a.value] = true;
    } else {
      for (const a of exportable) vnode.state.downloadSelection[a.value] = false;
      for (const v of preset.animations) vnode.state.downloadSelection[v] = true;
    }
    m.redraw();
  };

  const close = () => {
    vnode.state.downloadDialogOpen = false;
    m.redraw();
  };

  const doDownload = () => {
    const picked = exportable
      .filter((a) => sel[a.value])
      .map((a) => a.value);
    // If all are on → pass undefined to mean "full sheet"
    const allOn = picked.length === exportable.length;
    vnode.attrs.onDownload?.(allOn ? undefined : picked);
    close();
  };

  return m("div.agent-dlmodal", [
    m("div.agent-dlmodal__backdrop", { onclick: close }),
    m("div.agent-dlmodal__panel", [
      m("div.agent-dlmodal__head", [
        m("h3", "选择要导出的动作"),
        m(
          "button.agent-dlmodal__close",
          { onclick: close, title: "关闭" },
          "✕",
        ),
      ]),
      m("div.agent-dlmodal__body", [
        m("div.agent-dlmodal__section", [
          m("div.agent-dlmodal__section-title", "快速预设"),
          m(
            "div.agent-dlmodal__presets",
            DOWNLOAD_PRESETS.map((p) =>
              m(
                "button.agent-dlmodal__chip" +
                  (vnode.state.downloadPreset === p.key
                    ? ".agent-dlmodal__chip--active"
                    : ""),
                { onclick: () => applyPreset(p.key) },
                `${p.label}${p.animations.length ? ` · ${p.animations.length} 个动作` : " · 全部"}`,
              ),
            ),
          ),
        ]),
        m("div.agent-dlmodal__section", [
          m("div.agent-dlmodal__section-title", [
            "逐个勾选",
            m("span.agent-dlmodal__section-hint", `已选 ${checkedCount}/${exportable.length}`),
          ]),
          m(
            "div.agent-dlmodal__anims",
            exportable.map((a) =>
              m(
                "label.agent-dlmodal__anim",
                { key: a.value },
                [
                  m("input", {
                    type: "checkbox",
                    checked: !!sel[a.value],
                    onchange: (e: Event) => {
                      const target = e.target as HTMLInputElement;
                      vnode.state.downloadSelection[a.value] = target.checked;
                      // Desyncs from preset → mark as custom
                      vnode.state.downloadPreset = "custom";
                      m.redraw();
                    },
                  }),
                  m("span.agent-dlmodal__anim-name", a.value),
                  a.label && a.label !== a.value
                    ? m("span.agent-dlmodal__anim-label", a.label)
                    : null,
                ],
              ),
            ),
          ),
          m("div.agent-dlmodal__row", [
            m(
              "button.agent-dlmodal__linkbtn",
              {
                onclick: () => {
                  for (const a of exportable) vnode.state.downloadSelection[a.value] = true;
                  vnode.state.downloadPreset = "full";
                  m.redraw();
                },
              },
              "全选",
            ),
            m(
              "button.agent-dlmodal__linkbtn",
              {
                onclick: () => {
                  for (const a of exportable) vnode.state.downloadSelection[a.value] = false;
                  vnode.state.downloadPreset = "custom";
                  m.redraw();
                },
              },
              "清空",
            ),
          ]),
        ]),
        m(
          "div.agent-dlmodal__tip",
          isFull
            ? "💡 将导出完整精灵表（832 × 3456 px，17 个动作）。玩家主角适合这种模式，NPC 建议用精简版。"
            : `🎯 只导出勾选的 ${checkedCount} 个动作，图片会比完整表小 ${exportable.length > 0
                ? Math.round((1 - checkedCount / exportable.length) * 100)
                : 0}%，非常适合 NPC / 怪物。`,
        ),
      ]),
      m("div.agent-dlmodal__foot", [
        m(
          "button.agent-dlmodal__btn.agent-dlmodal__btn--ghost",
          { onclick: close },
          "取消",
        ),
        m(
          "button.agent-dlmodal__btn.agent-dlmodal__btn--primary",
          {
            disabled: checkedCount === 0,
            onclick: doDownload,
          },
          [
            m("span", "↓"),
            m("span", isFull ? "导出完整 PNG" : `导出 ${checkedCount} 个动作 PNG`),
          ],
        ),
      ]),
    ]),
  ]);
}

function oncreateTick(
  vnode: m.Vnode<Attrs, State>,
  canvas: HTMLCanvasElement,
  now: number,
): void {
  if (!vnode.state) return;
  const cycle = ANIMATION_CONFIGS[vnode.state.animation as keyof typeof ANIMATION_CONFIGS];
  if (cycle) {
    const cycleLen = cycle.cycle.length;
    if (cycleLen > 0) {
      const fpsInterval = 1000 / 8;
      if (now - vnode.state.lastFrame > fpsInterval) {
        vnode.state.cycleIndex = (vnode.state.cycleIndex + 1) % cycleLen;
        vnode.state.lastFrame = now;
        drawFrame(canvas, vnode.attrs.session.getCanvas(), vnode.state.animation, vnode.state.cycleIndex);
      }
    }
  }
  // FPS meter — refresh every ~500ms.
  vnode.state.fpsCounter += 1;
  if (now - vnode.state.fpsLastTs > 500) {
    vnode.state.fps = Math.round(
      (vnode.state.fpsCounter * 1000) / (now - vnode.state.fpsLastTs),
    );
    vnode.state.fpsCounter = 0;
    vnode.state.fpsLastTs = now;
  }
  vnode.state.rafId = requestAnimationFrame((t) => oncreateTick(vnode, canvas, t));
}

function drawFrame(
  target: HTMLCanvasElement,
  src: HTMLCanvasElement | null,
  animation: string,
  cycleIndex: number,
): void {
  if (!target) return;
  const ctx = target.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, target.width, target.height);

  if (!src) {
    ctx.fillStyle = "#888";
    ctx.font = "14px sans-serif";
    ctx.fillText("rendering…", 8, 24);
    return;
  }

  const cfg = ANIMATION_CONFIGS[animation as keyof typeof ANIMATION_CONFIGS];
  if (!cfg) return;
  const frame = cfg.cycle[cycleIndex] ?? 0;
  const rowStart = cfg.row;
  const num = cfg.num;

  for (let i = 0; i < num; i++) {
    ctx.drawImage(
      src,
      frame * FRAME_SIZE,
      (rowStart + i) * FRAME_SIZE,
      FRAME_SIZE,
      FRAME_SIZE,
      i * FRAME_SIZE,
      0,
      FRAME_SIZE,
      FRAME_SIZE,
    );
  }
}
