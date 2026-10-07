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
import {
  getCustomAnimations,
  getCustomAnimYPositions,
} from "../canvas/preview-animation.ts";
import { CUSTOM_ANIM_LABELS } from "./tools.ts";
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
  /** Animations included in the last agent-produced PNG (for download dialog default). */
  lastIncludedAnimations?: string[];
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
const DOWNLOAD_PRESETS: Array<{
  key: string;
  label: string;
  animations: string[];
}> = [
  { key: "full", label: "完整大表", animations: [] },
  { key: "static", label: "静态摆件", animations: ["idle"] },
  { key: "npc", label: "NPC (待机+走)", animations: ["idle", "walk"] },
  { key: "shop", label: "商人 (待机+表情)", animations: ["idle", "emote"] },
  { key: "guard", label: "守卫", animations: ["idle", "walk", "hurt"] },
  {
    key: "enemy",
    label: "近战小怪",
    animations: ["idle", "walk", "hurt", "slash"],
  },
  {
    key: "ranged",
    label: "远程小怪",
    animations: ["idle", "walk", "hurt", "shoot", "spellcast"],
  },
  {
    key: "boss",
    label: "BOSS",
    animations: ["idle", "walk", "run", "hurt", "slash", "spellcast", "jump"],
  },
  {
    key: "player",
    label: "玩家主角",
    animations: [
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
    ],
  },
  {
    key: "mount",
    label: "坐骑/宠物",
    animations: ["idle", "walk", "run", "hurt"],
  },
];

type AnimOption = {
  value: string;
  label?: string;
  custom?: boolean;
  frameSize?: number;
};

/**
 * Standard exportable animations + the custom animations (tool_axe, …)
 * present in the current render — i.e. only those declared by the currently
 * equipped weapon/tool, so the dialog never offers rows the PNG can't have.
 */
function currentAnimOptions(): AnimOption[] {
  const standard: AnimOption[] = ANIMATIONS.filter(
    (a) => !(a as { noExport?: boolean }).noExport,
  );
  const custom: AnimOption[] = Object.entries(getCustomAnimations()).map(
    ([value, def]) => ({
      value,
      label: CUSTOM_ANIM_LABELS[value] ?? value,
      custom: true,
      frameSize: def.frameSize,
    }),
  );
  return [...standard, ...custom];
}

