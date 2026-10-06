// mcp-renderer.mjs — headless spritesheet renderer for the MCP server.
//
// The LPC renderer needs a DOM canvas, so plain Node can't draw. This module
// reuses the proven pattern from scripts/issue382-golden-playwright.js:
//
//   spawn `npx vite` (source-mode dev server, random free port) → launch
//   headless Chromium via Playwright → load the minimal runner page
//   (mcp-render.html + sources/mcp/render-main.ts, which drives the existing
//   AgentSession) → page.evaluate(window.__MCP_RENDER__(config)) → PNG base64.
//
// Lifecycle: lazily started on the first render, then reused for subsequent
// renders (one vite child + one browser + one page). Renders are serialized
// through a promise queue. `shutdownRenderer()` tears everything down; the
// vite child is also killed on process exit (sync hook).

import { spawn, execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RUNNER_URL_PATH = "/mcp-render.html";

const VITE_BOOT_TIMEOUT_MS = 30_000;
const FIRST_RENDER_TIMEOUT_MS = 120_000;
const RENDER_TIMEOUT_MS = 60_000;

function log(...args) {
  console.error("[mcp-renderer]", ...args);
}

/** Reject when the wrapped promise exceeds `ms`. Clears the timer on settle. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// ─── Singletons ────────────────────────────────────────────────────────────

let state = null; // { viteChild, browser, page, baseUrl }
let queue = Promise.resolve();

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHttpOk(url, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for vite dev server: ${url}`);
}

/** Kill a spawned child and (on Windows) its whole process tree. */
function killChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    // shell:true wraps the command, so killing the shell alone would leave
    // the underlying npx/vite process alive and holding the port.
    execFile(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      () => {}, // best-effort
    );
  } else {
    child.kill("SIGTERM");
  }
}

async function startRenderer() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  log(`starting vite dev server on ${baseUrl} …`);
  const viteChild = spawn(
    "npx",
    ["vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: REPO_ROOT,
      stdio: "ignore",
      shell: process.platform === "win32",
    },
  );
  viteChild.on("exit", (code) => {
    if (state && state.viteChild === viteChild && code !== 0 && code !== null) {
      log(`vite exited with code ${code}`);
    }
  });

  // Sync exit hook so the dev server never outlives this process.
  process.on("exit", () => killChild(viteChild));

  try {
    await waitForHttpOk(`${baseUrl}${RUNNER_URL_PATH}`, VITE_BOOT_TIMEOUT_MS);

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on("pageerror", (e) => log("page error:", String(e)));

    await loadRunner(page, baseUrl);

    state = { viteChild, browser, page, baseUrl, firstRenderDone: false };
    log("renderer ready");
  } catch (e) {
    killChild(viteChild);
    throw e;
  }
}

async function loadRunner(page, baseUrl) {
  await page.goto(`${baseUrl}${RUNNER_URL_PATH}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  // render-main.ts is an ES module; wait for it to expose the render hook.
  await page.waitForFunction(
    () => typeof window.__MCP_RENDER__ === "function",
    undefined,
    { timeout: 60_000 },
  );
}

async function freshPage() {
  const page = await state.browser.newPage();
  page.on("pageerror", (e) => log("page error:", String(e)));
  await loadRunner(page, state.baseUrl);
  return page;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Render a character config to a spritesheet PNG.
 *
 * @param {{bodyType: string, selections: object, selectedAnimation: string, animations: string[]}} config
 *   Normalized config from server/mcp/tools.mjs validateConfig().
 * @returns {Promise<{base64: string, width: number, height: number,
 *   fullWidth: number, fullHeight: number, includedAnimations: string[]}>}
 */
export function renderSpritesheet(config) {
  const run = queue.then(() => renderOnce(config));
  // Keep the queue alive even when a render fails.
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function renderOnce(config) {
  if (!state) await startRenderer();

  // First render pays for catalog loading + the initial render pass, so it
  // gets the longer budget.
  const timeoutMs = state.firstRenderDone
    ? RENDER_TIMEOUT_MS
    : FIRST_RENDER_TIMEOUT_MS;

  try {
    const result = await withTimeout(
      state.page.evaluate((cfg) => window.__MCP_RENDER__(cfg), config),
      timeoutMs,
      "render",
    );
    state.firstRenderDone = true;
    if (!result || typeof result.base64 !== "string") {
      throw new Error("runner returned no PNG data");
    }
    return result;
  } catch (e) {
    // Recreate the page so the next call starts from a clean slate.
    try {
      const old = state.page;
      state.page = await freshPage();
      await old.close().catch(() => {});
    } catch (recreateErr) {
      log("page recreate failed:", String(recreateErr));
    }
    throw e;
  }
}

/** Tear down the vite child + browser. Safe to call multiple times. */
export async function shutdownRenderer() {
  const s = state;
  state = null;
  if (!s) return;
  try {
    await s.browser?.close();
  } catch {
    /* best-effort */
  }
  killChild(s.viteChild);
  log("renderer shut down");
}
