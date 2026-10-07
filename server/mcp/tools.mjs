// tools.mjs — MCP tool definitions + handlers.
//
// 8 stateless tools: each call carries its full configuration (bodyType +
// selections + animations), unlike the /api/agent/* session-based flow.
// Catalog tools reuse server/catalog-snapshot.mjs; frame metadata JSON comes
// from server/spritesheet-meta.mjs; PNG rendering is delegated to an injected
// renderer (server/mcp-renderer.mjs in production, a stub in tests).
//
// Every handler returns an MCP CallToolResult:
//   { content: [...], structuredContent?, isError? }

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalogSnapshot } from "../catalog-snapshot.mjs";
import { suggestAnimationPresetData } from "../animation-presets.mjs";
import {
  CUSTOM_ANIMATIONS,
  listCustomAnimations,
  isCustomAnimation,
} from "../custom-animations.mjs";
import {
  buildSpritesheetMeta,
  makePngFilename,
  makeMetaFilename,
  listExportableAnimations,
} from "../spritesheet-meta.mjs";

const BODY_TYPES = ["male", "female", "teen", "child", "muscular", "pregnant"];

// MCP clients may launch this server with any cwd; relative outputDir
// paths are documented as relative to the repo root.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const FULL_SHEET_HINT =
  "不传 animations 时导出完整大表（标准动作约 832x3456px；若装备了斧/锤/大剑等带专属动作的武器/工具，下方还会追加更大的专属动作区）。NPC/小怪/摆件等角色请传 animations 子集（如 [\"idle\",\"walk\"]），输出小得多。";

const WEAPON_ANIM_NOTE =
  "武器/工具与动作的映射关系：每个部件只参与其元数据 animations 数组列出的动作。" +
  "普通武器（匕首/剑等）直接用标准动作 slash/thrust；斧/镐/锤/鞭/法杖类工具有专属自定义动作" +
  "（tool_axe / tool_hammer / tool_whip / tool_rod），大剑/长柄/弓等有加大动作（*_oversize / *_128）。" +
  "用 get_item 查看武器的 animations 字段即可确认它支持哪些动作——装备斧头时挥砍必须用 tool_axe 而不是 slash。";

/** Valid export animation names: standard whitelist + custom registry. */
function allValidAnimationNames() {
  return [
    ...listExportableAnimations().map((a) => a.value),
    ...Object.keys(CUSTOM_ANIMATIONS),
  ];
}

/** Union of custom animation names declared by the given selections (in order). */
function declaredCustomAnimations(selections, byId) {
  const seen = new Set();
  const declared = [];
  for (const sel of Object.values(selections)) {
    const rec = byId.get(sel.itemId);
    for (const a of rec?.animations ?? []) {
      if (isCustomAnimation(a) && !seen.has(a)) {
        seen.add(a);
        declared.push(a);
      }
    }
  }
  return declared;
}

/**
 * Custom-animation layout for meta building without a real render:
 * selective → request order (offsets recomputed); full sheet → stacked below
 * the 3456px standard sheet in declaration order.
 */
function customLayoutFor(declared, requestedAnimations) {
  const layout = (name, yOffset) => ({
    name,
    frameSize: CUSTOM_ANIMATIONS[name].frameSize,
    frameCount: CUSTOM_ANIMATIONS[name].frameCount,
    ...(yOffset !== undefined ? { yOffset } : {}),
  });
  if (requestedAnimations && requestedAnimations.length > 0) {
    return requestedAnimations.filter(isCustomAnimation).map((name) => layout(name));
  }
  let y = 3456;
  return declared.map((name) => {
    const entry = layout(name, y);
    y += 4 * CUSTOM_ANIMATIONS[name].frameSize;
    return entry;
  });
}

// ─── Tool definitions (MCP ToolDef: name + description + inputSchema) ────

