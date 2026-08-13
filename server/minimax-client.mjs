// minimax-client.mjs — thin wrapper around the MiniMax /v1/chat/completions
// endpoint. MiniMax exposes an OpenAI-compatible surface, so the request body
// shape is identical to OpenAI's: { model, temperature, messages, tools }.
//
// We deliberately do NOT depend on the `openai` SDK — a 30-line fetch call
// keeps the install footprint at zero (no npm dependency) and is easy to
// mock from tests.
//
// Streaming is intentionally not implemented in v1; the tool-call loop runs
// to completion in one request when the model emits them all at once. For
// longer multi-step interactions we fall back to repeated non-streaming
// requests until the assistant stops emitting tool_calls.

import { loadConfig } from "./llm-config.mjs";

/**
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {object} parameters   JSON Schema for arguments.
 */

/**
 * @typedef {Object} ChatRequest
 * @property {Array} messages
 * @property {ToolDef[]} [tools]
 * @property {string}   [model]
 * @property {number}   [temperature]
 */

/**
 * @typedef {Object} ChatResponse
 * @property {string|null} text
 * @property {Array} toolCalls   [{ id, name, arguments }]
 * @property {string} finishReason
 */

/**
 * Send a chat completion request to MiniMax.
 *
 * Throws on network / parse / HTTP errors so the caller can fall back to
 * echo mode.
 *
 * @param {ChatRequest} req
 * @returns {Promise<ChatResponse>}
 */
export async function chatCompletion(req) {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error("minimax not configured");
  }
  const body = {
    model: req.model ?? cfg.model,
    temperature: req.temperature ?? cfg.temperature,
    messages: req.messages,
    tool_choice: "auto",
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(toOpenAITool);
  }

  const url = `${cfg.baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`minimax HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  const json = await resp.json();
  return parseChatResponse(json);
}

function toOpenAITool(schema) {
  return {
    type: "function",
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters,
    },
  };
}

function parseChatResponse(json) {
  const choice = json?.choices?.[0];
  const message = choice?.message ?? {};
  const text = typeof message.content === "string" ? message.content : null;
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls = rawCalls
    .map((tc) => {
      let args = {};
      try {
        args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      return {
        id: tc.id,
        name: tc.function?.name,
        arguments: args,
      };
    })
    .filter((tc) => typeof tc.name === "string");
  return {
    text,
    toolCalls,
    finishReason: choice?.finish_reason ?? "unknown",
  };
}