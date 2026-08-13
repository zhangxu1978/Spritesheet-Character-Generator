// server/bundle-handler.mjs
//
// 后端"打包"接口 — 把首页真正需要的东西一次性返回,让浏览器少发请求。
//
//   GET /api/healthz
//     → { ok: true, uptimeSec, mem }
//
//   GET /api/bundle/:characterId
//     → 默认角色需要的 sprite 列表(由 sheet_definitions/body/body.json
//       + spritesheets/ 真实目录派生);前端拿到后批量预拉(浏览器复用同
//       一 HTTP 连接),而不是首页挂载后让 renderer.ts 一个个拉 PNG。
//
// 所有响应都附 ETag/Last-Modified,304 走强缓存路径,后续请求近零成本。
//
// 注:metadata 不在这里合并,因为 vite build 产物里的 chunk 变量名已经被
// rolldown 改写,直接正则解析脆弱。前端走原来的 5 个 chunk import 即可。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// body sheet 定义 — 默认角色只从这一份派生 sprite 列表
const BODY_DEFINITION = path.join(ROOT, "sheet_definitions", "body", "body.json");
const SPRITESHEET_ROOT = path.join(ROOT, "spritesheets");
const DIST_ROOT = path.join(ROOT, "dist", "spritesheets");

/** 探测 sprite 文件位置:dev 模式在 root/spritesheets,prod 在 dist/spritesheets。 */
function resolveSpritePath(relPath) {
  const clean = relPath.replace(/^\/+/, "");
  const candidates = [
    path.join(DIST_ROOT, clean),
    path.join(SPRITESHEET_ROOT, clean),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// ETag / 缓存
// ────────────────────────────────────────────────────────────────────────────

const STAT_CACHE = new Map(); // filePath → { mtimeMs, size }

function fileStat(filePath) {
  const cached = STAT_CACHE.get(filePath);
  if (cached) return cached;
  try {
    const s = fs.statSync(filePath);
    const sig = { mtimeMs: s.mtimeMs, size: s.size };
    STAT_CACHE.set(filePath, sig);
    return sig;
  } catch {
    return null;
  }
}

function etagFor(stat) {
  // W/ 弱 ETag 就够,内容由 mtime+size 决定,远端不会被改
  return `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
}

function writeCachedJson(res, body, stat) {
  const json = JSON.stringify(body);
  const buf = Buffer.from(json, "utf8");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=60, must-revalidate");
  res.setHeader("ETag", etagFor(stat));
  res.setHeader("Last-Modified", new Date(stat.mtimeMs).toUTCString());
  res.setHeader("X-Bundle-Size", String(buf.length));
  res.end(buf);
}

function writeNotModified(res, req, stat) {
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch && ifNoneMatch === etagFor(stat)) {
    res.statusCode = 304;
    res.end();
    return true;
  }
  const ifModifiedSince = req.headers["if-modified-since"];
  if (ifModifiedSince) {
    const sinceMs = Date.parse(ifModifiedSince);
    if (!Number.isNaN(sinceMs) && Math.floor(stat.mtimeMs) <= sinceMs) {
      res.statusCode = 304;
      res.end();
      return true;
    }
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// /api/healthz
// ────────────────────────────────────────────────────────────────────────────

const START_TIME = Date.now();

function handleHealthz(req, res) {
  const mem = process.memoryUsage();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    JSON.stringify({
      ok: true,
      uptimeSec: Math.round((Date.now() - START_TIME) / 1000),
      mem: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapMb: Math.round(mem.heapUsed / 1024 / 1024),
      },
      node: process.version,
    }),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// /api/bundle/:characterId
// ────────────────────────────────────────────────────────────────────────────

/**
 * 推导"默认角色"实际需要的 sprite 路径。
 *
 * 真实目录约定:
 *   spritesheets/body/bodies/<bodyType>/<anim>.png
 *   spritesheets/torso/clothes/<item>/<bodyType>/<anim>.png
 *   ...
 *
 * 默认 bodyType = "male",默认 animations = body.json.animations。
 * 之所以用 `fs.readdir` 扫目录而不是从 catalog JSON 推,是因为 catalog 是
 * 浏览器侧 chunk 化的,后端拿不到,而这里我们只要"会用到"的清单。
 */
async function loadDefaultSpriteList() {
  // 1) 读 body.json,得到默认 bodyType + 默认动画集
  let anims = [];
  let bodyType = "male";
  try {
    const raw = await fsp.readFile(BODY_DEFINITION, "utf8");
    const def = JSON.parse(raw);
    anims = Array.isArray(def.animations) ? def.animations : [];
    if (def.layer_1 && typeof def.layer_1 === "object") {
      // 选第一个 bodyType
      const firstKey = Object.keys(def.layer_1).find(
        (k) => k !== "zPos" && k !== "custom_animation",
      );
      if (firstKey) bodyType = firstKey;
    }
  } catch {
    // body.json 缺失时退回到最小集
    anims = [
      "spellcast",
      "thrust",
      "walk",
      "slash",
      "shoot",
      "hurt",
      "idle",
      "jump",
      "run",
      "sit",
      "emote",
      "climb",
      "combat",
    ];
  }

  // 2) 列举 body/bodies/<bodyType>/ 下所有 png
  const baseDir = path.join(SPRITESHEET_ROOT, "body", "bodies", bodyType);
  let files = [];
  try {
    files = await fsp.readdir(baseDir);
  } catch {
    files = [];
  }
  files = files.filter((f) => f.endsWith(".png"));

  const sprites = files.map((file) => {
    const anim = file.replace(/\.png$/, "");
    return {
      key: `body/${bodyType}/${anim}`,
      path: `body/bodies/${bodyType}/${file}`,
      animation: anim,
      layer: 0,
    };
  });

  // 3) 加上一个静态 shadow(每个 body 都有),让首屏一上来就有"画布"
  sprites.push({
    key: `shadow/${bodyType}/idle`,
    path: `shadow/${bodyType}/idle.png`,
    animation: "idle",
    layer: 0,
  });

  return sprites;
}

let bundleCache = new Map(); // characterId → { payload, stat }

async function buildBundlePayload(characterId) {
  if (bundleCache.has(characterId)) return bundleCache.get(characterId);

  const sprites = await loadDefaultSpriteList();
  // 用 sprite 文件 stat 的最大值作为 bundle 的 ETag 签名
  const statResults = await Promise.all(
    sprites.map(async (s) => {
      const fp = resolveSpritePath(s.path);
      if (!fp) return null;
      try {
        return await fsp.stat(fp);
      } catch {
        return null;
      }
    }),
  );
  const compositeStat = {
    mtimeMs: Math.max(
      ...statResults.filter(Boolean).map((s) => s.mtimeMs),
      0,
    ),
    size: statResults.filter(Boolean).reduce((acc, s) => acc + s.size, 0),
  };

  const payload = {
    characterId,
    generatedAt: Date.now(),
    spriteCount: sprites.length,
    sprites,
    // 给前端一个 hint:每个 sprite 的字节数,方便它做 UI 进度条
    sizes: Object.fromEntries(
      sprites.map((s, i) => [s.key, statResults[i]?.size ?? 0]),
    ),
  };
  bundleCache.set(characterId, { payload, stat: compositeStat });
  return bundleCache.get(characterId);
}

async function handleBundle(req, res, characterId) {
  try {
    const { payload, stat } = await buildBundlePayload(characterId);
    if (writeNotModified(res, req, stat)) return;
    writeCachedJson(res, payload, stat);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        error: { message: e instanceof Error ? e.message : String(e) },
      }),
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 路由器
// ────────────────────────────────────────────────────────────────────────────

export async function handleBundleRoute(req, res) {
  const url = req.url ?? "/";
  const pathname = url.split("?")[0];

  if (pathname === "/api/healthz") {
    handleHealthz(req, res);
    return true;
  }

  // /api/bundle/:characterId
  const bundleMatch = pathname.match(/^\/api\/bundle\/([\w-]+)\/?$/);
  if (bundleMatch) {
    await handleBundle(req, res, bundleMatch[1]);
    return true;
  }

  // 不在 bundle 命名空间里,交给上层(agent-handler)继续处理
  return false;
}