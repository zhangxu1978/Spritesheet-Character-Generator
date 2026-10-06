// mcp-renderer.mjs — headless render backend for the MCP server.
//
// The LPC renderer draws to <canvas> (browser-only), but MCP tools must
// produce a real PNG inside Node. Strategy:
//
//   1. One-time: bundle a MINIMAL render page with vite's build API
//      (configFile: false — deliberately NOT the project vite.config.js,
//      whose dev-server startup stalls for minutes on this repo's ~88k
//      spritesheet files via vite-multiple-assets).
//   2. Serve the bundle + repo spritesheets/ with a tiny in-process
//      node:http static server on a random free port (no child process).
//   3. Launch Playwright Chromium headless, open one page, keep it forever.
//   4. Each render = page.evaluate(() => window.__MCP_RENDER__(config))
//      which runs sources/mcp/render-main.ts (AgentSession) in the browser —
//      the exact same rendering code path as the Web UI / Agent page.
//
// One render at a time (promise queue). All logging goes to stderr — this
// module runs inside the MCP stdio server whose stdout is the protocol
// channel.
//
// Cleanup: shutdown() closes the browser and the static server; registered
// on process exit / SIGINT / SIGTERM by server/mcp/stdio.mjs.

/* eslint-disable no-undef -- page.evaluate / waitForFunction callbacks execute in the browser */

import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RENDER_DIST = path.join(REPO_ROOT, "tmp", "mcp-render-dist");

const READY_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 300_000; // one-time bundle creation
const FIRST_RENDER_TIMEOUT_MS = 120_000; // page load + catalog + sprite fetches
const RENDER_TIMEOUT_MS = 60_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function log(...args) {
  console.error("[mcp-renderer]", ...args);
}

