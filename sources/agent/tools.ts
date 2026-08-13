// Agent tools — pure functions that operate on a `ToolSession`.
//
// Each tool:
//   - Has a JSON Schema (OpenAI-compatible) describing its `arguments`.
//   - Has a handler `(ctx, args) => Promise<ToolResult>`.
//   - Is registered in `TOOLS` so callers (browser UI, server API) can iterate.
//
// What this layer does NOT do:
//   - It does not call the global `state` directly; the session isolates it.
//   - It does not render to a global canvas; it renders through the session.
//   - It does not decide which tool to call; that's the LLM's job (or the
//     echo stub on the server).

import { ok, err } from "neverthrow";
import {
  BODY_TYPE_LIST,
  ANIMATION_LIST,
  ALLOWED_BODY_TYPES,
  ALLOWED_ANIMATIONS,
  isSelection,
} from "./session.ts";
import { defaultCatalog } from "../state/catalog.ts";
import type {
  RegisteredTool,
  ToolContext,
  ToolError,
  ToolResult,
  ToolSchema,
} from "./types.ts";
import type { Selection, Selections } from "../state/state.ts";
import type {
  CategoryTree,
  LoadError,
  SlimByTypeNameRow,
} from "../state/catalog.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────

function toolError(
  kind: ToolError["kind"],
  message: string,
  details?: unknown,
): ToolResult<never> {
  const err: ToolError = { kind, message };
  if (details !== undefined) err.details = details;
  return { ok: false, error: err };
}

function okData<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

function mapLoadError(e: LoadError): ToolError {
  if (e.kind === "loading") {
    return {
      kind: "loading",
      message: `catalog chunk "${e.chunk}" is still loading`,
    };
  }
  return { kind: "not-found", message: `item ${e.id} not in catalog` };
}

// ─── Tool: list_categories ───────────────────────────────────────────────

