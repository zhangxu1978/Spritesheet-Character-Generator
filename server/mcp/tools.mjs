// mcp/tools.mjs — MCP tool definitions + handlers for the spritesheet MCP
// server (server/mcp/stdio.mjs).
//
// Stateless by design: every tool takes the full character description in its
// arguments (bodyType + selections + animations) instead of mutating a
// session — cross-system MCP agents can't be assumed to keep session state
// between calls.
//
// Rendering delegates to server/mcp-renderer.mjs (headless Chromium via the
// existing Playwright pattern from scripts/issue382-golden-playwright.js);
// catalog data comes from server/catalog-snapshot.mjs; frame metadata JSON
// from server/spritesheet-meta.mjs.

import fs from "node:fs";
import path from "node:path";
import { loadCatalogSnapshot } from "../catalog-snapshot.mjs";
import { buildSpritesheetMeta, makePngFilename } from "../spritesheet-meta.mjs";
import {
  FULL_SHEET_ANIMATIONS,
  suggestAnimationPresetData,
} from "../animation-presets.mjs";
import { renderSpritesheet } from "../mcp-renderer.mjs";

const BODY_TYPES = ["male", "female", "teen", "child", "muscular", "pregnant"];
const FRAME_SIZE = 64;

// ─── Input schemas (JSON Schema, MCP tools/list inputSchema) ───────────────

const selectionItemSchema = {
  type: "object",
  description:
    "单个部件选择。itemId 必填；variant（如发色/衣色）与 recolor（如肤色）二选一或都留空。",
  properties: {
    typeName: { type: "string", description: "可选：分组名（body/head/hair/torso/legs/feet/weapon…）；缺省时按物品元数据自动推断" },
    itemId: { type: "string", description: "物品 id（list_items 返回的 itemId）" },
    name: { type: "string", description: "可选：显示名；缺省用 itemId" },
    variant: { type: "string", description: "可选：variant 名（如 black / violet）" },
    recolor: { type: "string", description: "可选：recolor 名（肤色/金属色，如 light）" },
    subId: { type: "integer", description: "可选：子 id" },
  },
  required: ["itemId"],
  additionalProperties: false,
};

const selectionsParamSchema = {
  oneOf: [
    {
      type: "array",
      description: "部件选择数组（推荐）",
      items: selectionItemSchema,
    },
    {
      type: "object",
      description:
        "分组名 → 选择的映射（与 Web UI 导出 JSON 的 selections 形态一致）",
      additionalProperties: selectionItemSchema,
    },
  ],
};

const bodyTypeParamSchema = {
  type: "string",
  enum: BODY_TYPES,
  description: "身体类型，默认 male",
};

const animationsParamSchema = {
  type: "array",
  items: { type: "string" },
  description:
    "可选：要打包进 PNG 的动作列表（如 [\"idle\",\"walk\"]）。不传/空数组 → 导出全部动作的完整大表。" +
    "NPC / 小怪 / 摆件请只传需要的动作，PNG 会小很多。",
};

// ─── Tool defs ─────────────────────────────────────────────────────────────

