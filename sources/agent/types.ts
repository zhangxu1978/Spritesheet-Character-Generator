// Agent layer — shared types between tools, session, client, and server.
//
// Design goals:
//   - Tools are pure functions of (ctx, args) returning `Result<unknown, ToolError>`.
//   - JSON Schema is exported alongside handlers so the LLM (or any caller)
//     gets a stable, OpenAI-compatible `tools` array.
//   - Schemas stay valid JSON Schema draft 2020-12 (no TS-only constructs).
//
// The session/ctx is created by session.ts and consumed by tools.ts; the
// HTTP API (server/) reuses the same exports, so there is exactly one
// definition of what "a tool call" is.

import type { Result } from "neverthrow";
import type { Selections } from "../state/state.ts";

export type ToolErrorKind =
  | "loading" // catalog metadata still loading
  | "not-found" // referenced id missing
  | "invalid-args" // schema violation / domain precondition
  | "internal" // unexpected runtime error
  | "canvas-not-initialized" // offscreen canvas missing (browser-only)
  | "unsupported"; // e.g. node-only call hit a DOM-only branch

export interface ToolError {
  kind: ToolErrorKind;
  message: string;
  details?: unknown;
}

/** OpenAI-compatible JSON Schema for a tool's parameters object. */
export interface ToolSchema {
  name: string;
  description: string;
  /** Top-level object schema with `type: "object"`. */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/** Result of running a single tool call. */
export type ToolResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError };

/** Minimal session surface that tools need. Defined here so `tools.ts` does
 *  not import the session module (which would create a cycle). */
export interface ToolSession {
  /** Read-only snapshot of the current selections. */
  getSelections(): Selections;
  /** Read-only snapshot of the current body type. */
  getBodyType(): string;
  /** Read-only snapshot of the current preview animation. */
  getAnimation(): string;
  /** Replace the whole selections object. Returns merged new state. */
  setSelections(next: Selections): void;
  setBodyType(bodyType: string): void;
  setAnimation(animation: string): void;
  /** Reset the session to factory defaults (calls selectDefaults semantics). */
  reset(): Promise<void>;
  /** Render the current session to its offscreen canvas. */
  render(): Promise<void>;
  /** Get the offscreen canvas (browser-side only). */
  getCanvas(): HTMLCanvasElement | null;
  /** Get a canvas with only the requested animations (empty → full sheet). */
  getCanvasForAnimations(animations?: string[]): HTMLCanvasElement | null;
  /** Encode full canvas as base64 PNG. Browser-side only. */
  toBase64Png(): Promise<Result<string, { kind: "canvas-not-initialized" }>>;
  /** Encode a subset of animations as a compact base64 PNG. */
  toBase64PngSelected(
    animations?: string[],
  ): Promise<
    Result<
      { base64: string; width: number; height: number; includedAnimations: string[] },
      { kind: "canvas-not-initialized" }
    >
  >;
}

/** Per-call context passed to every tool handler. */
export interface ToolContext {
  session: ToolSession;
}

/** Handler signature shared by every tool. */
export type ToolHandler<Args> = (
  ctx: ToolContext,
  args: Args,
) => Promise<ToolResult<unknown>>;

/** A registered tool: JSON Schema + handler. */
export interface RegisteredTool<Args = unknown> {
  name: string;
  schema: ToolSchema;
  handler: ToolHandler<Args>;
}

/** Wire format used by `/api/agent/chat` (SSE) and by the in-browser client. */
export interface ChatToolCall {
  /** Tool name as registered in `tools.ts`. */
  name: string;
  /** Parsed arguments object (already JSON.parsed on the server). */
  arguments: Record<string, unknown>;
  /** Optional id echoed back from the model so callers can correlate. */
  id?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  /** When `role === "assistant"`, the LLM may request tool calls. */
  tool_calls?: ChatToolCall[];
  /** When `role === "tool"`, the originating tool call id. */
  tool_call_id?: string;
  /** Tool name when `role === "tool"` (helps the model match results). */
  name?: string;
}

/** Final response from `/api/agent/chat`. */
export interface ChatFinalResponse {
  /** Tool call that produced the final spritesheet, if any. */
  finalImageBase64?: string;
  /** All tool calls executed in order (for UI to render). */
  toolCalls: Array<{
    call: ChatToolCall;
    result: ToolResult;
  }>;
  /** Free-form assistant text (if any). */
  assistantText?: string;
  /** Echo stub fallback was used. */
  fallback?: "echo";
  /** Provider actually invoked (e.g. "minimax", "echo"). */
  provider?: string;
}