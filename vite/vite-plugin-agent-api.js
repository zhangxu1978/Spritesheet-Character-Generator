// vite/vite-plugin-agent-api.js — dev-server middleware that mounts the
// shared agent-handler.mjs at /api/agent/* so the same code path runs in
// `npm run dev` and `npm run start`. Also mounts /api/bundle, /api/metadata,
// /api/healthz via bundle-handler.mjs.

import { handle } from "../server/agent-handler.mjs";
import { handleBundleRoute } from "../server/bundle-handler.mjs";

/**
 * @returns {import('vite').Plugin}
 */
export function vitePluginAgentApi() {
  return {
    name: "agent-api-dev-middleware",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (url.startsWith("/api/agent/")) {
          try {
            await handle(req, res);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                ok: false,
                error: { kind: "internal", message },
              }),
            );
          }
          return;
        }
        if (url.startsWith("/api/")) {
          const handled = await handleBundleRoute(req, res);
          if (handled !== true) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({ ok: false, error: { kind: "not-found" } }),
            );
          }
          return;
        }
        return next();
      });
    },
  };
}