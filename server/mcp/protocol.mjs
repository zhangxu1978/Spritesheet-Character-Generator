// mcp/protocol.mjs — pure MCP (Model Context Protocol) protocol layer.
//
// Implements the tools-server subset of the MCP spec as newline-delimited
// JSON-RPC 2.0 over stdio. Deliberately hand-rolled (no SDK) to keep the
// server dependency-free, matching the rest of server/ (agent-handler.mjs,
// minimax-client.mjs).
//
// Supported methods:
//   initialize                    → negotiate version, advertise tools
//   notifications/initialized     → (notification) mark handshake complete
//   ping                          → {}
//   tools/list                    → { tools: ToolDef[] }
//   tools/call {name, arguments}  → { content, structuredContent?, isError? }
//
// Everything else:
//   - unknown request with id  → JSON-RPC error -32601
//   - unknown notification     → ignored (null, no response)
//   - request before initialize → JSON-RPC error -32002 (except ping)
//
// Pure functions only — no I/O here, so tests can drive handleMessage
// directly. stdio.mjs owns the transport.

export const SERVER_INFO = Object.freeze({
  name: "lpc-spritesheet-generator",
  title: "LPC Spritesheet Character Generator",
  version: "1.0.0",
});

/** Spec version we advertise when the client doesn't request one. */
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

// JSON-RPC / MCP error codes.
const PARSE_ERROR = -32768;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const SERVER_NOT_INITIALIZED = -32002;

/**
 * Build the per-connection state. `tools` is the ToolDef array served by
 * tools/list; `callTool(name, args)` executes a tool and must return an MCP
 * result object ({content, structuredContent?, isError?}) or throw.
 *
 * @param {{
 *   tools: Array<{name: string, description: string, inputSchema: object}>,
 *   callTool: (name: string, args: object) => Promise<object>|object,
 * }} opts
 */
export function createMcpState(opts) {
  return {
    tools: opts.tools ?? [],
    callTool: opts.callTool,
    initialized: false,
    clientInfo: null,
  };
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/**
 * Handle one decoded JSON-RPC message (or an array of them, tolerated for
 * pre-2025-06-18 clients that batch). Returns the response object, an array
 * of responses, or null when there is nothing to send (notifications,
 * malformed notifications).
 *
 * @param {object} state - from createMcpState (mutated: initialized/clientInfo)
 * @param {unknown} msg - decoded message
 * @returns {Promise<object|object[]|null>}
 */
export async function handleMessage(state, msg) {
  if (Array.isArray(msg)) {
    const responses = [];
    for (const entry of msg) {
      const r = await handleMessage(state, entry);
      if (r !== null) responses.push(r);
    }
    return responses.length > 0 ? responses : null;
  }
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return errorResponse(null, INVALID_REQUEST, "Invalid Request");
  }
  if (typeof msg.method !== "string") {
    return errorResponse(
      msg.id ?? null,
      INVALID_REQUEST,
      "Invalid Request: missing method",
    );
  }

  const isNotification = !("id" in msg) || msg.id === undefined;
  const id = isNotification ? null : msg.id;

  switch (msg.method) {
    case "initialize":
      return handleInitialize(state, id, msg.params);
    case "notifications/initialized":
      state.initialized = true;
      return null;
    case "ping":
      return isNotification ? null : response(id, {});
    case "tools/list":
      return requireInitialized(state, id, () => response(id, { tools: state.tools }));
    case "tools/call":
      return requireInitialized(state, id, () =>
        handleToolCall(state, id, msg.params),
      );
    default:
      if (isNotification) return null;
      return errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

/**
 * Parse one raw stdin line. Returns {message} on success, {error} when the
 * line is not valid JSON (caller should reply with the parse error), or null
 * for blank lines.
 *
 * @param {string} line
 * @returns {{message?: unknown, error?: object}|null}
 */
export function parseLine(line) {
  const text = (line ?? "").trim();
  if (!text) return null;
  try {
    return { message: JSON.parse(text) };
  } catch (e) {
    return {
      error: errorResponse(
        null,
        PARSE_ERROR,
        `Parse error: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  }
}

function handleInitialize(state, id, params) {
  const p = (params && typeof params === "object") ? params : {};
  // Echo the client's requested version back — every spec revision we care
  // about shares the tools subset implemented here. Fall back to our default
  // when the client omits it.
  const protocolVersion =
    typeof p.protocolVersion === "string" && p.protocolVersion
      ? p.protocolVersion
      : DEFAULT_PROTOCOL_VERSION;
  if (p.clientInfo && typeof p.clientInfo === "object") {
    state.clientInfo = p.clientInfo;
  }
  return response(id, {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: SERVER_INFO,
  });
}

function requireInitialized(state, id, produce) {
  if (!state.initialized) {
    return errorResponse(
      id,
      SERVER_NOT_INITIALIZED,
      "Server not initialized: send initialize first",
    );
  }
  return produce();
}

async function handleToolCall(state, id, params) {
  const p = (params && typeof params === "object") ? params : {};
  const name = p.name;
  if (typeof name !== "string" || !name) {
    return errorResponse(id, INVALID_PARAMS, "Invalid params: tools/call requires a tool name");
  }
  const known = state.tools.some((t) => t.name === name);
  if (!known) {
    return errorResponse(id, INVALID_PARAMS, `Unknown tool: ${name}`);
  }
  const args = (p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments))
    ? p.arguments
    : {};
  try {
    const result = await state.callTool(name, args);
    return response(id, result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return response(id, {
      content: [{ type: "text", text: `Tool execution failed: ${message}` }],
      isError: true,
    });
  }
}