export const MCP_TOOLS = [
  {
    name: "list_categories",
    description:
      "列出全部可装备部件的分类（typeName），如 body / head / hair / torso / legs / feet / weapon 等，附各类物品数量。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_items",
    description:
      "按 typeName 或名称关键词列出可装备物品，返回 itemId / name / variants。itemId 是后续所有选择类工具的必要参数。",
    inputSchema: {
      type: "object",
      properties: {
        typeName: { type: "string", description: "部件分类（list_categories 返回）" },
        category: { type: "string", description: "可选：按物品名称子串过滤（如 \"sword\"、\"头发\"）" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_item",
    description: "获取单个物品的完整元数据（variants / recolors / required body types / 支持的动画）。",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "物品 id（list_items 给出）" },
      },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_body_types",
    description: "列出可选身体类型。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_animations",
    description: "列出可打包进精灵表的全部动作（generate_spritesheet 的 animations 参数取值）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "suggest_animation_preset",
    description:
      "根据角色用途（玩家 / NPC / 村民 / BOSS / 怪物 / 摆件 / 坐骑…）推荐应打包的动作清单。" +
      "纯咨询工具；建议在 generate_spritesheet 之前调用，把 recommended.animations 作为 animations 参数传入。",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description: "角色定位描述，例如「村民 NPC」「最终 BOSS」「可操作玩家」",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "build_config",
    description:
      "把 bodyType + selections + animations 组装成可回导入 Web UI 的 version-2 配置 JSON（校验 itemId、补全默认身体/头部/表情）。" +
      "只产出配置，不渲染图片。适合想先确认配置、或只想拿 JSON 的调用方。",
    inputSchema: {
      type: "object",
      properties: {
        bodyType: bodyTypeParamSchema,
        selections: selectionsParamSchema,
        animations: animationsParamSchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: "generate_spritesheet",
    description:
      "渲染序列帧精灵表 PNG 并返回（MCP image content）+ 帧元数据 JSON（每帧坐标/行号/方向）+ version-2 配置 JSON。" +
      "默认导出完整大表（全部动作，高 3456px、base64 很大）；NPC / 小怪 / 摆件务必传 animations 数组只打包需要的动作。" +
      "传 outputDir 时同时把 .png / .json / .config.json 写到磁盘并返回绝对路径。",
    inputSchema: {
      type: "object",
      properties: {
        bodyType: bodyTypeParamSchema,
        selections: selectionsParamSchema,
        animations: animationsParamSchema,
        includeImage: {
          type: "boolean",
          description: "默认 true；false 时只返回元数据和配置，不内联 base64 图片",
        },
        outputDir: {
          type: "string",
          description: "可选：输出目录（不存在会自动创建）；相对路径基于 MCP 服务器进程 cwd",
        },
        filePrefix: {
          type: "string",
          description: "可选：输出文件名前缀（默认 character-<bodyType>-<时间戳>）",
        },
      },
      additionalProperties: false,
    },
  },
];

// ─── Config validation / normalization ─────────────────────────────────────

function textResult(text, isError = false) {
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

function jsonResult(payload, { text, isError = false } = {}) {
  const result = {
    content: [{ type: "text", text: text ?? JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
  if (isError) result.isError = true;
  return result;
}

function toolError(message) {
  return textResult(`Error: ${message}`, true);
}

/** Look up an item in the server catalog snapshot. */
function findItem(itemId) {
  const snap = loadCatalogSnapshot();
  return snap.items.find((r) => r.itemId === itemId) ?? null;
}

/**
 * Default "body + head + face" trio, mirroring buildDefaultSelections in
 * sources/agent/session.ts. Group names come from the catalog snapshot
 * (type_name), matching what the Web UI exports.
 */
function defaultSelections(bodyType) {
  const make = (itemId, fallbackGroup, recolor) => {
    const rec = findItem(itemId);
    const head = itemId.startsWith("heads_human_") && !rec
      ? findItem("heads_human_male")
      : rec;
    if (!head) return null;
    return [head.typeName ?? fallbackGroup, {
      itemId: head.itemId,
      name: head.name,
      subId: null,
      variant: "",
      recolor,
    }];
  };
  const entries = [
    make("body", "body", "light"),
    make(`heads_human_${bodyType}`, "head", "light"),
    make("face_neutral", "expression", "light"),
  ];
  const selections = {};
  for (const entry of entries) {
    if (entry) selections[entry[0]] = entry[1];
  }
  return selections;
}

/**
 * Normalize + validate the selections argument (array or map form).
 * Returns {ok:true, selections} or {ok:false, message}.
 */
function normalizeSelections(input, bodyType) {
  const snap = loadCatalogSnapshot();
  const knownTypes = new Set(snap.items.map((r) => r.typeName));

  const normalizeOne = (group, sel) => {
    if (!sel || typeof sel !== "object" || typeof sel.itemId !== "string" || !sel.itemId) {
      return { error: `selection for "${group}" must include a string itemId` };
    }
    const rec = findItem(sel.itemId);
    if (!rec) {
      return {
        error: `itemId "${sel.itemId}" not found in catalog (use list_items to discover valid ids)`,
      };
    }
    const resolvedGroup =
      typeof sel.typeName === "string" && sel.typeName
        ? sel.typeName
        : (typeof group === "string" && group && group !== "__array__" ? group : rec.typeName);
    return {
      group: resolvedGroup,
      selection: {
        itemId: sel.itemId,
        name: typeof sel.name === "string" && sel.name ? sel.name : rec.name,
        subId: typeof sel.subId === "number" ? sel.subId : null,
        variant: sel.variant ?? "",
        recolor: sel.recolor ?? "",
      },
    };
  };

  const selections = {};
  if (input === undefined || input === null) {
    // falls through to the trio merge below
  } else if (Array.isArray(input)) {
    for (const sel of input) {
      const n = normalizeOne("__array__", sel);
      if (n.error) return { ok: false, message: n.error };
      selections[n.group] = n.selection;
    }
  } else if (typeof input === "object") {
    for (const [group, sel] of Object.entries(input)) {
      const n = normalizeOne(group, sel);
      if (n.error) return { ok: false, message: n.error };
      selections[n.group] = n.selection;
    }
  } else {
    return { ok: false, message: "selections must be an array or an object" };
  }

  // Safety check: unknown typeName groups would render as one-off groups on
  // the client, so hard-fail only when the caller provided selections and
  // none of them resolved to a known type (almost certainly malformed input).
  if (input !== undefined && input !== null && Object.keys(selections).length > 0) {
    const unresolved = Object.keys(selections).filter((g) => !knownTypes.has(g));
    if (unresolved.length === Object.keys(selections).length) {
      return {
        ok: false,
        message: `no selection mapped to a known typeName (got: ${unresolved.join(", ")})`,
      };
    }
  }

  // Always ensure the essential body/head/expression trio so the character
  // doesn't render as floating clothes (mirrors AgentSession's bootstrap in
  // sources/agent/session.ts). User-provided selections win.
  const defaults = defaultSelections(bodyType);
  for (const [group, sel] of Object.entries(defaults)) {
    if (!selections[group]) selections[group] = sel;
  }
  return { ok: true, selections };
}

/**
 * Validate and normalize a full character config.
 * Returns {ok:true, config} or {ok:false, message}.
 */
export function validateConfig(args = {}) {
  const bodyType = args.bodyType ?? "male";
  if (!BODY_TYPES.includes(bodyType)) {
    return {
      ok: false,
      message: `unsupported bodyType "${bodyType}" (allowed: ${BODY_TYPES.join(", ")})`,
    };
  }
  const selRes = normalizeSelections(args.selections, bodyType);
  if (!selRes.ok) return selRes;

  let animations = [];
  if (args.animations !== undefined && args.animations !== null) {
    if (!Array.isArray(args.animations)) {
      return { ok: false, message: "animations must be an array of strings" };
    }
    const unknown = args.animations.filter((a) => !FULL_SHEET_ANIMATIONS.includes(a));
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `unknown animations: ${unknown.join(", ")} (allowed: ${FULL_SHEET_ANIMATIONS.join(", ")})`,
      };
    }
    animations = [...new Set(args.animations)];
  }

  const selectedAnimation = animations[0] ?? "walk";
  return {
    ok: true,
    config: {
      version: 2,
      bodyType,
      selections: selRes.selections,
      selectedAnimation,
      animations,
    },
  };
}

// ─── Tool handlers ─────────────────────────────────────────────────────────

function listCategories() {
  const snap = loadCatalogSnapshot();
  const counts = {};
  for (const [type, items] of Object.entries(snap.categories)) {
    counts[type] = items.length;
  }
  return jsonResult({ typeNames: Object.keys(snap.categories).sort(), counts });
}

function listItems(args) {
  const snap = loadCatalogSnapshot();
  let rows = snap.items;
  if (args.typeName) rows = rows.filter((r) => r.typeName === args.typeName);
  if (args.category) {
    const kw = args.category.toLowerCase();
    rows = rows.filter((r) =>
      (r.name ?? r.itemId).toLowerCase().includes(kw),
    );
  }
  return jsonResult({
    count: rows.length,
    items: rows.map((r) => ({
      itemId: r.itemId,
      name: r.name,
      typeName: r.typeName,
      variants: r.variants,
    })),
  });
}

function getItem(args) {
  if (typeof args.itemId !== "string" || !args.itemId) {
    return toolError("itemId is required");
  }
  const rec = findItem(args.itemId);
  if (!rec) {
    return toolError(`item ${args.itemId} not in catalog (use list_items to discover valid ids)`);
  }
  return jsonResult(rec);
}

function buildConfig(args) {
  const res = validateConfig(args);
  if (!res.ok) return toolError(res.message);
  return jsonResult(res.config, {
    text: "配置 JSON 已生成（可通过 Web UI「导入 JSON」回导，或直接作为 generate_spritesheet 的输入）：\n" +
      JSON.stringify(res.config, null, 2),
  });
}

function sanitizeFilePrefix(prefix) {
  return (prefix + "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function generateSpritesheet(args) {
  const res = validateConfig(args);
  if (!res.ok) return toolError(res.message);
  const config = res.config;

  let rendered;
  try {
    rendered = await renderSpritesheet(config);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return toolError(`render failed: ${msg}`);
  }

  const filePrefix = sanitizeFilePrefix(
    args.filePrefix ?? makePngFilename(config.bodyType).replace(/\.png$/, ""),
  );
  const pngFilename = `${filePrefix}.png`;

  const meta = buildSpritesheetMeta({
    pngFilename,
    sheetWidth: rendered.width,
    sheetHeight: rendered.fullHeight,
    bodyType: config.bodyType,
    includedAnimations: rendered.includedAnimations,
  });

  const files = {};
  if (typeof args.outputDir === "string" && args.outputDir.trim()) {
    try {
      const outDir = path.resolve(args.outputDir.trim());
      fs.mkdirSync(outDir, { recursive: true });
      const pngPath = path.join(outDir, pngFilename);
      const metaPath = path.join(outDir, `${filePrefix}.json`);
      const configPath = path.join(outDir, `${filePrefix}.config.json`);
      fs.writeFileSync(pngPath, Buffer.from(rendered.base64, "base64"));
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      files.png = pngPath;
      files.meta = metaPath;
      files.config = configPath;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return toolError(`writing output files failed: ${msg}`);
    }
  }

  const summary = {
    png: {
      width: rendered.width,
      height: rendered.height,
      ...(files.png ? { file: files.png } : {}),
    },
    fullSheet: { width: rendered.fullWidth, height: rendered.fullHeight },
    includedAnimations: rendered.includedAnimations,
    animationsHint:
      rendered.includedAnimations.length > 0
        ? "PNG 只包含传入的 animations"
        : "PNG 包含全部动作（完整大表）；NPC/小怪可传 animations 子集减小体积",
    ...(Object.keys(files).length > 0
      ? { files }
      : { filesHint: "传 outputDir 参数可把 PNG/元数据/配置写到磁盘" }),
  };

  const content = [];
  if (args.includeImage !== false) {
    content.push({
      type: "image",
      data: rendered.base64,
      mimeType: "image/png",
    });
  }
  content.push({
    type: "text",
    text: "精灵表已生成。\n" + JSON.stringify(summary, null, 2),
  });

  return {
    content,
    structuredContent: {
      summary,
      config,
      meta,
    },
  };
}

/** Map tool name → handler. All handlers return MCP result objects. */
export async function callTool(name, args) {
  switch (name) {
    case "list_categories":
      return listCategories();
    case "list_items":
      return listItems(args ?? {});
    case "get_item":
      return getItem(args ?? {});
    case "list_body_types":
      return jsonResult({ bodyTypes: BODY_TYPES });
    case "list_animations":
      return jsonResult({ animations: FULL_SHEET_ANIMATIONS.slice() });
    case "suggest_animation_preset":
      return jsonResult(suggestAnimationPresetData((args ?? {}).role));
    case "build_config":
      return buildConfig(args ?? {});
    case "generate_spritesheet":
      return generateSpritesheet(args ?? {});
    default:
      // protocol.mjs already guards unknown names; defensive only.
      return toolError(`unknown tool: ${name}`);
  }
}

// Re-export for tests.
export { validateConfig as _validateConfig, FRAME_SIZE };
