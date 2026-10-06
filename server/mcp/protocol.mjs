// protocol.mjs — pure MCP (Model Context Protocol) protocol layer over
// JSON-RPC 2.0. No I/O here: `handleMessage` takes a parsed message (or
// batch array) and returns a response object, `null` (for notifications /
// empty batches), or a Promise thereof (tools/call is async).
//
// Supported methods:
//   initialize              → capabilities + serverInfo (echo client protocolVersion)
//   notifications/initialized → null (client → server notification)
//   ping                    → {}
//   tools/list              → { tools: ToolDef[] }
//   tools/call              → { content, structuredContent?, isError? }
//
// Error conventions (JSON-RPC 2.0):
//   -32700 Parse error     (caller's job when JSON.parse fails)
//   -32600 Invalid Request (parsed but not an object / bad shape)
//   -32601 Method not found
//   -32603 Internal error  (tool handler threw → surfaced as isError result
//                           per MCP spec instead, unless the failure is in
//                           the protocol layer itself)
//
// Designed for `node --test` coverage: pure in → pure out.

export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** JSON-RPC error codes used by this server. */
export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

/**
 * Create the mutable protocol state (initialized flag etc.).
 *
 * @param {{ serverInfo: { name: string, version: string },
 *           tools: object[],
 *           callTool: (name: string, args: object) => Promise<object> }} opts
 */
export function createProtocolState(opts) {
  return {
    serverInfo: opts.serverInfo,
    tools: opts.tools,
    callTool: opts.callTool,
    initialized: false,
  };
}

function makeResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function makeError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/**
 * Handle one parsed JSON-RPC message (or a batch array).
 * Returns a response object, `null` (nothing to send), or a Promise.
 */
export async function handleMessage(state, msg) {
  // Batch: array of messages → array of non-null responses (or null if empty).
  if (Array.isArray(msg)) {
    const responses = [];
    for (const entry of msg) {
      const res = await handleMessage(state, entry);
      if (res !== null) responses.push(res);
    }
    return responses.length > 0 ? responses : null;
  }

  // Parsed but not a valid request shape.
  if (msg === null || typeof msg !== "object" || typeof msg.method !== "string") {
    return makeError(
      msg && typeof msg.id !== "undefined" ? msg.id : null,
      ErrorCodes.INVALID_REQUEST,
      "Invalid Request: expected {jsonrpc:'2.0', id, method}",
    );
  }

  const hasId = typeof msg.id !== "undefined";
  const method = msg.method;

  // Notifications never produce a response.
  if (!hasId) {
    if (method === "notifications/initialized") {
      state.initialized = true;
    }
    return null;
  }

  switch (method) {
    case "initialize":
      return makeResponse(msg.id, {
        // Echo the client's requested version when provided (max compat);
        // otherwise advertise our default.
        protocolVersion:
          typeof msg.params?.protocolVersion === "string"
            ? msg.params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: state.serverInfo,
      });

    case "ping":
      return makeResponse(msg.id, {});

    case "tools/list":
      return makeResponse(msg.id, { tools: state.tools });

    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (typeof name !== "string") {
        return makeError(
          msg.id,
          ErrorCodes.INVALID_PARAMS,
          "tools/call requires params.name (string)",
        );
      }
      const tool = state.tools.find((t) => t.name === name);
      if (!tool) {
        return makeError(msg.id, ErrorCodes.METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      }
      try {
        const result = await state.callTool(name, args);
        // Tool handlers return an MCP CallToolResult-shaped object already.
        return makeResponse(msg.id, result);
      } catch (e) {
        // Per MCP spec, tool execution failures are results with isError,
        // but unexpected crashes in the dispatch layer are internal errors.
        const message = e instanceof Error ? e.message : String(e);
        return makeError(msg.id, ErrorCodes.INTERNAL_ERROR, message);
      }
    }

    default:
      return makeError(
        msg.id,
        ErrorCodes.METHOD_NOT_FOUND,
        `Method not found: ${method}`,
      );
  }
}

/**
 * Build a JSON-RPC error response for a message that could not be parsed at
 * all (JSON.parse threw). Per spec the id must be null.
 */
export function parseErrorResponse() {
  return makeError(null, ErrorCodes.PARSE_ERROR, "Parse error");
}

/**
 * Normalize a thrown error inside a tool handler into an MCP error-result
 * (isError: true). Used by the tools layer.
 */
export function toolErrorResult(message) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