/** Ask the OS for a free TCP port, then release it. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ─── One-time bundle build (vite build API, minimal inline config) ────────

function bundleIsFresh() {
  if (process.env.MCP_REBUILD === "1") return false;
  return fs.existsSync(path.join(RENDER_DIST, "mcp-render.html"));
}

async function buildRenderBundle() {
  log(`bundling render page into ${path.relative(REPO_ROOT, RENDER_DIST)} …`);
  const { build } = await import("vite");
  const { itemMetadataResolveAliases, itemMetadataPlugins } = await import(
    pathToFileURL(path.join(REPO_ROOT, "vite", "wiring.js")).href
  );
  await withTimeout(
    build({
      // Deliberately NOT the project config: the project dev config's
      // spritesheet-serving plugin stalls startup for minutes on this repo.
      configFile: false,
      root: REPO_ROOT,
      base: "./",
      logLevel: "warn",
      publicDir: false,
      // Keeps the bundled catalog metadata in sync with sheet_definitions/
      // (skips instantly when inputs are unchanged — same as normal build).
      plugins: itemMetadataPlugins("build"),
      resolve: {
        alias: itemMetadataResolveAliases(),
      },
      build: {
        outDir: RENDER_DIST,
        emptyOutDir: true,
        target: "esnext",
        rolldownOptions: {
          input: {
            render: "mcp-render.html",
          },
        },
      },
    }),
    BUILD_TIMEOUT_MS,
    "render bundle build",
  );
  log("bundle ready");
}

// ─── In-process static server (bundle + spritesheets) ─────────────────────

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
  fs.createReadStream(filePath).pipe(res);
}

function createStaticServer() {
  return createHttpServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent((req.url ?? "/").split("?")[0]);
    } catch {
      res.statusCode = 400;
      res.end("bad request");
      return;
    }
    if (pathname === "/") pathname = "/mcp-render.html";

    const roots =
      pathname === "/mcp-render.html" || pathname.startsWith("/assets/")
        ? [{ prefix: "", root: RENDER_DIST }]
        : [{ prefix: "/spritesheets/", root: path.join(REPO_ROOT, "spritesheets") }];

    for (const { prefix, root } of roots) {
      if (!pathname.startsWith(prefix)) continue;
      const rel = pathname.slice(prefix.length);
      const filePath = path.resolve(root, `.${path.sep}${rel}`);
      if (!filePath.startsWith(path.resolve(root))) {
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        serveFile(res, filePath);
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
}

// ─── Lazy singleton state ───────────────────────────────────────────────────

let starting = null; // Promise<void> while booting
let httpServer = null;
let browser = null;
let page = null;
let baseUrl = null; // http://127.0.0.1:<port>
let queue = Promise.resolve(); // serializes renders
let firstRenderDone = false;

async function start() {
  if (starting) return starting;
  starting = (async () => {
    if (!bundleIsFresh()) {
      await buildRenderBundle();
    }
    const port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    await new Promise((resolve, reject) => {
      httpServer = createStaticServer();
      httpServer.once("error", reject);
      httpServer.listen(port, "127.0.0.1", resolve);
    });

    log(`launching headless Chromium against ${baseUrl} …`);
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    await openRenderPage();
    log("renderer ready");
  })();
  // Reset on failure so the next call can retry.
  starting.catch(() => {
    starting = null;
  });
  return starting;
}

async function openRenderPage() {
  page = await browser.newPage();
  page.on("pageerror", (e) => log("page error:", String(e)));
  page.on("console", (msg) => {
    if (msg.type() === "error") log("page console:", msg.text());
  });
  page.on("requestfailed", (req) =>
    log("request failed:", req.url(), req.failure()?.errorText ?? ""),
  );
  page.on("response", (res) => {
    if (res.status() >= 400) log("HTTP", res.status(), res.url());
  });
  await page.goto(`${baseUrl}/mcp-render.html`, {
    waitUntil: "networkidle",
    timeout: READY_TIMEOUT_MS,
  });
  await page.waitForFunction(() => window.__MCP_READY__ === true, undefined, {
    timeout: READY_TIMEOUT_MS,
  });
}

async function renderOnce(config) {
  const result = await page.evaluate(async (cfg) => window.__MCP_RENDER__(cfg), config);
  if (!result || result.ok !== true) {
    throw new Error(result?.error ?? "renderer returned no result");
  }
  return result;
}

/**
 * Render a spritesheet. Serializes concurrent calls; boots the backend on
 * first use (bundle build + static server + Chromium).
 *
 * @param {{ selections: object, bodyType: string, animation: string,
 *           animations?: string[] }} config
 * @returns {Promise<{ base64: string, width: number, height: number,
 *                     fullWidth: number, fullHeight: number,
 *                     includedAnimations: string[] }>}
 */
export async function renderSpritesheet(config) {
  const run = queue.catch(() => {});
  const task = run.then(async () => {
    await start();
    const timeout = firstRenderDone ? RENDER_TIMEOUT_MS : FIRST_RENDER_TIMEOUT_MS;
    try {
      const result = await withTimeout(
        renderOnce(config),
        timeout,
        firstRenderDone ? "render" : "first render (page load + catalog)",
      );
      firstRenderDone = true;
      return result;
    } catch (e) {
      // Destroy the page so the next attempt starts from a clean slate.
      try {
        if (page) await page.close();
      } catch {
        /* ignore */
      }
      page = null;
      if (browser) {
        try {
          await openRenderPage();
        } catch (recoveryError) {
          log("page recovery failed:", String(recoveryError));
          page = null;
        }
      }
      throw e;
    }
  });
  queue = task;
  return task;
}

/** Close browser + static server. Safe to call multiple times. */
export async function shutdownRenderer() {
  try {
    if (page) await page.close().catch(() => {});
  } catch {
    /* ignore */
  }
  page = null;
  try {
    if (browser) await browser.close().catch(() => {});
  } catch {
    /* ignore */
  }
  browser = null;
  try {
    if (httpServer) await new Promise((r) => httpServer.close(r));
  } catch {
    /* ignore */
  }
  httpServer = null;
  starting = null;
  baseUrl = null;
  firstRenderDone = false;
}

/** Test helper: whether the backend has been booted. */
export function isRendererStarted() {
  return browser !== null;
}
