// Agent session — an isolated working state for the Agent page / API.
//
// One session = one Selections snapshot + one body type + one preview animation
// + one offscreen canvas. Tools read/write through this session; the Agent
// page and the `/api/agent/*` HTTP endpoints both consume the same `ToolSession`
// interface.
//
// Why we don't just mutate the global `state`:
//   - The main UI's `state` is observed by Mithril and rerenders on every
//     mutation. Driving it from API requests would stomp on user UI work.
//   - `renderCharacter` is shared infrastructure; isolating the canvas via
//     `targetCanvas` keeps the Agent canvas from clobbering the main preview.
//
// Implementation notes:
//   - `state` (the Selections object) is plain JSON so it round-trips through
//     hash / URL / fetch safely.
//   - `canvas` is created lazily on first `render()` so SSR / Node contexts
//     that never render pay no cost.
//   - `selectItem` is imported from the existing state module — it does not
//     mutate the global `state`; it only reads catalog metadata. We pass it
//     our session-scoped selections object via a tiny adapter.

import { ok, err, type Result } from "neverthrow";
import {
  BODY_TYPES,
  ANIMATIONS,
} from "../state/constants.ts";
import type { Selection, Selections } from "../state/state.ts";
import {
  SHEET_WIDTH,
  SHEET_HEIGHT,
  renderCharacter,
} from "../canvas/renderer.ts";
import { defaultCatalog, catalogReady } from "../state/catalog.ts";
import type { ToolSession } from "./types.ts";

const ALLOWED_BODY_TYPES = new Set(BODY_TYPES);
const ALLOWED_ANIMATIONS = new Set(ANIMATIONS.map((a) => a.value));

/** Equivalent of state.ts getSelectionGroup — reads catalog for the item's type_name. */
function getSelectionGroupForItem(itemId: string): string {
  const meta = defaultCatalog.getItemLite(itemId).unwrapOr(null);
  if (!meta || !meta.type_name) return itemId;
  return meta.type_name;
}

/**
 * Build the default selections for a given bodyType: body color (light) +
 * matching human head + neutral face. Mirrors selectDefaults() in state.ts.
 */
function buildDefaultSelections(bodyType: string): Selections {
  const result: Selections = {};

  // 1. Body color layer — always "body", light variant
  const bodyItemId = "body";
  try {
    const group = getSelectionGroupForItem(bodyItemId);
    result[group] = {
      itemId: bodyItemId,
      variant: "",
      recolor: "light",
      name: "Body color (light)",
    };
  } catch {
    result[bodyItemId] = {
      itemId: bodyItemId,
      variant: "",
      recolor: "light",
      name: "Body color (light)",
    };
  }

  // 2. Human head — pick the itemId that matches bodyType suffix
  //    state.ts uses "heads_human_male"; we suffix the body type (male / female / teen / …)
  const headItemId = `heads_human_${bodyType}`;
  try {
    const group = getSelectionGroupForItem(headItemId);
    result[group] = {
      itemId: headItemId,
      variant: "",
      recolor: "light",
      name: `Human ${bodyType} (light)`,
    };
  } catch {
    // Fallback to male head if the exact body-type head doesn't exist in catalog
    try {
      const fallbackId = "heads_human_male";
      const group = getSelectionGroupForItem(fallbackId);
      result[group] = {
        itemId: fallbackId,
        variant: "",
        recolor: "light",
        name: "Human male (light)",
      };
    } catch {
      result.heads = {
        itemId: "heads_human_male",
        variant: "",
        recolor: "light",
        name: "Human male (light)",
      };
    }
  }

  // 3. Neutral face expression
  const expressionItemId = "face_neutral";
  try {
    const group = getSelectionGroupForItem(expressionItemId);
    result[group] = {
      itemId: expressionItemId,
      variant: "",
      recolor: "light",
      name: "Neutral (light)",
    };
  } catch {
    result[expressionItemId] = {
      itemId: expressionItemId,
      variant: "",
      recolor: "light",
      name: "Neutral (light)",
    };
  }

  return result;
}

export interface SessionOptions {
  /** Initial selections (defaults to `{}`). */
  selections?: Selections;
  /** Initial body type (defaults to `male`). */
  bodyType?: string;
  /** Initial animation (defaults to `walk`). */
  animation?: string;
}

export class AgentSession implements ToolSession {
  private selections: Selections;
  private bodyType: string;
  private animation: string;
  private canvas: HTMLCanvasElement | null = null;

  constructor(opts: SessionOptions = {}) {
    this.bodyType = ALLOWED_BODY_TYPES.has(opts.bodyType ?? "")
      ? (opts.bodyType as string)
      : "male";
    this.animation = ALLOWED_ANIMATIONS.has(opts.animation ?? "")
      ? (opts.animation as string)
      : "walk";
    // If caller provided explicit selections, use them as-is; otherwise
    // bootstrap the same default "body + head + face" trio that index.html
    // uses (selectDefaults in state.ts). Without this the character body
    // layer is missing and only clothes/weapons render onto transparent.
    const provided = opts.selections;
    if (provided && Object.keys(provided).length > 0) {
      this.selections = JSON.parse(JSON.stringify(provided));
    } else {
      this.selections = buildDefaultSelections(this.bodyType);
    }
  }

