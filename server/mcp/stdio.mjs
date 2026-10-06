#!/usr/bin/env node
// stdio.mjs — MCP server entry point (stdio transport).
//
// Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout per the MCP spec.
// Register with any MCP client:
//
//   { "mcpServers": { "lpc-spritesheet": {
//       "command": "node",
//       "args": ["<repo>/server/mcp/stdio.mjs"] } } }
//
// Rules of the house:
//   - stdout is the PROTOCOL channel. All logs (and vite child output) go to
//     stderr — see server/mcp-renderer.mjs.
//   - stdin end / SIGINT / SIGTERM trigger renderer shutdown (browser + vite
//     child process) before exiting.

import readline from "node:readline";
import {
  createProtocolState,
  handleMessage,
  parseErrorResponse,
} from "./protocol.mjs";
import { MCP_TOOLS, createToolContext, callTool } from "./tools.mjs";
import {
  renderSpritesheet,
  shutdownRenderer,
} from "../mcp-renderer.mjs";

const SERVER_INFO = {
  name: "lpc-spritesheet",
  title: "LPC Spritesheet Character Generator",
  version: "0.1.0",
};

const state = createProtocolState({
  serverInfo: SERVER_INFO,
  tools: MCP_TOOLS,
  callTool: (name, args) => callTool(name, args, createToolContext({ renderer: { render: renderSpritesheet } })),
});

function writeResponse(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(...args) {
  console.error("[mcp]", ...args);
}

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutting down …");
  try {
    await shutdownRenderer();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    writeResponse(parseErrorResponse());
    return;
  }

  Promise.resolve(handleMessage(state, msg))
    .then((response) => {
      if (response !== null) writeResponse(response);
    })
    .catch((e) => {
      // handleMessage is written not to throw, but never let a bug kill the
      // server silently — emit a JSON-RPC internal error for the request id
      // if we can find one.
      log("handler crash:", e instanceof Error ? e.stack : String(e));
      const id = Array.isArray(msg)
        ? (msg.find((m) => m && typeof m.id !== "undefined")?.id ?? null)
        : (msg?.id ?? null);
      writeResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Internal error" },
      });
    });
});

// MCP clients signal shutdown by closing stdin.
rl.on("close", () => {
  void shutdown(0);
});

process.on("SIGINT", () => {
  void shutdown(130);
});
process.on("SIGTERM", () => {
  void shutdown(143);
});
process.on("exit", () => {
  // Synchronous best-effort: kill vite / browser without awaiting.
  shutdownRenderer();
});

log(`MCP server "${SERVER_INFO.name}" listening on stdio (${MCP_TOOLS.length} tools)`);
