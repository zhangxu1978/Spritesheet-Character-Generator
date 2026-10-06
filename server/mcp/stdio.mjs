// mcp/stdio.mjs — MCP stdio transport entry point.
//
// Registers as an MCP server in any local MCP client (Trae / Claude Desktop /
// Cursor / Cline / …):
//
//   { "mcpServers": { "lpc-spritesheet": {
//       "command": "node",
//       "args": ["<repo>/server/mcp/stdio.mjs"] } } }
//
// Protocol: newline-delimited JSON-RPC 2.0 (see protocol.mjs). All logging
// goes to stderr — stdout is reserved for protocol messages only.

import { createInterface } from "node:readline";
import { createMcpState, handleMessage, parseLine } from "./protocol.mjs";
import { MCP_TOOLS, callTool } from "./tools.mjs";

function log(...args) {
  console.error("[mcp]", ...args);
}

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let shuttingDown = false;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const { shutdownRenderer } = await import("../mcp-renderer.mjs");
    await shutdownRenderer();
  } catch {
    // best-effort cleanup
  }
  process.exit(code);
}

async function main() {
  const state = createMcpState({ tools: MCP_TOOLS, callTool });

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    void (async () => {
      const parsed = parseLine(line);
      if (!parsed) return; // blank line
      if (parsed.error) {
        writeMessage(parsed.error);
        return;
      }
      try {
        const resp = await handleMessage(state, parsed.message);
        if (resp !== null) writeMessage(resp);
      } catch (e) {
        // handleMessage is designed not to throw; defensive only.
        log("handler error:", e instanceof Error ? e.stack : String(e));
      }
    })();
  });
  rl.on("close", () => void shutdown(0));

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  log(
    `MCP server ready: ${MCP_TOOLS.length} tools (${MCP_TOOLS.map((t) => t.name).join(", ")})`,
  );
}

main().catch((e) => {
  log("fatal:", e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