const listCategoriesSchema: ToolSchema = {
  name: "list_categories",
  description:
    "列出全部可装备的部件分类（如 body / head / torso / legs / feet / hair / …）。返回树形结构，每层包含 items 数组或 children 对象。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

async function listCategories(
  _ctx: ToolContext,
  _args: Record<string, never>,
): Promise<ToolResult> {
  const res = defaultCatalog.getCategoryTree();
  if (res.isErr()) return toolError(mapLoadError(res.error).kind, mapLoadError(res.error).message);
  return okData<CategoryTree>(res.value);
}

// ─── Tool: list_items ────────────────────────────────────────────────────

interface ListItemsArgs {
  typeName?: string;
  category?: string;
  /** If true, include variant / recolor names in the response. */
  detailed?: boolean;
}

const listItemsSchema: ToolSchema = {
  name: "list_items",
  description:
    "按 typeName 或 category 列出可装备的物品。typeName 是部件类别（如 body, head, hair, torso, legs, feet, weapon），category 是树形分类路径。返回轻量记录数组（含 itemId / name / variants / recolors）。",
  parameters: {
    type: "object",
    properties: {
      typeName: {
        type: "string",
        description: "部件 typeName，例如 body / head / hair / torso / legs / feet",
      },
      category: {
        type: "string",
        description: "可选的 category 路径（按 category tree 节点的 key 过滤）",
      },
      detailed: { type: "boolean", description: "是否在结果里附带 variants/recolors" },
    },
    additionalProperties: false,
  },
};

async function listItems(
  _ctx: ToolContext,
  args: ListItemsArgs,
): Promise<ToolResult> {
  const idxRes = defaultCatalog.getMetadataIndexes();
  if (idxRes.isErr()) return toolError(mapLoadError(idxRes.error).kind, mapLoadError(idxRes.error).message);
  const idx = idxRes.value;
  const byTypeName: Record<string, SlimByTypeNameRow[]> =
    idx.hashMatch?.itemsByTypeName ?? idx.byTypeName ?? {};

  let rows: SlimByTypeNameRow[] = [];
  if (args.typeName) {
    rows = byTypeName[args.typeName] ?? [];
  } else {
    for (const arr of Object.values(byTypeName)) rows = rows.concat(arr);
  }
  if (args.category) {
    rows = rows.filter((r) => r.name.toLowerCase().includes(args.category!.toLowerCase()));
  }

  if (!args.detailed) {
    return okData(
      rows.map((r) => ({
        itemId: r.itemId,
        name: r.name,
        type_name: r.type_name,
        variants: r.variants,
      })),
    );
  }

  // Detailed: enrich each row with item metadata if available.
  const detailed2 = rows.map((r) => {
    const lite = defaultCatalog.getItemLite(r.itemId).unwrapOr(null);
    return {
      itemId: r.itemId,
      name: r.name,
      type_name: r.type_name,
      variants: lite?.variants ?? r.variants,
      recolors: (lite?.recolors ?? []).map((c, idx) => ({
        index: idx,
        type_name: c.type_name,
        label: c.label,
        variants: c.variants,
      })),
      required: lite?.required ?? [],
      animations: lite?.animations ?? [],
    };
  });
  return okData(detailed2);
}

// ─── Tool: get_item ──────────────────────────────────────────────────────

interface GetItemArgs {
  itemId: string;
}

const getItemSchema: ToolSchema = {
  name: "get_item",
  description:
    "获取单个物品的完整元数据，包括 name、type_name、required body types、可执行 animations、所有 variants、所有 recolors。",
  parameters: {
    type: "object",
    properties: { itemId: { type: "string", description: "物品 itemId（list_items 给出）" } },
    required: ["itemId"],
    additionalProperties: false,
  },
};

async function getItem(
  _ctx: ToolContext,
  args: GetItemArgs,
): Promise<ToolResult> {
  const lite = defaultCatalog.getItemLite(args.itemId);
  if (lite.isErr()) return toolError(mapLoadError(lite.error).kind, mapLoadError(lite.error).message);
  return okData(lite.value);
}

// ─── Tool: list_body_types / list_animations ─────────────────────────────

const listBodyTypesSchema: ToolSchema = {
  name: "list_body_types",
  description: "列出可选的身体类型（male/female/teen/child/muscular/pregnant）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
async function listBodyTypes(): Promise<ToolResult> {
  return okData(BODY_TYPE_LIST);
}

const listAnimationsSchema: ToolSchema = {
  name: "list_animations",
  description:
    "列出可在预览中切换的动作（spellcast / thrust / walk / slash / shoot / hurt / climb / idle / jump / sit / emote / run / combat / 1h_backslash / 1h_halfslash）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
async function listAnimations(): Promise<ToolResult> {
  return okData(ANIMATION_LIST);
}

// ─── Tool: get_state ─────────────────────────────────────────────────────

const getStateSchema: ToolSchema = {
  name: "get_state",
  description:
    "获取当前 session 的完整状态：selections / bodyType / animation。返回的 JSON 可以原样回传给 set_state 用于恢复。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
async function getState(ctx: ToolContext): Promise<ToolResult> {
  return okData({
    selections: ctx.session.getSelections(),
    bodyType: ctx.session.getBodyType(),
    animation: ctx.session.getAnimation(),
  });
}

// ─── Tool: set_body_type ─────────────────────────────────────────────────

interface SetBodyTypeArgs {
  bodyType: string;
}

const setBodyTypeSchema: ToolSchema = {
  name: "set_body_type",
  description: "切换身体类型。",
  parameters: {
    type: "object",
    properties: { bodyType: { type: "string", enum: BODY_TYPE_LIST } },
    required: ["bodyType"],
    additionalProperties: false,
  },
};

async function setBodyType(
  ctx: ToolContext,
  args: SetBodyTypeArgs,
): Promise<ToolResult> {
  if (!ALLOWED_BODY_TYPES.has(args.bodyType)) {
    return toolError("invalid-args", `unsupported bodyType: ${args.bodyType}`);
  }
  ctx.session.setBodyType(args.bodyType);
  await ctx.session.render();
  return okData({ bodyType: ctx.session.getBodyType() });
}

// ─── Tool: set_selection ─────────────────────────────────────────────────

interface SetSelectionArgs {
  /** typeName of the slot (e.g. body, head, hair). Replaces whatever's selected there. */
  typeName?: string;
  /** Or, the exact itemId of the slot to replace. */
  itemId?: string;
  selection: Selection;
}

const setSelectionSchema: ToolSchema = {
  name: "set_selection",
  description:
    "为指定 typeName（或 itemId 所在 typeName）写入一个 Selection。selection 必须包含 itemId / name 以及 variant / recolor 二者之一。",
  parameters: {
    type: "object",
    properties: {
      typeName: {
        type: "string",
        description: "目标 typeName；与 itemId 至少给一个",
      },
      itemId: { type: "string", description: "目标 itemId；与 typeName 至少给一个" },
      selection: {
        type: "object",
        description: "完整的 Selection 对象",
        properties: {
          itemId: { type: "string" },
          name: { type: "string" },
          variant: { type: "string", nullable: true },
          recolor: { type: "string", nullable: true },
          subId: { type: "integer", nullable: true },
        },
        required: ["itemId", "name"],
      },
    },
    required: ["selection"],
    additionalProperties: false,
  },
};

async function setSelection(
  ctx: ToolContext,
  args: SetSelectionArgs,
): Promise<ToolResult> {
  if (!isSelection(args.selection)) {
    return toolError("invalid-args", "selection must include string itemId and name");
  }
  // Validate the item exists in the catalog before storing it.
  const lite = defaultCatalog.getItemLite(args.selection.itemId);
  if (lite.isErr()) return toolError(mapLoadError(lite.error).kind, mapLoadError(lite.error).message);

  // Determine the selection group: prefer explicit typeName, else use the
  // item's own type_name, else fall back to the itemId (one-off group).
  const group =
    args.typeName ??
    lite.value.type_name ??
    args.itemId ??
    args.selection.itemId;

  const next: Selections = ctx.session.getSelections();
  next[group] = {
    ...args.selection,
    subId: args.selection.subId ?? null,
    variant: args.selection.variant ?? null,
    recolor: args.selection.recolor ?? null,
  };
  ctx.session.setSelections(next);
  await ctx.session.render();
  return okData({ typeName: group, selection: next[group] });
}

// ─── Tool: clear_selection ───────────────────────────────────────────────

interface ClearSelectionArgs {
  typeName?: string;
  itemId?: string;
}

const clearSelectionSchema: ToolSchema = {
  name: "clear_selection",
  description: "移除某个 typeName（或 itemId 所在 typeName）的当前选择。",
  parameters: {
    type: "object",
    properties: {
      typeName: { type: "string" },
      itemId: { type: "string" },
    },
    additionalProperties: false,
  },
};

async function clearSelection(
  ctx: ToolContext,
  args: ClearSelectionArgs,
): Promise<ToolResult> {
  let group = args.typeName;
  if (!group && args.itemId) {
    const lite = defaultCatalog.getItemLite(args.itemId);
    if (lite.isErr()) return toolError(mapLoadError(lite.error).kind, mapLoadError(lite.error).message);
    group = lite.value.type_name ?? args.itemId;
  }
  if (!group) {
    return toolError("invalid-args", "must provide typeName or itemId");
  }
  const next = ctx.session.getSelections();
  const existed = group in next;
  delete next[group];
  ctx.session.setSelections(next);
  await ctx.session.render();
  return okData({ typeName: group, cleared: existed });
}

// ─── Tool: set_animation ─────────────────────────────────────────────────

interface SetAnimationArgs {
  animation: string;
}

const setAnimationSchema: ToolSchema = {
  name: "set_animation",
  description: "切换预览动作。",
  parameters: {
    type: "object",
    properties: { animation: { type: "string", enum: ANIMATION_LIST.map((a) => a.value) } },
    required: ["animation"],
    additionalProperties: false,
  },
};

async function setAnimation(
  ctx: ToolContext,
  args: SetAnimationArgs,
): Promise<ToolResult> {
  if (!ALLOWED_ANIMATIONS.has(args.animation)) {
    return toolError("invalid-args", `unsupported animation: ${args.animation}`);
  }
  ctx.session.setAnimation(args.animation);
  return okData({ animation: ctx.session.getAnimation() });
}

// ─── Tool: render_spritesheet ────────────────────────────────────────────

interface RenderSpritesheetArgs {
  /** Optional animation to render alongside (does not affect PNG, only logs). */
  animation?: string;
  /** If true, return the PNG as base64; otherwise only return metadata. */
  includeImage?: boolean;
}

const renderSpritesheetSchema: ToolSchema = {
  name: "render_spritesheet",
  description:
    "把当前 session 渲染到 offscreen canvas，返回 PNG（base64）。在调用任何会改动作的 set_animation 之后想看效果时调一次即可，PNG 本身和动画选择无关——动画只决定预览时显示哪一行。",
  parameters: {
    type: "object",
    properties: {
      animation: {
        type: "string",
        description: "可选：仅更新 session 的 preview animation",
      },
      includeImage: {
        type: "boolean",
        description: "默认 true。false 时仅返回元数据（width/height/sizeBytes）",
      },
    },
    additionalProperties: false,
  },
};

async function renderSpritesheet(
  ctx: ToolContext,
  args: RenderSpritesheetArgs,
): Promise<ToolResult> {
  if (args.animation) {
    if (!ALLOWED_ANIMATIONS.has(args.animation)) {
      return toolError("invalid-args", `unsupported animation: ${args.animation}`);
    }
    ctx.session.setAnimation(args.animation);
  }
  await ctx.session.render();
  const includeImage = args.includeImage !== false;
  if (!includeImage) {
    const canvas = ctx.session.getCanvas();
    return okData({
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      selections: ctx.session.getSelections(),
      bodyType: ctx.session.getBodyType(),
      animation: ctx.session.getAnimation(),
    });
  }
  const png = await ctx.session.toBase64Png();
  if (png.isErr()) {
    return toolError(
      png.error.kind === "canvas-not-initialized" ? "canvas-not-initialized" : "internal",
      png.error.kind,
    );
  }
  return okData({
    mimeType: "image/png",
    width: ctx.session.getCanvas()?.width ?? 0,
    height: ctx.session.getCanvas()?.height ?? 0,
    base64: png.value,
    selections: ctx.session.getSelections(),
    bodyType: ctx.session.getBodyType(),
    animation: ctx.session.getAnimation(),
  });
}

// ─── Tool: reset_to_defaults ─────────────────────────────────────────────

const resetToDefaultsSchema: ToolSchema = {
  name: "reset_to_defaults",
  description: "把 session 重置到默认角色（male 身体 + 浅色身体 + 浅色人脸）。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};
async function resetToDefaults(ctx: ToolContext): Promise<ToolResult> {
  await ctx.session.reset();
  return okData({
    selections: ctx.session.getSelections(),
    bodyType: ctx.session.getBodyType(),
    animation: ctx.session.getAnimation(),
  });
}

// ─── Registration ────────────────────────────────────────────────────────

export const TOOLS: RegisteredTool[] = [
  { name: listCategoriesSchema.name, schema: listCategoriesSchema, handler: listCategories },
  { name: listItemsSchema.name, schema: listItemsSchema, handler: listItems as RegisteredTool["handler"] },
  { name: getItemSchema.name, schema: getItemSchema, handler: getItem },
  { name: listBodyTypesSchema.name, schema: listBodyTypesSchema, handler: listBodyTypes },
  { name: listAnimationsSchema.name, schema: listAnimationsSchema, handler: listAnimations },
  { name: getStateSchema.name, schema: getStateSchema, handler: getState },
  { name: setBodyTypeSchema.name, schema: setBodyTypeSchema, handler: setBodyType },
  { name: setSelectionSchema.name, schema: setSelectionSchema, handler: setSelection as RegisteredTool["handler"] },
  { name: clearSelectionSchema.name, schema: clearSelectionSchema, handler: clearSelection },
  { name: setAnimationSchema.name, schema: setAnimationSchema, handler: setAnimation },
  { name: renderSpritesheetSchema.name, schema: renderSpritesheetSchema, handler: renderSpritesheet },
  { name: resetToDefaultsSchema.name, schema: resetToDefaultsSchema, handler: resetToDefaults },
];

export function getToolSchemas(): ToolSchema[] {
  return TOOLS.map((t) => t.schema);
}

export function findTool(name: string): RegisteredTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

export async function runTool(
  ctx: ToolContext,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) return toolError("invalid-args", `unknown tool: ${name}`);
  try {
    return await tool.handler(ctx, (args ?? {}) as never);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return toolError("internal", message);
  }
}

// Re-export session helpers so server/ can stay framework-agnostic.
export { createOrGetSession, getSession, dropSession, listSessionIds } from "./session.ts";
export { AgentSession } from "./session.ts";