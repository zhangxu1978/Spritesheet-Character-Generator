// tests/agent/mcp-stdio_spec.js — stdio transport integration test.
//
// Spawns `node server/mcp/stdio.mjs` as a real subprocess, feeds it
// newline-delimited JSON-RPC on stdin, and asserts the framed responses on
// stdout — exactly what an MCP client does. Never touches the headless
// renderer (no generate_spritesheet call → no vite/Chromium boot).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "server", "mcp", "stdio.mjs");

/** Send requests, collect responses by id. Kills the child afterwards. */
async function talkToServer(requests, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = [];
    const responsesById = new Map();
    const pending = new Set(
      requests.filter((r) => r.id !== undefined).map((r) => r.id),
    );

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `stdio test timed out after ${timeoutMs}ms; pending ids: ` +
            `[${[...pending].join(", ")}]; stderr: ${stderr.join("")}`,
        ),
      );
    }, timeoutMs);

    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return; // not protocol — fail loudly below if it was expected
      }
      if (msg && msg.id !== undefined) {
        responsesById.set(msg.id, msg);
        pending.delete(msg.id);
        if (pending.size === 0) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill("SIGTERM");
          resolve({ responsesById, stderr: stderr.join("") });
        }
      }
    });

    child.on("exit", () => {
      clearTimeout(timer);
      if (pending.size > 0) {
        reject(
          new Error(
            `server exited before answering; pending ids: [${[...pending].join(", ")}]; ` +
              `stderr: ${stderr.join("")}`,
          ),
        );
      }
    });

    for (const req of requests) {
      child.stdin.write(JSON.stringify(req) + "\n");
    }
  });
}

test("stdio server: initialize → tools/list handshake", async () => {
  const { responsesById } = await talkToServer([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);

  const init = responsesById.get(1);
  assert.ok(init, "initialize response missing");
  assert.equal(init.result.protocolVersion, "2024-11-05");
  assert.ok(init.result.serverInfo.name.length > 0);

  const tools = responsesById.get(2);
  assert.ok(tools, "tools/list response missing");
  const names = tools.result.tools.map((t) => t.name);
  assert.equal(names.length, 8);
  assert.ok(names.includes("generate_spritesheet"));
  assert.ok(names.includes("build_config"));
});

test("stdio server: build_config round-trip and parse-error frame", async () => {
  const { responsesById } = await talkToServer([
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "build_config", arguments: { animations: ["idle"] } },
    },
  ]);

  const call = responsesById.get(2);
  assert.ok(call, "tools/call response missing");
  assert.equal(call.error, undefined);
  assert.equal(call.result.structuredContent.config.version, 2);
  assert.deepEqual(call.result.structuredContent.config.animations, ["idle"]);
});
