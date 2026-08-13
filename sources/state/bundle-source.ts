/**
 * 后端 bundle 接口适配层 — 仅负责"预热默认角色 sprite"。
 *
 * 设计要点:
 *   1. 行为等价:`loadAllMetadata()` 不变,这条路径只动 sprite 预热。
 *   2. 后端优先:`/api/bundle/:characterId` 拿到 sprite 列表后批量预拉 +
 *      预解码,渲染器 `loadImage()` 直接命中缓存。
 *   3. 强缓存:ETag 命中后 bundle 列表几乎零成本。
 *
 * 注:metadata 的合并放在后端不稳定(rolldown 改写变量名),所以本路径
 * 只承担 sprite 预热;metadata 走原来的 5 个 chunk 并行 import。
 */

import { debugLog, debugWarn } from "../utils/debug.ts";

const BUNDLE_URL = (id: string) => `./api/bundle/${encodeURIComponent(id)}`;

/**
 * 拉默认角色的 sprite 清单。前端拿到后,可以一次性把所有 PNG 用
 * HTTP/2 multiplexing 预拉,而不是 renderer.ts 渲染时再一个个 fetch。
 *
 * 返回 null 表示后端不可用,调用方继续走原 loadImage 路径。
 */
export async function fetchSpriteList(
  characterId: string,
): Promise<{ key: string; path: string }[] | null> {
  try {
    const t0 = performance.now();
    const res = await fetch(BUNDLE_URL(characterId));
    if (!res.ok) return null;
    const data = await res.json();
    const dt = Math.round(performance.now() - t0);
    debugLog(
      `[bundle] sprite list for "${characterId}" loaded in ${dt}ms ` +
        `(${data.spriteCount} sprites, ${data.sprites?.length ?? 0} entries)`,
    );
    if (!Array.isArray(data.sprites)) return null;
    return data.sprites.map((s: { key: string; path: string }) => ({
      key: s.key,
      path: s.path,
    }));
  } catch (e) {
    debugWarn(
      `[bundle] sprite list fetch failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
}

/** 预热一串 sprite PNG:把资源灌进浏览器 HTTP 缓存并显式解码。
 *  之后 `loadImage(src)` 直接命中,首屏渲染不再阻塞。 */
export async function preloadSprites(
  sprites: { path: string }[],
): Promise<number> {
  if (!Array.isArray(sprites) || sprites.length === 0) return 0;

  // 用 URL 对象解析,避免 ./ 之类相对路径在 fetch 中出问题
  const baseUrl = new URL("./", location.href);
  const urls = sprites.map((s) => new URL(s.path, baseUrl).toString());

  // 1) fetch 走浏览器缓存,让响应进入 HTTP 缓存层
  await Promise.all(
    urls.map(async (url) => {
      try {
        await fetch(url, { credentials: "same-origin" });
      } catch {
        /* 单个失败不致命 */
      }
    }),
  );

  // 2) 创建 Image 并显式 decode,让后续 drawImage 同步可用
  let decoded = 0;
  await Promise.all(
    urls.map(async (url) => {
      try {
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        await img.decode().catch(() => {});
        decoded++;
      } catch {
        /* 单个失败不致命 */
      }
    }),
  );
  return decoded;
}

export const DEFAULT_CHARACTER_ID = "default";