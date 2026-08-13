// spritesheet-meta.ts — builds a JSON-friendly description of the LPC
// spritesheet grid so downstream consumers (Phaser / PixiJS / Unity / a
// custom engine) can slice the PNG without re-deriving the layout from
// our TypeScript constants.
//
// One "animation row" in the LPC sheet = one direction (up / left / down /
// right). Each direction is `STANDARD_ANIMATION_FRAMES_PER_ROW` (= 13) frames
// wide and `FRAME_SIZE` (= 64 px) tall. The animation `cycle` array picks
// which columns are actually used and in what order.
//
// This module is pure: no DOM, no canvas, no `document`. The Agent page
// calls it once per download and writes the result to a sidecar `.json`.

import {
  FRAME_SIZE,
  STANDARD_ANIMATION_FRAMES_PER_ROW,
  ANIMATIONS,
  ANIMATION_OFFSETS,
  ANIMATION_CONFIGS,
  DIRECTIONS,
} from "../state/constants.ts";

export interface SpriteFrame {
  /** Direction index within this animation (0..num-1). 0 for single-dir anims. */
  direction: number;
  /** "up" / "left" / "down" / "right" for num=4 anims; "single" otherwise. */
  directionLabel: string;
  /** Position inside the cycle array (0..cycle.length-1). */
  cycleIndex: number;
  /** Frame number from the cycle (column on the row, 0..STANDARD_ANIMATION_FRAMES_PER_ROW-1). */
  frameNumber: number;
  /** Pixel rectangle on the PNG. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteAnimationMeta {
  /** Animation key as it appears in ANIMATIONS (e.g. "spellcast", "1h_backslash"). */
  name: string;
  /** Display label from ANIMATIONS (Chinese in this build, but free-form). */
  label: string;
  /** Starting row index in the full sheet (in frames, not pixels). */
  row: number;
  /** Number of rows this animation occupies (= num = direction count). */
  rows: number;
  /** Direction count. */
  directions: number;
  /** Column count per row (= STANDARD_ANIMATION_FRAMES_PER_ROW = 13). */
  columns: number;
  /** Cycle frame numbers, in playback order. */
  cycle: number[];
  /** Expanded frames (one entry per cycle step per direction). */
  frames: SpriteFrame[];
}

export interface SpritesheetMeta {
  /** Sidecar PNG filename (without path). Consumers can match by basename. */
  pngFilename: string;
  /** PNG byte size when known. */
  pngBytes?: number;
  /** Sheet total width in pixels (= FRAME_SIZE * STANDARD_ANIMATION_FRAMES_PER_ROW = 832). */
  sheetWidth: number;
  /** Sheet total height in pixels. Recomputed when selective export truncates rows. */
  sheetHeight: number;
  /** Single frame size in pixels (FRAME_SIZE = 64). */
  frameWidth: number;
  frameHeight: number;
  /** Frame columns per row (STANDARD_ANIMATION_FRAMES_PER_ROW = 13). */
  frameColumns: number;
  /** Number of directions (DIRECTIONS.length = 4). */
  frameRows: number;
  /** Direction order, top-to-bottom on the sheet. */
  directions: string[];
  /** Selected body type for this render (male / female / teen / …). */
  bodyType: string;
  /** ISO timestamp of when this JSON was generated. */
  generatedAt: string;
  /** Animations actually included in the PNG. `undefined` means full sheet. */
  includedAnimations?: string[];
  /** Per-animation metadata. */
  animations: Record<string, SpriteAnimationMeta>;
}

/** Animations flagged with `noExport: true` are skipped (matches AgentPreview's `exportable` filter). */
function isExportable(a: { value: string; noExport?: boolean }): boolean {
  return !a.noExport;
}

/** Resolve the cycle config for an animation name, skipping unknown ones. */
function cycleFor(name: string): number[] | null {
  const cfg = (
    ANIMATION_CONFIGS as Record<
      string,
      { cycle?: number[]; num?: number; row?: number } | undefined
    >
  )[name];
  if (!cfg || !Array.isArray(cfg.cycle)) return null;
  return cfg.cycle.slice();
}

/** Direction count for an animation; hurt/climb are 1, everything else 4. */
function directionsFor(name: string): number {
  const cfg = (
    ANIMATION_CONFIGS as Record<string, { num?: number } | undefined>
  )[name];
  return cfg?.num ?? 4;
}

interface BuildOpts {
  pngFilename: string;
  pngBytes?: number;
  sheetWidth: number;
  sheetHeight: number;
  bodyType: string;
  /** Animations to include. Empty / undefined → full sheet. */
  includedAnimations?: string[];
  /** Override timestamp (used by tests). */
  now?: Date;
}

