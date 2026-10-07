// MCP render runner — browser-side entry for mcp-render.html.
//
// server/mcp-renderer.mjs drives this page headlessly (Playwright Chromium)
// and calls window.__MCP_RENDER__(config) once per generate_spritesheet tool
// call. The actual rendering reuses AgentSession — the exact same code path
// the Agent page and Web UI use — so MCP output matches what a human sees.
//
// Protocol per call:
//   config = { selections?, bodyType?, animation?, animations? }
//   result = { ok: true, base64, width, height, fullWidth, fullHeight,
//              includedAnimations, normalizedSelections } | { ok: false, error }
//
// `normalizedSelections` mirrors the input selections with one fix applied:
// recolor-capable items submitted without a `recolor` get their palette's
// default color. The Web UI can never produce a recolor-less selection for
// those items (the tree always passes the picked color), so the raw MCP
// selections would resolve variant-style sprite paths that 404 on the flat,
// palette-recolored files on disk. Normalizing here keeps the render correct
// AND lets the exported config re-import into the Web UI verbatim.

import { AgentSession, type SessionOptions } from "../agent/session.ts";
import type { Selections } from "../state/state.ts";
import { normalizeSelectionRecolors } from "../state/selection-normalize.ts";
import { loadAllMetadata } from "../install-item-metadata.ts";
import {
  getCustomAnimations,
  getCustomAnimYPositions,
} from "../canvas/preview-animation.ts";

interface McpRenderConfig {
  selections?: Selections;
  bodyType?: string;
  animation?: string;
  animations?: string[];
}

interface McpCustomAnimationLayout {
  name: string;
  frameSize: number;
  frameCount: number;
  yOffset: number;
}

interface McpRenderOk {
  ok: true;
  base64: string;
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  includedAnimations: string[];
  /** Custom-animation areas present in the full canvas (tool_axe, …). */
  customAnimations: McpCustomAnimationLayout[];
  normalizedSelections: Selections;
}

interface McpRenderFailed {
  ok: false;
  error: string;
}

declare global {
  interface Window {
    __MCP_READY__?: boolean;
    __MCP_RENDER__: (
      config: McpRenderConfig,
    ) => Promise<McpRenderOk | McpRenderFailed>;
  }
}

const status = document.getElementById("mcp-render-status");

window.__MCP_RENDER__ = async (config) => {
  try {
    // Memoized inside install-item-metadata.ts; first call loads the five
    // metadata chunks, later calls resolve immediately.
    await loadAllMetadata();

    // Empty selections → AgentSession bootstraps the default body/head/face
    // trio (same as the Web UI's initial state).
    let normalized: Selections = {};
    const provided = config.selections ?? {};
    if (Object.keys(provided).length > 0) {
      normalized = normalizeSelectionRecolors(provided);
    }

    const opts: SessionOptions = {};
    if (Object.keys(normalized).length > 0) opts.selections = normalized;
    if (config.bodyType) opts.bodyType = config.bodyType;
    if (config.animation) opts.animation = config.animation;

    const session = new AgentSession(opts);
    await session.render();

    const animations =
      config.animations && config.animations.length > 0
        ? config.animations
        : undefined;
    const result = await session.toBase64PngSelected(animations);
    if (result.isErr()) {
      return { ok: false, error: "canvas-not-initialized" };
    }
    const full = session.getCanvas();
    // Report the selections actually rendered — AgentSession may have
    // bootstrapped the default trio when the caller passed none.
    const renderedSelections = session.getSelections();
    const normalizedSelections =
      Object.keys(normalized).length > 0 ? normalized : renderedSelections;
    // Custom-animation areas (tool_axe, …) appended below the standard sheet.
    const renderedCustomAnims = getCustomAnimations();
    const customYPositions = getCustomAnimYPositions();
    const customAnimations: McpCustomAnimationLayout[] = Object.entries(
      renderedCustomAnims,
    )
      .map(([name, def]) => ({
        name,
        frameSize: def.frameSize,
        frameCount: def.frames[0].length,
        yOffset: customYPositions[name] ?? 0,
      }))
      .sort((a, b) => a.yOffset - b.yOffset);
    return {
      ok: true,
      base64: result.value.base64,
      width: result.value.width,
      height: result.value.height,
      fullWidth: full?.width ?? result.value.width,
      fullHeight: full?.height ?? result.value.height,
      includedAnimations: result.value.includedAnimations,
      customAnimations,
      normalizedSelections,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (status) status.textContent = "MCP render runner ready";
  }
};

// Boot catalog metadata eagerly so the first render doesn't pay the full cost.
void loadAllMetadata().then(() => {
  if (status) status.textContent = "MCP render runner ready";
  window.__MCP_READY__ = true;
});