export const MCP_TOOLS = [
  {
    name: "list_body_types",
    description: "列出可选的身体类型（male/female/teen/child/muscular/pregnant）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_animations",
    description:
      "列出全部可导出的动作（可传给 generate_spritesheet 的 animations 参数）。" +
      "分两类：标准动作（spellcast/walk/slash…，对所有部件通用）和自定义动作（custom:true，" +
      "tool_axe/tool_hammer/tool_whip/tool_rod/slash_oversize 等，只被声明它的武器/工具渲染，usedBy 列出这些物品）。" +
      WEAPON_ANIM_NOTE,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_categories",
    description: "列出全部部件分类及其下的物品（body/hair/torso/legs/feet/weapon 等）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_items",
    description: "按 typeName 或名称关键字列出物品（itemId/name/variants）。先用它查找真实 itemId，不要编造。",
    inputSchema: {
      type: "object",
      properties: {
        typeName: { type: "string", description: "按分类过滤，如 hair / torso / weapon" },
        category: { type: "string", description: "按物品名称子串过滤（不区分大小写）" },
        detailed: { type: "boolean", description: "true 时附带 required/animations/recolors 详情" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_item",
    description:
      "获取单个物品的完整元数据（variants/recolors/animations 等）。" +
      "对武器/工具务必查看返回的 animations 字段：里面出现的非标准动作名（如 tool_axe）就是该武器的专属攻击动作，" +
      "导出攻击帧时要用它替代 slash/thrust。",
    inputSchema: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
      additionalProperties: false,
    },
  },
  {
    name: "suggest_animation_preset",
    description:
      "根据角色用途（玩家/村民/商人/守卫/小怪/BOSS/摆件/坐骑…）推荐应打包的动作清单。" +
      "在 generate_spritesheet 之前调用，可以挑一个动作子集显著减小 PNG 体积。",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "角色定位描述，如「村民 NPC」「最终 BOSS」" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "build_config",
    description:
      "只生成配置 JSON（不渲染图片）。返回可回导入 Web UI 的 version-2 配置 + 帧元数据说明。" +
      "selections 每项 {itemId, name?, variant?, recolor?, subId?}，itemId 必须来自 list_items/get_item。" +
      "缺失的 body/heads/expression 默认三件套会自动补全。",
    inputSchema: {
      type: "object",
      properties: {
        bodyType: { type: "string", enum: BODY_TYPES, description: "默认 male" },
        selections: {
          type: "object",
          description:
            "键为部件分组名，值为 {itemId, name?, variant?, recolor?, subId?}。" +
            "分组键只是标签（渲染不看它），但推荐用物品自身的 typeName（torso/legs/feet/weapon/hat/hair/expression…）以免歧义；" +
            "缺失的 body/头/表情会自动补全。",
          additionalProperties: { type: "object" },
        },
        animations: {
          type: "array",
          items: { type: "string" },
          description:
            "要打包的动作列表；标准动作对所有部件通用，自定义动作（tool_axe 等）只被装备的对应武器/工具渲染（见 get_item 的 animations 字段）。不传/空 = 全部动作",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "generate_spritesheet",
    description:
      "校验配置后无头渲染，产出序列帧精灵表 PNG（base64）+ 帧元数据 JSON + 可回导 Web UI 的配置 JSON。" +
      "传 outputDir 时同时写盘（.png / .json 帧元数据 / .config.json 配置）并返回绝对路径。" +
      FULL_SHEET_HINT,
    inputSchema: {
      type: "object",
      properties: {
        bodyType: { type: "string", enum: BODY_TYPES, description: "默认 male" },
        selections: {
          type: "object",
          description: "同 build_config；缺省时使用默认角色（身体+头像+表情）",
          additionalProperties: { type: "object" },
        },
        animations: {
          type: "array",
          items: { type: "string" },
          description:
            "要打包的动作列表；装备斧/锤等工具时记得把专属动作（如 tool_axe）加进来。" +
            FULL_SHEET_HINT,
        },
        includeImage: { type: "boolean", description: "默认 true；false 时结果不含 base64 图片（只写盘/返回元数据）" },
        outputDir: { type: "string", description: "输出目录（绝对路径或相对仓库根）；传入则写盘三个文件" },
        filePrefix: { type: "string", description: "输出文件名前缀，默认 character-<bodyType>" },
      },
      additionalProperties: false,
    },
  },
];

// ─── Validation / config building ─────────────────────────────────────────

/**
 * Validate bodyType/selections/animations and produce a version-2 config.
 * Missing default trio (body color + human head + neutral face) is completed
 * using the catalog snapshot, mirroring AgentSession's buildDefaultSelections.
 *
 * Animations: the standard whitelist accepts every body part; custom
 * animations (tool_axe, …) are also accepted — they only render when one of
 * the selected items declares them, so undeclared ones produce a warning
 * instead of a hard error.
 *
 * @returns {{ ok: true, config: object, validAnimations: string[],
 *             declaredCustomAnimations: string[], warnings: string[] } |
 *           { ok: false, message: string }}
 */
export function validateConfig(args) {
  const bodyType = args.bodyType ?? "male";
  if (!BODY_TYPES.includes(bodyType)) {
    return { ok: false, message: `unknown bodyType: ${bodyType}（可选：${BODY_TYPES.join("/")}）` };
  }

  const snap = loadCatalogSnapshot();
  const byId = new Map(snap.items.map((r) => [r.itemId, r]));

  // Normalize + validate selections.
  const selections = {};
  const rawSelections = args.selections ?? {};
  if (typeof rawSelections !== "object" || Array.isArray(rawSelections)) {
    return { ok: false, message: "selections 必须是对象：{ 分组名: {itemId, ...} }" };
  }
  for (const [group, raw] of Object.entries(rawSelections)) {
    if (!raw || typeof raw !== "object" || typeof raw.itemId !== "string") {
      return { ok: false, message: `selections["${group}"] 缺少 itemId` };
    }
    const rec = byId.get(raw.itemId);
    if (!rec) {
      return {
        ok: false,
        message: `itemId "${raw.itemId}" 不存在于部件目录（用 list_items / get_item 查找真实 id）`,
      };
    }
    selections[group] = {
      itemId: raw.itemId,
      name: typeof raw.name === "string" ? raw.name : rec.name,
      variant: raw.variant ?? null,
      recolor: raw.recolor ?? null,
      subId: raw.subId ?? null,
    };
  }

  // Complete the default trio for anything missing (mirrors
  // AgentSession.buildDefaultSelections / state.ts selectDefaults): without a
  // body layer only clothes render onto transparent background.
  const trio = [
    { itemId: "body", recolor: "light", name: "Body color (light)" },
    { itemId: `heads_human_${bodyType}`, fallbackItemId: "heads_human_male", recolor: "light", name: `Human ${bodyType} (light)` },
    { itemId: "face_neutral", recolor: "light", name: "Neutral (light)" },
  ];
  const usedItemIds = new Set(Object.values(selections).map((s) => s.itemId));
  const usedTypeNames = new Set(
    Object.values(selections)
      .map((s) => byId.get(s.itemId)?.typeName)
      .filter(Boolean),
  );
  for (const def of trio) {
    if (usedItemIds.has(def.itemId)) continue;
    let itemId = def.itemId;
    let rec = byId.get(itemId);
    if (!rec && def.fallbackItemId) {
      itemId = def.fallbackItemId;
      rec = byId.get(itemId);
    }
    if (!rec) continue; // catalog lacks it entirely; renderer will too — skip
    const group = rec.typeName ?? itemId;
    // Skip only when an item of the same slot type is already equipped
    // (e.g. a custom head). Group keys are arbitrary labels — a helmet
    // (typeName "hat") stored under a user key "head" must NOT suppress the
    // human head underneath it, so never key the check off the group name.
    if (usedTypeNames.has(group)) continue;
    // If that group key happens to be taken by another slot type, fall back
    // to the itemId as the key (the renderer ignores key names).
    const groupKey = selections[group] ? itemId : group;
    selections[groupKey] = {
      itemId,
      variant: "",
      recolor: def.recolor,
      name: rec.name ?? def.name,
    };
    usedItemIds.add(itemId);
    usedTypeNames.add(group);
  }

  // Validate animations against the exportable whitelist (+ custom registry).
  const validAnimations = allValidAnimationNames();
  const declaredCustom = declaredCustomAnimations(selections, byId);
  const warnings = [];
  let animations;
  if (Array.isArray(args.animations) && args.animations.length > 0) {
    const invalid = args.animations.filter((a) => !validAnimations.includes(a));
    if (invalid.length > 0) {
      return {
        ok: false,
        message: `未知动作: ${invalid.join(", ")}（可选：${validAnimations.join(", ")}）`,
      };
    }
    animations = [...new Set(args.animations)];
    // Requested custom animations that no selected item declares → warn
    // (the render simply won't contain that area).
    for (const a of animations) {
      if (isCustomAnimation(a) && !declaredCustom.includes(a)) {
        warnings.push(
          `动作 ${a} 没有被当前装备的任何部件声明（见 get_item 的 animations 字段），导出的 PNG 将不包含该动作区。`,
        );
      }
    }
  } else {
    animations = []; // empty = full sheet
  }

  const config = {
    version: 2,
    bodyType,
    selections,
    selectedAnimation: animations[0] ?? "walk",
    animations,
  };
  return {
    ok: true,
    config,
    validAnimations,
    declaredCustomAnimations: declaredCustom,
    warnings,
  };
}

// ─── Handlers ──────────────────────────────────────────────────────────────

function textResult(payload, structured) {
  const result = { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  if (structured) result.structuredContent = structured;
  return result;
}

/**
 * Tool dispatch. `ctx` carries the injected renderer so tests can stub it;
 * production (stdio.mjs) passes the real headless renderer.
 */
export async function callTool(name, args, ctx) {
  switch (name) {
    case "list_body_types":
      return textResult(BODY_TYPES);

    case "list_animations": {
      // Build the custom-name → items reverse map from the catalog snapshot
      // (items' `animations` arrays are the authoritative relationship).
      const usedBy = {};
      for (const rec of loadCatalogSnapshot().items) {
        for (const a of rec.animations ?? []) {
          if (isCustomAnimation(a)) {
            (usedBy[a] ??= []).push(rec.itemId);
          }
        }
      }
      return textResult([
        ...listExportableAnimations(),
        ...listCustomAnimations().map((c) => ({ ...c, usedBy: usedBy[c.value] ?? [] })),
      ]);
    }

    case "list_categories":
      return textResult(loadCatalogSnapshot().categories);

    case "list_items": {
      let rows = loadCatalogSnapshot().items;
      if (args.typeName) rows = rows.filter((r) => r.typeName === args.typeName);
      if (args.category) {
        rows = rows.filter((r) =>
          (r.name ?? r.itemId).toLowerCase().includes(args.category.toLowerCase()),
        );
      }
      const data = rows.map((r) =>
        args.detailed
          ? r
          : { itemId: r.itemId, name: r.name, type_name: r.typeName, variants: r.variants },
      );
      return textResult({ count: data.length, items: data });
    }

    case "get_item": {
      const rec = loadCatalogSnapshot().items.find((r) => r.itemId === args.itemId);
      if (!rec) {
        return {
          content: [{ type: "text", text: `item ${args.itemId} not in catalog` }],
          isError: true,
        };
      }
      // Make the weapon/tool → animation relationship explicit: split the
      // item's animation list into standard vs custom and explain how to use
      // the custom ones.
      const customAnims = (rec.animations ?? []).filter(isCustomAnimation);
      const payload = { ...rec };
      if (customAnims.length > 0) {
        payload.animationGuide = {
          standardAnimations: (rec.animations ?? []).filter((a) => !isCustomAnimation(a)),
          customAnimations: customAnims.map((name) => ({
            name,
            label: CUSTOM_ANIMATIONS[name].label,
            frameSize: CUSTOM_ANIMATIONS[name].frameSize,
            baseAnimation: CUSTOM_ANIMATIONS[name].baseAnimation,
            note: CUSTOM_ANIMATIONS[name].note,
          })),
          tip:
            "customAnimations 里的动作是该部件专属的（标准 slash/thrust 行里不会出现它）。" +
            "导出该部件的攻击帧时，把这里的动作名加进 generate_spritesheet 的 animations 参数，替代或补充标准动作。",
        };
      }
      return textResult(payload);
    }

    case "suggest_animation_preset":
      return textResult(suggestAnimationPresetData(args.role));

    case "build_config": {
      const v = validateConfig(args);
      if (!v.ok) {
        return { content: [{ type: "text", text: v.message }], isError: true };
      }
      // Preview meta: custom-animation areas from the registry (no render
      // here). Selective → request order; full → stacked below the 3456px
      // standard sheet.
      const customLayout = customLayoutFor(
        v.declaredCustomAnimations,
        v.config.animations,
      );
      let previewWidth = 832;
      let previewHeight = 3456;
      for (const c of customLayout) {
        previewWidth = Math.max(previewWidth, c.frameSize * c.frameCount);
        previewHeight += 4 * c.frameSize;
      }
      const metaPreview = buildSpritesheetMeta({
        pngFilename: "preview.png",
        sheetWidth: previewWidth,
        sheetHeight: previewHeight,
        bodyType: v.config.bodyType,
        includedAnimations: v.config.animations.length > 0 ? v.config.animations : undefined,
        customAnimations: customLayout,
      });
      const hints = {};
      if (v.declaredCustomAnimations.length > 0) {
        hints.animationHints = {
          declaredCustomAnimations: v.declaredCustomAnimations,
          note: WEAPON_ANIM_NOTE,
        };
      }
      if (v.warnings.length > 0) hints.warnings = v.warnings;
      return textResult(
        {
          config: v.config,
          ...hints,
          metaPreview: {
            sheetWidth: metaPreview.sheetWidth,
            sheetHeight: metaPreview.sheetHeight,
            frameWidth: metaPreview.frameWidth,
            frameHeight: metaPreview.frameHeight,
            frameColumns: metaPreview.frameColumns,
            animations: Object.fromEntries(
              Object.entries(metaPreview.animations).map(([k, a]) => [
                k,
                {
                  row: a.row,
                  rows: a.rows,
                  cycle: a.cycle,
                  ...(a.custom
                    ? { custom: true, frameWidth: a.frameWidth, frameHeight: a.frameHeight }
                    : {}),
                },
              ]),
            ),
          },
          hint: "config 可直接通过 Web UI「导入 JSON」回导；generate_spritesheet 会返回完整 meta。",
        },
        { config: v.config },
      );
    }

    case "generate_spritesheet": {
      const v = validateConfig(args);
      if (!v.ok) {
        return { content: [{ type: "text", text: v.message }], isError: true };
      }
      const config = v.config;
      const includeImage = args.includeImage !== false;
      const tag = args.filePrefix || `character-${config.bodyType}`;
      const pngFilename = makePngFilename(tag);
      const animationsArg = config.animations.length > 0 ? config.animations : undefined;

      // Render via the injected headless renderer.
      const rendered = await ctx.renderer.render({
        selections: config.selections,
        bodyType: config.bodyType,
        animation: config.selectedAnimation,
        animations: animationsArg,
      });
      const pngBytes = Buffer.byteLength(rendered.base64, "base64");

      // The render page normalizes recolor-less palette items to their default
      // color (the Web UI can never produce such selections). Export THAT
      // version so the config re-imports and re-renders identically.
      if (rendered.normalizedSelections) {
        config.selections = rendered.normalizedSelections;
      }

      // Frame metadata JSON (pure function). Custom-animation areas reported
      // by the renderer (tool_axe, …) are described with their own frame size.
      const meta = buildSpritesheetMeta({
        pngFilename,
        pngBytes,
        sheetWidth: rendered.width,
        sheetHeight: rendered.height,
        bodyType: config.bodyType,
        includedAnimations: animationsArg,
        customAnimations: rendered.customAnimations ?? [],
      });

      const files = {};
      if (args.outputDir) {
        const outDir = path.isAbsolute(args.outputDir)
          ? args.outputDir
          : path.resolve(REPO_ROOT, args.outputDir);
        fs.mkdirSync(outDir, { recursive: true });

        const pngPath = path.join(outDir, pngFilename);
        fs.writeFileSync(pngPath, Buffer.from(rendered.base64, "base64"));

        const metaPath = path.join(outDir, makeMetaFilename(pngFilename));
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        const configPath = path.join(outDir, makeMetaFilename(pngFilename).replace(/\.json$/i, ".config.json"));
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        files.png = pngPath;
        files.meta = metaPath;
        files.config = configPath;
      }

      const summary = {
        png: {
          width: rendered.width,
          height: rendered.height,
          includedAnimations: rendered.includedAnimations,
          selective: config.animations.length > 0,
        },
        frameInfo: {
          frameWidth: meta.frameWidth,
          frameHeight: meta.frameHeight,
          frameColumns: meta.frameColumns,
          animations: Object.fromEntries(
            Object.entries(meta.animations).map(([k, a]) => [
              k,
              a.custom
                ? { row: a.row, rows: a.rows, cycle: a.cycle, frameWidth: a.frameWidth, frameHeight: a.frameHeight }
                : { row: a.row, rows: a.rows, cycle: a.cycle },
            ]),
          ),
        },
        files,
        hint: "meta 为帧元数据 JSON（每帧 x/y/width/height/direction）；config 可回导入 Web UI。",
      };
      if (v.declaredCustomAnimations.length > 0) {
        summary.animationHints = {
          declaredCustomAnimations: v.declaredCustomAnimations,
          note: WEAPON_ANIM_NOTE,
        };
      }
      if (v.warnings.length > 0) summary.warnings = v.warnings;

      const content = [];
      if (includeImage) {
        content.push({ type: "image", data: rendered.base64, mimeType: "image/png" });
      }
      content.push({ type: "text", text: JSON.stringify(summary, null, 2) });

      const result = { content, structuredContent: { config, meta, files } };
      return result;
    }

    default:
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }
}

/**
 * Create the tool context used by stdio.mjs (real renderer).
 * In tests, pass { renderer: fakeRenderer } instead.
 */
export function createToolContext({ renderer } = {}) {
  return { renderer };
}
