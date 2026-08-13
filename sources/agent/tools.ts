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
  /**
   * Optional subset of animations to include in the exported PNG.
   * Empty / omitted → full sheet. Useful to keep NPC spritesheets small
   * (e.g. ["idle", "walk"] for a villager, ["idle"] for a stationary NPC).
   */
  animations?: string[];
}

const renderSpritesheetSchema: ToolSchema = {
  name: "render_spritesheet",
  description:
    "把当前 session 渲染到 offscreen canvas 并返回 PNG（base64）。" +
    "默认导出完整精灵表（全部动作，高 3456px）。" +
    "如果是 NPC / 小怪，建议传 animations 数组只打包需要的动作（例如 villagers 只要 [\"idle\",\"walk\"]，固定摆件只要 [\"idle\"]），这样 PNG 会小很多。",
  parameters: {
    type: "object",
    properties: {
      animation: {
        type: "string",
        description: "可选：仅更新 session 的 preview animation（不影响导出）",
      },
      includeImage: {
        type: "boolean",
        description: "默认 true。false 时仅返回元数据（width/height）",
      },
      animations: {
        type: "array",
        items: { type: "string" },
        description:
          "可选：要打包进 PNG 的动作列表（如 [\"idle\",\"walk\"]）。" +
          "传空数组或不传则导出全部动作（完整大表）。",
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
  const wantAnims = Array.isArray(args.animations) ? args.animations : undefined;

  if (!includeImage) {
    const canvas = ctx.session.getCanvas();
    // Compute what the size *would* be if we exported the selection.
    const metaCanvas = ctx.session.getCanvasForAnimations(wantAnims);
    return okData({
      width: metaCanvas?.width ?? canvas?.width ?? 0,
      height: metaCanvas?.height ?? canvas?.height ?? 0,
      fullWidth: canvas?.width ?? 0,
      fullHeight: canvas?.height ?? 0,
      selections: ctx.session.getSelections(),
      bodyType: ctx.session.getBodyType(),
      animation: ctx.session.getAnimation(),
      requestedAnimations: wantAnims,
    });
  }

  // Use selective export when a list was provided.
  const png = wantAnims
    ? await ctx.session.toBase64PngSelected(wantAnims)
    : await ctx.session.toBase64Png().then((r) =>
        r.map((base64) => ({
          base64,
          width: ctx.session.getCanvas()?.width ?? 0,
          height: ctx.session.getCanvas()?.height ?? 0,
          includedAnimations: [] as string[],
        })),
      );

  if (png.isErr()) {
    return toolError(
      png.error.kind === "canvas-not-initialized" ? "canvas-not-initialized" : "internal",
      png.error.kind,
    );
  }
  return okData({
    mimeType: "image/png",
    width: png.value.width,
    height: png.value.height,
    base64: png.value.base64,
    fullWidth: ctx.session.getCanvas()?.width ?? 0,
    fullHeight: ctx.session.getCanvas()?.height ?? 0,
    selections: ctx.session.getSelections(),
    bodyType: ctx.session.getBodyType(),
    animation: ctx.session.getAnimation(),
    includedAnimations: png.value.includedAnimations,
    selective: !!(wantAnims && wantAnims.length > 0),
  });
}

// ─── Tool: suggest_animation_preset ──────────────────────────────────────

interface SuggestAnimationPresetArgs {
  /** Optional hint from user ("NPC", "boss", "villager", "player", etc.). */
  role?: string;
}

const suggestAnimationPresetSchema: ToolSchema = {
  name: "suggest_animation_preset",
  description:
    "根据角色用途（NPC / 村民 / BOSS / 玩家主角 / 怪物 / 摆件 / 坐骑 等）给出推荐的动作打包清单。" +
    "这是一个纯咨询工具，不修改 session；你应该在第一次 render_spritesheet 之前先问清用户意图，然后用它生成建议，再让用户确认。",
  parameters: {
    type: "object",
    properties: {
      role: {
        type: "string",
        description: "用户描述的角色定位，例如「村民 NPC」「最终 BOSS」「商店老板」「可操作玩家」",
      },
    },
    additionalProperties: false,
  },
};

/**
 * Curated presets so the model doesn't have to invent a list every time.
 * Keys are lowercased keyword fragments matched against the user's hint.
 */
const ANIMATION_PRESETS: Array<{
  keywords: string[];
  label: string;
  animations: string[];
  rationale: string;
}> = [
  {
    keywords: ["摆件", "静态", "装饰", "prop", "static", "柱子", "火炬", "招牌", "箱子"],
    label: "静态摆件",
    animations: ["idle"],
    rationale: "没有移动，只需要一个待机帧即可；通常只占 1 行 (256px 高)。",
  },
  {
    keywords: ["村民", "npc", "老板", "平民", "villager", "shop", "老人", "小孩", "路人"],
    label: "普通 NPC / 村民",
    animations: ["idle", "walk"],
    rationale: "大部分时间站着说话，偶尔走动；不需要战斗相关动作。约 2 行 (512px)。",
  },
  {
    keywords: ["商人", "商店", "黑商", "merchant", "banker", "柜员"],
    label: "商人 / 柜员",
    animations: ["idle", "emote"],
    rationale: "站在柜台后，只需待机 + 表情/招呼。",
  },
  {
    keywords: ["坐", "椅子", "王座", "throne", "sit", "赌桌", "吧台"],
    label: "坐着的角色",
    animations: ["idle", "sit"],
    rationale: "有「坐下」动画的 NPC（酒馆、王座、赌场）。",
  },
  {
    keywords: ["门卫", "守卫", "guard", "哨兵", "sentry", "士兵"],
    label: "守卫 / 哨兵",
    animations: ["idle", "walk", "hurt"],
    rationale: "巡逻 + 受击；无需挥砍/射击（除非剧情需要）。",
  },
  {
    keywords: ["小怪", "杂兵", "enemy", "monster", "怪", "小兵"],
    label: "普通怪物 / 杂兵",
    animations: ["idle", "walk", "hurt", "slash"],
    rationale: "需要追击 + 挨打 + 近战攻击；如果远程再补上 shoot。",
  },
  {
    keywords: ["远程怪", "弓手", "法师怪", "archer", "caster", "mage enemy"],
    label: "远程怪物",
    animations: ["idle", "walk", "hurt", "shoot", "spellcast"],
    rationale: "附带射击或施法动作。",
  },
  {
    keywords: ["boss", "首领", "精英", "elite", "头目"],
    label: "BOSS / 精英怪",
    animations: ["idle", "walk", "run", "hurt", "slash", "spellcast", "jump"],
    rationale: "动作越丰富越好；需要时再加 thrust / shoot / 1h_backslash 等。",
  },
  {
    keywords: ["玩家", "主角", "player", "hero", "可操作", "pc"],
    label: "玩家 / 主角（完整版）",
    animations: [
      "spellcast", "thrust", "walk", "slash", "shoot", "hurt",
      "climb", "idle", "jump", "sit", "emote", "run",
    ],
    rationale: "所有常用动作全部打包，方便玩家换装/切武器时复用。",
  },
  {
    keywords: ["坐骑", "宠物", "mount", "pet", "马", "狗", "猫"],
    label: "坐骑 / 宠物",
    animations: ["idle", "walk", "run", "hurt"],
    rationale: "跑走 + 受击即可；复杂的再加 jump / emote。",
  },
  {
    keywords: ["攀爬", "爬梯", "梯子", "climb", "rope", "藤蔓"],
    label: "需要攀爬的场景角色",
    animations: ["idle", "walk", "climb"],
    rationale: "带攀爬专用动画。",
  },
];

async function suggestAnimationPreset(
  _ctx: ToolContext,
  args: SuggestAnimationPresetArgs,
): Promise<ToolResult> {
  const raw = (args.role ?? "").toLowerCase();
  if (!raw.trim()) {
    return okData({
      hint: "请先告诉我这个角色的用途（玩家 / NPC / BOSS / 摆件 / 怪物 / 坐骑 …），我才能给出最适合的动作清单。",
      presets: ANIMATION_PRESETS.map((p) => ({ label: p.label, animations: p.animations })),
    });
  }
  // Best effort keyword match, fall back to player preset.
  let best = ANIMATION_PRESETS.find((p) =>
    p.keywords.some((kw) => raw.includes(kw.toLowerCase())),
  );
  if (!best) {
    // Heuristic: if we can't match, give the villager preset as conservative default.
    best = ANIMATION_PRESETS.find((p) => p.label === "普通 NPC / 村民") ?? ANIMATION_PRESETS[1];
  }
  const matches = ANIMATION_PRESETS.filter((p) =>
    p.keywords.some((kw) => raw.includes(kw.toLowerCase())),
  );
  return okData({
    matchedRole: args.role,
    recommended: {
      label: best.label,
      animations: best.animations,
      rationale: best.rationale,
    },
    alternatives: matches
      .filter((m) => m.label !== best!.label)
      .map((m) => ({ label: m.label, animations: m.animations, rationale: m.rationale })),
    fullSheetAnimations: [...ALLOWED_ANIMATIONS],
    tip:
      "在调用 render_spritesheet 时把推荐列表作为 animations 参数传入，" +
      "PNG 就只会包含这些行；如果用户之后想要更多动作，可以再次导出完整表。",
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
  { name: listCategoriesSchema.name, schema: listCategoriesSchema, handler: listCategories as RegisteredTool["handler"] },
  { name: listItemsSchema.name, schema: listItemsSchema, handler: listItems as RegisteredTool["handler"] },
  { name: getItemSchema.name, schema: getItemSchema, handler: getItem as RegisteredTool["handler"] },
  { name: listBodyTypesSchema.name, schema: listBodyTypesSchema, handler: listBodyTypes as RegisteredTool["handler"] },
  { name: listAnimationsSchema.name, schema: listAnimationsSchema, handler: listAnimations as RegisteredTool["handler"] },
  { name: suggestAnimationPresetSchema.name, schema: suggestAnimationPresetSchema, handler: suggestAnimationPreset as RegisteredTool["handler"] },
  { name: getStateSchema.name, schema: getStateSchema, handler: getState as RegisteredTool["handler"] },
  { name: setBodyTypeSchema.name, schema: setBodyTypeSchema, handler: setBodyType as RegisteredTool["handler"] },
  { name: setSelectionSchema.name, schema: setSelectionSchema, handler: setSelection as RegisteredTool["handler"] },
  { name: clearSelectionSchema.name, schema: clearSelectionSchema, handler: clearSelection as RegisteredTool["handler"] },
  { name: setAnimationSchema.name, schema: setAnimationSchema, handler: setAnimation as RegisteredTool["handler"] },
  { name: renderSpritesheetSchema.name, schema: renderSpritesheetSchema, handler: renderSpritesheet as RegisteredTool["handler"] },
  { name: resetToDefaultsSchema.name, schema: resetToDefaultsSchema, handler: resetToDefaults as RegisteredTool["handler"] },
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