export function buildSpritesheetMeta(opts: BuildOpts): SpritesheetMeta {
  const now = opts.now ?? new Date();
  const allExportable = ANIMATIONS.filter(isExportable);

  // Decide which animations we emit, in the order we emit them:
  //   - includedAnimations provided → filter + dedupe + preserve order.
  //   - otherwise → full exportable list, sorted by ANIMATION_OFFSETS.
  let chosen: typeof allExportable;
  let includedOrder: string[] | undefined;
  if (opts.includedAnimations && opts.includedAnimations.length > 0) {
    const seen = new Set<string>();
    const ordered: typeof allExportable = [];
    for (const name of opts.includedAnimations) {
      if (seen.has(name)) continue;
      const meta = allExportable.find((a) => a.value === name);
      if (!meta) continue;
      seen.add(name);
      ordered.push(meta);
    }
    chosen = ordered;
    includedOrder = ordered.map((a) => a.value);
  } else {
    // Full sheet: sort by row ascending so JSON is stable.
    // ANIMATION_OFFSETS is in *pixels* (multiples of FRAME_SIZE); convert
    // back to row indices for the JSON.
    chosen = allExportable
      .slice()
      .sort(
        (a, b) =>
          (ANIMATION_OFFSETS[a.value as keyof typeof ANIMATION_OFFSETS] ?? 0) /
            FRAME_SIZE -
          (ANIMATION_OFFSETS[b.value as keyof typeof ANIMATION_OFFSETS] ?? 0) /
            FRAME_SIZE,
      );
  }

  const animations: Record<string, SpriteAnimationMeta> = {};
  let runningRow = 0; // for selective export, rows are packed contiguously
  let sheetRows = 0; // total rows for the JSON `sheetHeight` recomputation

  for (const meta of chosen) {
    const cycle = cycleFor(meta.value);
    if (!cycle) continue;
    const directions = directionsFor(meta.value);
    const fullSheetRow =
      (ANIMATION_OFFSETS[meta.value as keyof typeof ANIMATION_OFFSETS] ??
        runningRow * FRAME_SIZE) / FRAME_SIZE;
    const row =
      opts.includedAnimations && opts.includedAnimations.length > 0
        ? runningRow
        : fullSheetRow;

    const frames: SpriteFrame[] = [];
    for (let dirIdx = 0; dirIdx < directions; dirIdx++) {
      const directionLabel =
        directions === DIRECTIONS.length
          ? (DIRECTIONS[dirIdx] ?? "single")
          : "single";
      const rowPx = (row + dirIdx) * FRAME_SIZE;
      for (let cycleIdx = 0; cycleIdx < cycle.length; cycleIdx++) {
        const frameNumber = cycle[cycleIdx] ?? 0;
        frames.push({
          direction: dirIdx,
          directionLabel,
          cycleIndex: cycleIdx,
          frameNumber,
          x: frameNumber * FRAME_SIZE,
          y: rowPx,
          width: FRAME_SIZE,
          height: FRAME_SIZE,
        });
      }
    }

    animations[meta.value] = {
      name: meta.value,
      label: meta.label,
      row,
      rows: directions,
      directions,
      columns: STANDARD_ANIMATION_FRAMES_PER_ROW,
      cycle,
      frames,
    };

    runningRow += directions;
    sheetRows += directions;
  }

  // For selective export, recompute sheetHeight from the packed rows; for
  // full sheet, trust the caller-provided height (matches the actual PNG).
  const isSelective = !!(
    opts.includedAnimations && opts.includedAnimations.length > 0
  );
  const sheetHeight = isSelective ? sheetRows * FRAME_SIZE : opts.sheetHeight;

  return {
    pngFilename: opts.pngFilename,
    ...(opts.pngBytes !== undefined ? { pngBytes: opts.pngBytes } : {}),
    sheetWidth: opts.sheetWidth,
    sheetHeight,
    frameWidth: FRAME_SIZE,
    frameHeight: FRAME_SIZE,
    frameColumns: STANDARD_ANIMATION_FRAMES_PER_ROW,
    frameRows: DIRECTIONS.length,
    directions: DIRECTIONS.slice(),
    bodyType: opts.bodyType,
    generatedAt: now.toISOString(),
    ...(includedOrder && includedOrder.length > 0
      ? { includedAnimations: includedOrder }
      : {}),
    animations,
  };
}

/**
 * Helper to derive a JSON-friendly filename from the same tag logic used by
 * AgentApp: `character-<tag>-<ts>.png`. Pure — no DOM.
 */
export function makePngFilename(tag: string, ts: number = Date.now()): string {
  return `character-${tag}-${ts}.png`;
}

/** Sidecar JSON filename: same basename as the PNG, .json extension. */
export function makeMetaFilename(pngFilename: string): string {
  return pngFilename.replace(/\.png$/i, ".json");
}
