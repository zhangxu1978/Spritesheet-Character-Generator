// selection-normalize.ts — fill in palette colors for recolor-capable
// selections submitted without one.
//
// The Web UI can never produce recolor-less selections for palette items
// (the tree always passes the picked color), but tool-driven flows (Agent
// set_selection, MCP generate_spritesheet) can. Raw selections like that
// resolve variant-style sprite paths that 404 on the flat, palette-recolored
// files on disk — the item silently vanishes from the render. Normalizing
// here mirrors what a tree click does: store a compiled palette key
// ("light", "ulpc.light", "steel", …) that fixMissingRecolor accepts.

import { defaultCatalog } from "./catalog.ts";
import { fixMissingRecolor, parseRecolorKey } from "./palettes.ts";
import type { Selection, Selections } from "./state.ts";

/**
 * Fill the default palette color for one selection that has neither a
 * recolor nor a variant. Returns the input object (mutated in place) for
 * chaining convenience.
 */
export function normalizeSelectionRecolor(selection: Selection): Selection {
  if (selection.recolor || selection.variant) return selection;
  const lite = defaultCatalog.getItemLite(selection.itemId).unwrapOr(null);
  if (!lite || lite.recolors.length === 0) return selection;

  for (const palette of lite.recolors) {
    const [, version, baseColor] = parseRecolorKey(null, palette);
    const candidates = [
      baseColor,
      baseColor && version ? `${version}.${baseColor}` : undefined,
      ...(palette.variants ?? []),
    ].filter((c): c is string => Boolean(c));
    for (const candidate of candidates) {
      const verified = fixMissingRecolor(
        selection.itemId,
        candidate,
        selection.subId ? (palette.type_name ?? null) : null,
      ).unwrapOr(null);
      if (verified) {
        selection.recolor = verified;
        break;
      }
    }
    if (selection.recolor) break;
  }
  return selection;
}

/**
 * Mirror of the input selections with one fix applied: recolor-capable items
 * submitted without a `recolor` get their palette's default color. See file
 * header for why this matters.
 */
export function normalizeSelectionRecolors(selections: Selections): Selections {
  const out: Selections = JSON.parse(JSON.stringify(selections));
  for (const selection of Object.values(out)) {
    normalizeSelectionRecolor(selection);
  }
  return out;
}