  // ─── ToolSession ────────────────────────────────────────────────────────

  getSelections(): Selections {
    // Caller is expected to treat the returned object as read-only. We
    // intentionally return a shallow clone so tool-side bugs can't mutate
    // our internal state behind our back.
    return JSON.parse(JSON.stringify(this.selections));
  }
  getBodyType(): string {
    return this.bodyType;
  }
  getAnimation(): string {
    return this.animation;
  }

  setSelections(next: Selections): void {
    this.selections = JSON.parse(JSON.stringify(next));
  }
  setBodyType(bodyType: string): void {
    if (!ALLOWED_BODY_TYPES.has(bodyType)) {
      throw new Error(`unsupported body type: ${bodyType}`);
    }
    this.bodyType = bodyType;
  }
  setAnimation(animation: string): void {
    if (!ALLOWED_ANIMATIONS.has(animation)) {
      throw new Error(`unsupported animation: ${animation}`);
    }
    this.animation = animation;
  }

  async reset(): Promise<void> {
    this.bodyType = "male";
    this.animation = "walk";
    this.selections = buildDefaultSelections(this.bodyType);
    await this.render();
  }

  async render(): Promise<void> {
    if (typeof document === "undefined") {
      // Node / SSR — nothing to draw to. Server-side rendering happens in
      // server/ and uses the headless renderer stub, not this method.
      return;
    }
    await catalogReady.onLayersReady;

    this.ensureCanvas();
    if (!this.canvas) {
      throw new Error("canvas not initialized");
    }
    // `renderCharacter` reads `state.customUploadedImage` from the module-
    // level `state` singleton. The Agent session never sets one, so we
    // explicitly null it here so a stray UI upload doesn't bleed in.
    const appState = await import("../state/state.ts");
    const prevCustom = appState.state.customUploadedImage;
    const prevZPos = appState.state.customImageZPos;
    appState.state.customUploadedImage = null;
    appState.state.customImageZPos = 0;
    try {
      await renderCharacter(this.selections, this.bodyType, this.canvas);
    } finally {
      appState.state.customUploadedImage = prevCustom;
      appState.state.customImageZPos = prevZPos;
    }
  }

  getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  /** Encode the current offscreen canvas as a base64 PNG string. */
  async toBase64Png(): Promise<Result<string, { kind: "canvas-not-initialized" }>> {
    this.ensureCanvas();
    if (!this.canvas) {
      return err({ kind: "canvas-not-initialized" });
    }
    // `toDataURL` is implemented natively in the browser and returns
    // `data:image/png;base64,…`. We strip the prefix so callers get just the
    // base64 payload — matches what `canvasToBlob → FileReader` would give.
    const url = this.canvas.toDataURL("image/png");
    const comma = url.indexOf(",");
    return ok(comma >= 0 ? url.slice(comma + 1) : url);
  }

  /** Snapshot the session state so it can be saved to hash / JSON. */
  serialize(): {
    selections: Selections;
    bodyType: string;
    animation: string;
  } {
    return {
      selections: JSON.parse(JSON.stringify(this.selections)),
      bodyType: this.bodyType,
      animation: this.animation,
    };
  }

  static deserialize(snapshot: {
    selections?: Selections;
    bodyType?: string;
    animation?: string;
  }): AgentSession {
    return new AgentSession({
      selections: snapshot.selections ?? {},
      bodyType: snapshot.bodyType ?? "male",
      animation: snapshot.animation ?? "walk",
    });
  }

  // ─── Internal helpers ──────────────────────────────────────────────────

  private ensureCanvas(): void {
    if (this.canvas) return;
    if (typeof document === "undefined") return;
    this.canvas = document.createElement("canvas");
    this.canvas.width = SHEET_WIDTH;
    this.canvas.height = SHEET_HEIGHT;
  }
}

// ─── In-memory session registry (browser side) ──────────────────────────

const sessions = new Map<string, AgentSession>();
let nextId = 1;

export function createOrGetSession(id?: string): AgentSession {
  if (id && sessions.has(id)) return sessions.get(id)!;
  const newId = id ?? `agent-${nextId++}`;
  const s = new AgentSession();
  sessions.set(newId, s);
  return s;
}

export function getSession(id: string): AgentSession | null {
  return sessions.get(id) ?? null;
}

export function dropSession(id: string): boolean {
  return sessions.delete(id);
}

export function listSessionIds(): string[] {
  return [...sessions.keys()];
}

export { ALLOWED_BODY_TYPES, ALLOWED_ANIMATIONS };

/** Re-export for tools that need to enumerate available body types. */
export const BODY_TYPE_LIST: string[] = [...BODY_TYPES];
export const ANIMATION_LIST: Array<{ value: string; label: string }> = ANIMATIONS.map(
  (a) => ({ value: a.value, label: a.value }),
);

/** Allow tools to validate an incoming selection payload. */
export function isSelection(value: unknown): value is Selection {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.itemId === "string" && typeof v.name === "string";
}