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
  /** Triggered when user clicks "Download PNG" — session canvas is dumped. */
  onDownload?: () => void;
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
                a.value,
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
              onclick: () => vnode.attrs.onDownload?.(),
              title: "下载当前精灵表 PNG",
            },
            [
              m("span.agent-preview__download-icon", "↓"),
              m("span", "下载 PNG"),
            ],
          ),
        ]),
      ]),

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
