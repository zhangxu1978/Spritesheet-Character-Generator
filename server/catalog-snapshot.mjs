// catalog-snapshot.mjs — server-side minimal catalog view, derived from the
// sheet_definitions/ folder. The browser catalog is the source of truth at
// runtime; this snapshot exists so the LLM (MiniMax) can pick real itemIds
// without needing DOM/catalog metadata.
//
// Why not share the browser catalog verbatim:
//   - The browser catalog is built from generated JS modules and only
//     available after async `install-item-metadata.ts` runs.
//   - We need an enumerable, sync, dependency-free view for the LLM.
//
// What we scan:
//   sheet_definitions/<...>/<itemId>.json  (every .json file = one item)
//   → itemId = file basename without `.json` (matches what
//     scripts/generateSources/items.js does).
//   → typeName = `definition.type_name` from the json, falling back to the
//     top-level directory under sheet_definitions/ if absent.
//
// This is intentionally a coarse view (id + name + typeName + body-types
// + recolors) — the browser replays any tool that needs finer detail.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SHEET_DIR = path.join(ROOT, "sheet_definitions");

let cached = null;

const IGNORED_FILES = new Set([
  "meta_lpcr.json",
  "meta_ulpc.json",
]);

const ROOT_TYPE_FALLBACK = {
  arms: "arms",
  body: "body",
  feet: "feet",
  hair: "hair",
  head: "head",
  headwear: "headwear",
  legs: "legs",
  tools: "tool",
  torso: "torso",
  weapons: "weapon",
};

export function loadCatalogSnapshot() {
  if (cached) return cached;
  const itemsById = new Map();
  const categories = {};
  if (!fs.existsSync(SHEET_DIR)) {
    cached = { items: [], categories: {} };
    return cached;
  }
  for (const topLevel of fs.readdirSync(SHEET_DIR)) {
    if (IGNORED_FILES.has(topLevel)) continue;
    const fullPath = path.join(SHEET_DIR, topLevel);
    if (!fs.statSync(fullPath).isFile() && !fs.statSync(fullPath).isDirectory()) {
      continue;
    }
    walk(fullPath, (jsonPath) => {
      const itemId = path.basename(jsonPath, ".json");
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      } catch {
        meta = null;
      }
      if (!meta || meta.ignore) return;
      const typeName =
        meta.type_name ??
        ROOT_TYPE_FALLBACK[topLevel] ??
        topLevel.replace(/s$/, "");
      const rec = {
        itemId,
        typeName,
        name: meta.name ?? itemId,
        required: Object.keys(meta.layer_1 ?? {}).filter(
          (k) => typeof meta?.layer_1?.[k] === "string",
        ),
        animations: meta.animations ?? [],
        variants: meta.variants ?? [],
        recolors: (meta.recolor_groups ?? []).map((g) => ({
          label: g.label ?? g.name ?? "?",
          colors: g.colors ?? [],
        })),
      };
      itemsById.set(itemId, rec);
      if (!categories[typeName]) categories[typeName] = [];
      if (!categories[typeName].some((r) => r.itemId === itemId)) {
        categories[typeName].push(rec);
      }
    });
  }
  cached = { items: [...itemsById.values()], categories };
  return cached;
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith("meta_")) {
      visit(full);
    }
  }
}

export function resetCatalogSnapshotCacheForTests() {
  cached = null;
}