// render-main.ts — headless render runner for the MCP server.
//
// server/mcp-renderer.mjs loads mcp-render.html in headless Chromium and
// calls `window.__MCP_RENDER__(config)` via page.evaluate for each render
// request. The config is the normalized object produced by
// server/mcp/tools.mjs validateConfig():
//
//   { version: 2, bodyType, selections, selectedAnimation, animations }
//
// Rendering reuses the exact same AgentSession pipeline as the Agent page
// (sources/agent/session.ts) so MCP output matches what the UI produces.
// `window.__MCP_RENDER__` is assigned synchronously at module evaluation;
// the driver waits for it with page.waitForFunction before calling.

import { AgentSession } from "../agent/session.ts";
import type { Selections } from "../state/state.ts";

interface McpRenderInput {
  bodyType?: string;
  selections?: Selections;
  selectedAnimation?: string;
  animations?: string[];
}

interface McpRenderOutput {
  base64: string;
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  includedAnimations: string[];
}

declare global {
  interface Window {
    __MCP_RENDER__?: (cfg: McpRenderInput) => Promise<McpRenderOutput>;
  }
}

async function render(cfg: McpRenderInput): Promise<McpRenderOutput> {
  const session = new AgentSession({
    selections: cfg.selections ?? {},
    bodyType: cfg.bodyType ?? "male",
    animation: cfg.selectedAnimation ?? cfg.animations?.[0] ?? "walk",
  });
  await session.render();

  const wantAnims = Array.isArray(cfg.animations) ? cfg.animations : undefined;
  const png = wantAnims
    ? await session.toBase64PngSelected(wantAnims)
    : (await session.toBase64Png()).map((base64) => ({
        base64,
        width: session.getCanvas()?.width ?? 0,
        height: session.getCanvas()?.height ?? 0,
        includedAnimations: [] as string[],
      }));
  if (png.isErr()) {
    throw new Error(`canvas not initialized: ${png.error.kind}`);
  }
  const canvas = session.getCanvas();
  return {
    base64: png.value.base64,
    width: png.value.width,
    height: png.value.height,
    fullWidth: canvas?.width ?? 0,
    fullHeight: canvas?.height ?? 0,
    includedAnimations: png.value.includedAnimations,
  };
}

window.__MCP_RENDER__ = render;
