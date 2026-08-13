// server/index.mjs — production Express server.
//
//   - Serves dist/ as static files in production.
//   - Always mounts /api/agent/* via the shared agent-handler.mjs so the
//     same code path runs in dev (Vite middleware) and prod (this file).
//
// Run with `npm run start`.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "./agent-handler.mjs";
import { handleBundleRoute } from "./bundle-handler.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4173);
const DIST = path.resolve(__dirname, "..", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";

  // API routes
  if (url.startsWith("/api/agent/")) {
    return handle(req, res);
  }

  // Bundle / metadata / healthz 路由(比 agent-handler 先匹配,因为
  // agent-handler 只处理 /api/agent/*)
  if (url.startsWith("/api/")) {
    const handled = await handleBundleRoute(req, res);
    if (handled !== true) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: { kind: "not-found" } }));
    }
    return;
  }

  // Static files
  let pathname = url.split("?")[0];
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(DIST, decodeURIComponent(pathname));

  // Prevent path traversal.
  if (!filePath.startsWith(DIST)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback — serve index.html
      const fallback = path.join(DIST, "index.html");
      fs.readFile(fallback, (e2, data) => {
        if (e2) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        res.setHeader("Content-Type", MIME[".html"]);
        res.end(data);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", MIME[ext] ?? "application/octet-stream");
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] agent API at http://localhost:${PORT}/api/agent/tools`);
});