/** Cycle frame count for the animation being previewed (custom-aware). */
function cycleLengthFor(animation: string): number {
  const customDef = getCustomAnimations()[animation];
  if (customDef) return customDef.frames[0].length;
  return (
    ANIMATION_CONFIGS[animation as keyof typeof ANIMATION_CONFIGS]?.cycle
      .length ?? 0
  );
}

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
    const canvas = vnode.dom.querySelector(
      "canvas",
    ) as HTMLCanvasElement | null;
    if (!canvas) return;
    canvas.width = FRAME_SIZE * 4; // 4 directions
    canvas.height = FRAME_SIZE;
    vnode.state.rafId = requestAnimationFrame((now) =>
      oncreateTick(vnode, canvas, now),
    );
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
    const cycleLen = cycleLengthFor(current);
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
            [
              ...ANIMATIONS.map((a) =>
                m(
                  "option",
                  { value: a.value, selected: a.value === current },
                  `${a.value}${a.label && a.label !== a.value ? ` (${a.label})` : ""}`,
                ),
              ),
              // Custom animation areas rendered for the equipped weapon/tool.
              ...Object.entries(getCustomAnimations()).map(([value, def]) =>
                m(
                  "option",
                  { value, selected: value === current },
                  `${value} (${CUSTOM_ANIM_LABELS[value] ?? value} · ${def.frameSize}px)`,
                ),
              ),
            ],
          ),
        ]),
        m("div.agent-preview__toolbar-right", [
          m("div.agent-preview__counter", [
            m(
              "span.agent-preview__counter-num",
              String(vnode.state.cycleIndex),
            ),
            m("span.agent-preview__counter-sep", "/"),
            m(
              "span.agent-preview__counter-total",
              String(Math.max(cycleLen - 1, 0)),
            ),
          ]),
          m(
            "button.agent-preview__download",
            {
              onclick: () => {
                vnode.state.downloadDialogOpen = true;
                // Default to the animations the agent already selected;
                // fall back to full sheet if agent didn't do selective export.
                const included = vnode.attrs.lastIncludedAnimations;
                const options = currentAnimOptions();
                if (included && included.length > 0) {
                  for (const o of options)
                    vnode.state.downloadSelection[o.value] = false;
                  for (const v of included)
                    vnode.state.downloadSelection[v] = true;
                  vnode.state.downloadPreset = "custom";
                } else {
                  for (const o of options)
                    vnode.state.downloadSelection[o.value] = true;
                  vnode.state.downloadPreset = "full";
                }
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
      vnode.state.downloadDialogOpen ? renderDownloadDialog(vnode) : null,

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
  // Standard exportable animations + custom ones present in the current
  // render (tool_axe etc. — declared by the equipped weapon/tool).
  const options = currentAnimOptions();
  const customOptions = options.filter((o) => o.custom);
  const checkedCount = options.filter((o) => sel[o.value]).length;
  const isFull = vnode.state.downloadPreset === "full";

  const applyPreset = (presetKey: string) => {
    vnode.state.downloadPreset = presetKey;
    const preset = DOWNLOAD_PRESETS.find((p) => p.key === presetKey);
    if (!preset) return;
    if (preset.animations.length === 0) {
      // full → select everything currently exportable (incl. custom areas)
      for (const o of options) vnode.state.downloadSelection[o.value] = true;
    } else {
      for (const o of options) vnode.state.downloadSelection[o.value] = false;
      for (const v of preset.animations)
        vnode.state.downloadSelection[v] = true;
    }
    m.redraw();
  };

  const close = () => {
    vnode.state.downloadDialogOpen = false;
    m.redraw();
  };

  const doDownload = () => {
    const picked = options.filter((o) => sel[o.value]).map((o) => o.value);
    // If everything is on → pass undefined to mean "full sheet"
    const allOn = picked.length === options.length;
    vnode.attrs.onDownload?.(allOn ? undefined : picked);
    close();
  };

  const renderAnimCheckbox = (o: AnimOption) =>
    m("label.agent-dlmodal__anim", { key: o.value }, [
      m("input", {
        type: "checkbox",
        checked: !!sel[o.value],
        onchange: (e: Event) => {
          const target = e.target as HTMLInputElement;
          vnode.state.downloadSelection[o.value] = target.checked;
          // Desyncs from preset → mark as custom
          vnode.state.downloadPreset = "custom";
          m.redraw();
        },
      }),
      m("span.agent-dlmodal__anim-name", o.value),
      o.custom
        ? m(
            "span.agent-dlmodal__anim-label",
            ` ${o.label ?? ""} · ${o.frameSize}px 专属动作`,
          )
        : o.label && o.label !== o.value
          ? m("span.agent-dlmodal__anim-label", o.label)
          : null,
    ]);

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
            m(
              "span.agent-dlmodal__section-hint",
              `已选 ${checkedCount}/${options.length}`,
            ),
          ]),
          m(
            "div.agent-dlmodal__anims",
            options.filter((o) => !o.custom).map(renderAnimCheckbox),
          ),
          customOptions.length > 0
            ? m("div.agent-dlmodal__section", [
                m("div.agent-dlmodal__section-title", [
                  "专属动作（当前装备的武器/工具）",
                  m(
                    "span.agent-dlmodal__section-hint",
                    "大帧动作区，位于标准动作区下方",
                  ),
                ]),
                m(
                  "div.agent-dlmodal__anims",
                  customOptions.map(renderAnimCheckbox),
                ),
              ])
            : null,
          m("div.agent-dlmodal__row", [
            m(
              "button.agent-dlmodal__linkbtn",
              {
                onclick: () => {
                  for (const o of options)
                    vnode.state.downloadSelection[o.value] = true;
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
                  for (const o of options)
                    vnode.state.downloadSelection[o.value] = false;
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
            ? "💡 将导出完整精灵表（标准动作 832 × 3456 px；装备斧/大剑等时下方还有更大的专属动作区）。玩家主角适合这种模式，NPC 建议用精简版。"
            : `🎯 只导出勾选的 ${checkedCount} 个动作，图片会比完整表小 ${
                options.length > 0
                  ? Math.round((1 - checkedCount / options.length) * 100)
                  : 0
              }%，非常适合 NPC / 怪物。`,
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
            m(
              "span",
              isFull ? "导出完整 PNG" : `导出 ${checkedCount} 个动作 PNG`,
            ),
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
  const cycleLen = cycleLengthFor(vnode.state.animation);
  if (cycleLen > 0) {
    const fpsInterval = 1000 / 8;
    if (now - vnode.state.lastFrame > fpsInterval) {
      vnode.state.cycleIndex = (vnode.state.cycleIndex + 1) % cycleLen;
      vnode.state.lastFrame = now;
      drawFrame(
        canvas,
        vnode.attrs.session.getCanvas(),
        vnode.state.animation,
        vnode.state.cycleIndex,
      );
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
  vnode.state.rafId = requestAnimationFrame((t) =>
    oncreateTick(vnode, canvas, t),
  );
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

  // Custom animation area (tool_axe, …): larger frames appended below the
  // standard sheet, 4 direction rows of `frameSize` px.
  const customDef = getCustomAnimations()[animation];
  if (customDef) {
    const frameSize = customDef.frameSize;
    const yOffset = getCustomAnimYPositions()[animation];
    target.width = frameSize * 4;
    target.height = frameSize;
    if (yOffset === undefined) {
      ctx.fillStyle = "#888";
      ctx.font = "14px sans-serif";
      ctx.fillText("装备对应武器/工具后渲染才可预览", 8, frameSize / 2);
      return;
    }
    const frameCount = customDef.frames[0].length;
    const frame = cycleIndex % frameCount;
    for (let i = 0; i < 4; i++) {
      ctx.drawImage(
        src,
        frame * frameSize,
        yOffset + i * frameSize,
        frameSize,
        frameSize,
        i * frameSize,
        0,
        frameSize,
        frameSize,
      );
    }
    return;
  }

  const cfg = ANIMATION_CONFIGS[animation as keyof typeof ANIMATION_CONFIGS];
  if (!cfg) return;
  target.width = FRAME_SIZE * 4;
  target.height = FRAME_SIZE;
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
