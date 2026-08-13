# Agent 页面导出 PNG + 切割元数据 JSON

## Summary

在 `agent.html` 的"下载 PNG"流程里，除了当前的 `character-<tag>-<timestamp>.png` 之外，同时落一份同名同前缀的 `character-<tag>-<timestamp>.json`。该 JSON 描述：

1. PNG 自身的网格切割方式（帧尺寸、列数、行数、每个动作占据哪几行）。
2. 每个动作 → 索引到的图片行（按方向拆开）。

> 文件名约定：`character-full-<时间戳>.png` / `character-full-<时间戳>.json`（全动作大表）或 `character-idle_walk-<时间戳>.png` / `...json`（NPC 精简版）。
>
> 用户已确认：仍然走浏览器原生下载（`a.click()`），把 PNG 与 JSON 同时塞进浏览器的默认下载目录；建议把该目录配置到 `outPng/`（或由用户手动归集）。本次改动不引入后端写文件。

---

## Current State Analysis

通过 Phase 1 探索得到的关键事实：

1. **现有 PNG 导出入口**：
   - `sources/agent/AgentApp.ts` 的 `onDownload` 函数（[AgentApp.ts#L214-L233](file:///d:/work/work/git/tools/Spritesheet-Character-Generator/sources/agent/AgentApp.ts#L214-L233)）通过 `canvas.toBlob(...)` + `URL.createObjectURL` + `a.click()` 触发浏览器下载，文件名为 `character-<tag>-${Date.now()}.png`。
   - `tag` 在选择性导出时为动作名列表（用 `_` 连接，例如 `idle_walk`），全表导出时为 `full`。
2. **动画元数据来源**：
   - `sources/state/constants.ts` 定义了 `ANIMATIONS`、`ANIMATION_OFFSETS`、`ANIMATION_CONFIGS`、`FRAME_SIZE` 等关键常量 ([constants.ts#L60-L154](file:///d:/work/work/git/tools/Spritesheet-Character-Generator/sources/state/constants.ts#L60-L154))。
   - 每个动作的 `row` 是 **起始行号**（每行 4 方向 / 13 帧，64×64 px）。
   - 每个动作的 `num` 是方向数（通常 4，部分单方向动作如 `hurt`/`climb` 是 1）。
   - `cycle` 数组给出动作的关键帧顺序。
3. **Agent 选择性导出**：
   - `AgentPreview.ts` 的 `downloadDialog` 允许用户勾选要打包的动作，传 `selectedAnimations` 给 `onDownload` 回调。
   - `AgentSession.getCanvasForAnimations()` 调用 `extractSelectedAnimations(animations, canvas)` 裁剪出只包含指定行的紧凑 canvas。
4. **辅助工具**：
   - `canvas/download.ts` 已实现通用的 `downloadAsPNG` 与 `downloadFile(filename, type)`，可直接复用。
5. **现状缺口**：
   - 当前下载只落 PNG，没有元数据。下游消费者（自研引擎、Phaser/PixiJS、Unity 自定义 importer）需要额外的 meta JSON 才能正确切片播放。
   - 没有公共函数把 ANIMATIONS 配置 → JSON-friendly 数据结构。

---

## Proposed Changes

### 1. 新增切割元数据生成器 — `sources/agent/spritesheet-meta.ts`

**Why**: 把"动画常量 → JSON"集中在一处，避免散落在组件里；保持纯函数，可被 Node 单测覆盖。

**核心 API**：

```ts
export interface SpriteFrame {
  /** 该动作方向索引（0..num-1）。hurt/climb 这类单方向动作始终 0。 */
  direction: number;
  /** 方向名（up/left/down/right，仅当 num=4 时给出；其它给 "single"）。 */
  directionLabel: string;
  /** 在 cycle 数组里的位置（0..cycle.length-1）。 */
  cycleIndex: number;
  /** cycle 数组里这一帧的具体帧编号（在 13 列宽里第几列）。 */
  frameNumber: number;
  /** 像素坐标。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SpriteAnimationMeta {
  name: string;
  label: string;
  /** sheet 上起始 row。 */
  row: number;
  /** 占用 row 数（= num，因为每个方向占 1 row）。 */
  rows: number;
  /** 方向数。 */
  directions: number;
  /** 帧列宽 = STANDARD_ANIMATION_FRAMES_PER_ROW = 13。 */
  columns: number;
  /** 实际使用的 cycle 帧列表（按 cycleIndex 顺序）。 */
  cycle: number[];
  /** 所有单帧展开（含每个方向）。 */
  frames: SpriteFrame[];
}

export interface SpritesheetMeta {
  /** PNG 文件名（不含路径），方便消费者对照文件查找。 */
  pngFilename: string;
  /** PNG 字节大小（如果可拿到）。 */
  pngBytes?: number;
  /** 整张大表宽 / 高。 */
  sheetWidth: number;
  sheetHeight: number;
  /** 单帧像素尺寸（FRAME_SIZE）。 */
  frameWidth: number;
  frameHeight: number;
  /** 帧列数（STANDARD_ANIMATION_FRAMES_PER_ROW）。 */
  frameColumns: number;
  /** 单方向行数（DIRECTIONS.length = 4）。 */
  frameRows: number;
  /** "up" / "left" / "down" / "right" 顺序。 */
  directions: string[];
  /** Body type（male / female / …）。 */
  bodyType: string;
  /** 生成时间 ISO。 */
  generatedAt: string;
  /** 选择性导出时实际打包进来的动作列表（full 时为 null / undefined）。 */
  includedAnimations?: string[];
  /** 每个动作的元数据。key = animation name（spellcast / walk / …）。 */
  animations: Record<string, SpriteAnimationMeta>;
}

/**
 * Build spritesheet meta from a list of included animation names.
 *  - `included` 为 undefined / 空数组：返回完整大表的元数据（按 ANIMATIONS 常量）。
 *  - `included` 给定：返回那些动作的元数据，并修正 sheetHeight = rows × FRAME_SIZE。
 *    y 坐标按紧凑排列重新计算。
 */
export function buildSpritesheetMeta(opts: {
  pngFilename: string;
  pngBytes?: number;
  sheetWidth: number;
  sheetHeight: number;
  bodyType: string;
  includedAnimations?: string[];
}): SpritesheetMeta;
```

**实现要点**：

- `FRAME_SIZE` / `STANDARD_ANIMATION_FRAMES_PER_ROW` / `ANIMATIONS` / `ANIMATION_OFFSETS` / `ANIMATION_CONFIGS` / `DIRECTIONS` 直接来自 `sources/state/constants.ts`。
- `buildSpritesheetMeta` 内部流程：
  1. 过滤 `ANIMATIONS`（去除 `noExport: true` 的内部动作如 `watering`、`1h_slash`），按 `ANIMATION_OFFSETS` 排序。
  2. 如果 `includedAnimations` 提供，再按用户勾选的顺序过滤，并按"用户在对话框里勾选的顺序"输出。
  3. 重新分配 y 坐标：完整大表用 `ANIMATION_OFFSETS`；选择性导出时 y = sum(prev.rows) * FRAME_SIZE。
  4. 对每个动作遍历 cycle → 输出 `frames` 数组（含方向、cycleIndex、frameNumber、x、y、w、h）。
  5. 跳过 `noExport: true` 的动作（`watering`、`1h_slash`）—— 与 `AgentPreview` 的 `exportable` 过滤保持一致。

### 2. 复用现有 `downloadFile` 实现 JSON 下载 — `sources/agent/AgentApp.ts`

**改动**：

- 在 `AgentApp.ts` 顶部 import `buildSpritesheetMeta` 与 `downloadFile`（从 `canvas/download.ts`）。
- 在 `onDownload(vnode, selectedAnimations)` 里：
  1. 维持现有 PNG 下载逻辑不变。
  2. 拿到 PNG blob 后，用 `blob.size` / `blob.arrayBuffer()` 拼出 PNG 文件名 + 字节大小。
  3. 拼出 `metaFilename = pngFilename.replace(/\.png$/i, ".json")`。
  4. 调 `buildSpritesheetMeta({...})` 得到元数据 JSON。
  5. 调 `downloadFile(JSON.stringify(meta, null, 2), metaFilename, "application/json")`。

**新的文件命名约定**（与现状一致，仅切换实现路径）：

```
character-full-<ts>.png          # 全动作大表
character-full-<ts>.json
character-idle_walk-<ts>.png     # 选择性导出（动作名按 _ 拼接，去重，保持勾选顺序）
character-idle_walk-<ts>.json
character-thrust_walk_idle-<ts>.png
character-thrust_walk_idle-<ts>.json
```

`<ts>` 复用 `Date.now()`。

> 用户已选择"仍走浏览器下载"，文件落到浏览器默认下载目录。建议在 README 或页面内提示用户把浏览器的默认下载目录配置到 `d:\work\work\git\tools\Spritesheet-Character-Generator\outPng\`，或在浏览器弹出的保存对话框里手动选择该目录。

### 3. 测试 — `tests/agent/spritesheet-meta_spec.js`

新增 Vitest/Node 测试（沿用 `tests/agent/` 现有结构）：

- `tests/agent/spritesheet-meta_spec.js`：
  - 完整大表（includedAnimations=undefined）→ 17 个动作（去掉 watering / 1h_slash），sheetHeight = 54 * 64 = 3456。
  - 选择性导出 `["idle", "walk"]` → sheetHeight = 2 * 4 * 64 = 512，frame.y 与重新计算一致。
  - `noExport` 的 `watering` 与 `1h_slash` 不出现在结果里。
  - `bodyType`、生成时间、PNG 字节数都正确写入。
  - 选择性导出动作顺序与传入顺序一致。
  - `cycleIndex` 与 `frameNumber` 正确映射。
  - 单方向动作（`hurt`/`climb`）的 `directionLabel = "single"`。

> 在 `package.json` 已有的 `agent:test` 脚本里追加这个文件：
> `"agent:test": "node --test tests/agent/tools_spec.js tests/agent/agent-handler_spec.js tests/agent/spritesheet-meta_spec.js"`

### 4. 关键文件清单

新增：

- `sources/agent/spritesheet-meta.ts` — 元数据生成器。
- `tests/agent/spritesheet-meta_spec.js` — 测试。

修改：

- `sources/agent/AgentApp.ts` — `onDownload` 加 JSON 落盘。
- `package.json` — `agent:test` 脚本加新文件。

---

## Assumptions & Decisions

1. **继续走浏览器原生下载**：用户已选；不引入后端写文件、不引入 `file-system-access` API（兼容性差）。将默认文件名清晰化（`character-*.png` + `character-*.json`），用户可手动归集到 `outPng/`。
2. **JSON 与 PNG 文件名同名同前缀**：便于消费端通过 `find -name '*.json'` 关联。
3. **JSON 是「每动作一行」结构**：用户已选；每个动作给出 `row`/`rows`/`directions`/`columns`/`cycle`/`frames` 字段，下游可直接生成 (x, y, w, h) 切片。
4. **选择性导出时重新计算 y 坐标**：与 `extractSelectedAnimations` 实际产出的紧凑 PNG 像素位置一一对应。
5. **去除 `noExport` 的内部动作**：与现有 UI 对话框 `exportable` 过滤一致；避免下游引用到不存在的 row。
6. **不动现有服务端 Agent API**：`render_spritesheet` 工具返回里只增加可选的 `meta` 字段（json 字符串），让命令行消费者也能拿到。先不做这一项，等 UI 稳定后再加。
7. **不改 `canvas/download.ts`**：复用 `downloadFile(content, filename, type)`。
8. **不在前端 UI 里加新按钮**：保持现有"下载 PNG"按钮文字，但页面 footer 加一行提示"会同时下载 .json 元数据"。

---

## Verification

实施完成后，按以下步骤验证：

1. **单测**：`npm run agent:test` 通过，新加的 `spritesheet-meta_spec.js` 全部绿。
2. **本地起 dev server**：`npm run dev` → 打开 `http://localhost:5173/agent.html`：
   - 输入"给我一个法师走两步" → 等渲染完成 → 点"下载 PNG…" → 全选"完整大表" → 确认。
   - 浏览器下载目录应有：
     ```
     character-full-<ts>.png
     character-full-<ts>.json
     ```
   - 打开 JSON，校验：
     - `sheetWidth = 832`、`sheetHeight = 3456`、`frameWidth = frameHeight = 64`、`frameColumns = 13`。
     - `animations` 含 17 个 key（spellcast/thrust/walk/slash/shoot/hurt/climb/idle/jump/sit/emote/run/combat/1h_backslash/1h_halfslash/）。
     - `spellcast.frames[0].x === 0`、`spellcast.frames[0].y === 0`、`walk.frames[0].x === 64`、`walk.frames[0].y === 512`。
3. **选择性导出**：
   - 再次点"下载 PNG…" → 选 "NPC (待机+走)" 预设 → 确认。
   - 下载得到：
     ```
     character-idle_walk-<ts>.png
     character-idle_walk-<ts>.json
     ```
   - JSON 里 `includedAnimations = ["idle", "walk"]`、`sheetHeight = 512`（2 动作 × 4 方向 × 64）、`idle.frames[0].y === 0`、`walk.frames[0].y === 256`。
4. **回归**：
   - 主页 `index.html` 不受影响。
   - 现有 `AgentPreview` 的 `onDownload(selectedAnimations)` 签名不变（不破坏现有 `AgentPreview` 调用点）。
   - `AgentApp` 之外没有改动。

---

## Open Questions

无（用户已对导出机制和 JSON 结构做出选择）。