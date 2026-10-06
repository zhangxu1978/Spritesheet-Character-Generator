// tests/agent/mcp-stdio_spec.js — end-to-end test of the MCP stdio transport
// (server/mcp/stdio.mjs). Spawns the real server as a child process, speaks
// newline-delimited JSON-RPC on its stdin/stdout, and asserts the handshake
// plus tools/list. No browser / no rendering involved.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_PATH = path.join(PROJECT_ROOT, "server", "mcp", "stdio.mjs");

/**
 * Collect `count` JSON-RPC response lines from the child's stdout, with a
 * hard timeout so a hung server fails the test instead of hanging CI.
 */
function readResponses(child, count, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let buf = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `timeout waiting for ${count} responses (got ${lines.length}): ${lines.map((l) => JSON.stringify(l)).join(" | ")}`,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        lines.push(JSON.parse(line));
        if (lines.length >= count) {
          clearTimeout(timer);
          resolve(lines);
          return;
        }
      }
    });
    child.stderr.on("data", () => {}); // drain server logs
  });
}

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

test("stdio server completes the MCP handshake and serves tools/list", async (t) => {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGTERM");
  });

  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stdio-spec", version: "0.0.0" },
    },
  });
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  send(child, { jsonrpc: "2.0", id: 3, method: "no/such/method" });

  const [init, list, unknown] = await readResponses(child, 3);

  // initialize
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "lpc-spritesheet-generator");
  assert.ok(init.result.capabilities.tools);

  // tools/list
  assert.equal(list.id, 2);
  const names = list.result.tools.map((tl) => tl.name);
  assert.ok(names.includes("generate_spritesheet"));
  assert.ok(names.includes("build_config"));
  assert.equal(names.length, 8);

  // unknown method → JSON-RPC error
  assert.equal(unknown.id, 3);
  assert.equal(unknown.error.code, -32601);
});

test("stdio server shuts down cleanly when stdin closes", async (t) => {
  const child = spawn(process.execPath, [SERVER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  child.stdin.end(); // EOF → readline close → graceful shutdown(0)

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server did not exit after stdin EOF")),
      10_000,
    );
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(code, 0);
});

test("protocol module parses stdin lines exactly as the transport does", async () => {
  // Sanity-check the shared parse path used by stdio.mjs (import-level check
  // so a refactor of the module boundary fails loudly here too).
  const { parseLine } = await import(
    pathToFileURL(path.join(PROJECT_ROOT, "server", "mcp", "protocol.mjs")).href
  );
  assert.equal(parseLine(" \n"), null);
  assert.equal(parseLine("}bad{").error.error.code, -32768);
});
