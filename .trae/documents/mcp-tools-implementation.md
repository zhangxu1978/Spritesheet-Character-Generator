# 计划：MCP 工具服务器实施（stdio）— 序列帧图片 + 配置 JSON

## 概述

为本项目新增一个零依赖的 MCP（Model Context Protocol）stdio 服务器，让外部系统的 AI Agent（Trae / Claude Desktop / Cursor / Cline 等）可直接调用工具：
1. 浏览部件目录（分类 / 物品 / 身体类型 / 动作 / 动作推荐）
2. 生成序列帧精灵表 PNG（Node 侧无头渲染，走 vite dev server + Playwright Chromium）
3. 生成配置 JSON（帧元数据 JSON + 可回导入 Web UI 的 version-2 配置 JSON）

本计划基于已有设计文档 `.trae/documents/add-mcp-server.md`（内容已逐项与当前代码核实一致），按其实施。协议层按 MCP 规范手写 JSON-RPC 2.0 over stdio，不新增任何 npm 依赖。

## 现状分析（已验证）

- `package.json`：`"type": "module"` 纯 ESM；`agent:test` = `node --test tests/agent/tools_spec.js tests/agent/agent-handler_spec.js tests/agent/spritesheet-meta_spec.js`；Playwright 已在 devDependencies。
- `server/catalog-snapshot.mjs` `loadCatalogSnapshot()`（L50）：同步零依赖部件目录（扫描 `sheet_definitions/**/*.json`），MCP 目录类工具直接复用。
- `server/spritesheet-meta.mjs` `buildSpritesheetMeta(opts)`（L104）：纯函数生成帧元数据 JSON（帧 64×64、13 列、方向 up/left/down/right、cycle 帧序）。
- `server/agent-handler.mjs`：`ANIMATION_PRESETS` 内嵌于 `suggest_animation_preset` case（L290 起，与 `sources/agent/tools.ts` 重复），需提取共享；`applyTool()`（L276）是 Node 侧工具执行先例；`render_spritesheet` 只能返回 `deferred:true` 由浏览器重放 —— MCP 必须自建真实出图链路。
- 无头渲染先例 `scripts/issue382-golden-playwright.js`：spawn `npx vite --host 127.0.0.1 --port N --strictPort`（`shell: process.platform === "win32"`）+ `waitForHttpOk` 轮询就绪 + `chromium.launch({headless:true})` + `page.evaluate`，本计划复用该模式。
- `sources/agent/session.ts`：`AgentSession`（L137）`constructor(opts)` / `render()`（L200）/ `toBase64PngSelected(animations?)`（L247）是浏览器端渲染完整封装，runner 页面直接复用。
- `sources/state/json.ts`：version-2 配置 JSON，`importStateFromJSON` 仅必需 `version + bodyType + selections` —— Node 侧可产出可回导配置。
- `vite.config.js`：仅 build input 列了 index.html/agent.html；**dev server 自动服务仓库根任意 .html**，渲染走 dev server，故 vite.config 无需改动。
- `.gitignore` L17 已含 `mcp-output/`，无需再改。
- `server/mcp/` 与 `sources/mcp/` 空目录已存在。
- stdio 传输方式已在前一轮确认（见设计文档"关键决策"第 1 条）。

## 方案设计

### 架构

```
MCP 客户端 (Trae / Claude Desktop / Cursor / …)
  │  stdio（按行分隔的 JSON-RPC 2.0）
  ▼
server/mcp/stdio.mjs        传输层：stdin 行读取 → protocol → stdout 回写
  ├─ server/mcp/protocol.mjs   纯协议层（可单测）
  ├─ server/mcp/tools.mjs      8 个工具定义 + 处理器
  │    ├─ server/catalog-snapshot.mjs    目录类工具
  │    ├─ server/animation-presets.mjs   动作推荐（新提取）
  │    ├─ server/spritesheet-meta.mjs    帧元数据 JSON
  │    └─ server/mcp-renderer.mjs        无头渲染后端（懒启动）
  │         ├─ spawn npx vite（随机空闲端口，win32 shell:true）
  │         └─ Playwright Chromium 单页面复用
  │              └─ mcp-render.html + sources/mcp/render-main.ts
  │                   └─ 复用 sources/agent/session.ts 的 AgentSession
  └─ 进程退出钩子：关闭浏览器、杀掉 vite 子进程
```

### MCP 工具清单（8 个）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `list_categories` | – | 部件分类树 |
| `list_items` | `typeName?`, `category?`, `detailed?` | 物品列表（itemId/name/variants） |
| `get_item` | `itemId` | 单物品元数据 |
| `list_body_types` | – | male/female/teen/child/muscular/pregnant |
| `list_animations` | – | 全部可导出动作 |
| `suggest_animation_preset` | `role?` | 按角色定位推荐动作清单（摆件/村民/BOSS/玩家…） |
| `build_config` | `bodyType?`, `selections?`, `animations?` | 只产出配置 JSON（校验 + 补全默认三件套 body/heads/expression），不渲染 |
| `generate_spritesheet` | `bodyType?`, `selections?`, `animations?`, `includeImage?`, `outputDir?`, `filePrefix?` | 校验 → 无头渲染 PNG → 帧元数据 JSON + 配置 JSON；`outputDir` 传入则写盘返回路径 |

`generate_spritesheet` 返回：
- content[0]：`{type:"image", data:<base64>, mimeType:"image/png"}`（`includeImage:false` 时省略；工具描述引导 NPC 类角色传 `animations` 子集以减小体积）
- content[1]：`{type:"text"}` JSON 摘要（文件路径、尺寸、includedAnimations）
- `structuredContent`：`{ config, meta, files }`

### 渲染后端细节（server/mcp-renderer.mjs）

- 懒启动：首次 `generate_spritesheet` 才启动 vite + Chromium，后续复用。
- 端口：`net.createServer().listen(0)` 取随机空闲端口；spawn `shell: process.platform === "win32"`（沿用 issue382 模式）。
- 就绪探测：轮询 `GET http://127.0.0.1:N/mcp-render.html` 至 200（上限 30s）。
- Chromium 单例 + 单页面复用；每次渲染 `page.evaluate((cfg) => window.__MCP_RENDER__(cfg), config)` 直接 await 返回。
- 串行化：promise 队列，一次一个渲染。
- 超时：首次渲染（含页面加载）120s，后续 60s；失败销毁页面重建，错误透传。
- 清理：`shutdown()` 关浏览器 + 杀 vite；挂 `process.on("exit"/"SIGINT"/"SIGTERM")`。
- runner 页面 `window.__MCP_RENDER__(cfg)`（sources/mcp/render-main.ts）：
  1. `new AgentSession({selections, bodyType, animation})`（空 selections 时 session 自带默认三件套）
  2. `await session.render()`
  3. `session.toBase64PngSelected(animations)` 得 base64 + 尺寸 + includedAnimations
  4. 返回 `{base64, width, height, fullWidth, fullHeight, includedAnimations}`

## 变更文件清单

### 新建

| 文件 | 内容 |
| --- | --- |
| `server/animation-presets.mjs` | 从 agent-handler.mjs L290-337 提取 `ANIMATION_PRESETS` + `suggestAnimationPresetData(role)` 纯函数 |
| `server/mcp/protocol.mjs` | 纯函数 `handleMessage(state, msg, ctx)`：initialize（回显客户端 protocolVersion，缺省 "2025-06-18"）、`notifications/initialized`、ping、tools/list、tools/call（异常 → isError result）；未知带 id 方法 → -32601；通知 → null；解析失败 → -32768/-32600；容忍数组批量消息 |
| `server/mcp/tools.mjs` | 8 个工具 JSON Schema + handler；`validateConfig()`（bodyType 白名单、itemId 存在性校验 via catalog-snapshot、animations 白名单、补全默认三件套）；文件写盘（mkdir -p、png/meta/config 三文件） |
| `server/mcp/stdio.mjs` | 入口：readline 逐行读 stdin → JSON.parse → handleMessage → 非 null 响应写 stdout；日志全走 stderr；注册退出清理 |
| `server/mcp-renderer.mjs` | 无头渲染后端（如上） |
| `mcp-render.html` | 仓库根，仿 agent.html 的极简加载壳 |
| `sources/mcp/render-main.ts` | 定义 `window.__MCP_RENDER__`，复用 AgentSession |
| `tests/agent/mcp-protocol_spec.js` | 协议握手 / tools-list / 未知方法 / 通知 / build_config 校验与默认补全 / 工具错误路径 |
| `tests/agent/mcp-stdio_spec.js` | 真实 spawn 子进程走 initialize + tools/list（验证 stdio 帧） |

### 修改

| 文件 | 变更 |
| --- | --- |
| `server/agent-handler.mjs` | `ANIMATION_PRESETS` 改为从 `server/animation-presets.mjs` 导入（行为不变，消除第三份重复） |
| `package.json` | scripts 增加 `"mcp": "node server/mcp/stdio.mjs"`；`agent:test` 追加两个新 spec |

### 不改动

- 现有 `/api/agent/*`、agent.html、sources/agent/*（MCP 是独立并行通道）
- vite.config.js（渲染走 dev server，根目录 html 自动服务）
- .gitignore（`mcp-output/` 已存在）
- 不新增任何 npm 依赖

## 关键决策与假设

1. 传输仅 stdio（前轮已确认）；HTTP MCP 未来可在 server/index.mjs 叠加，不在本次范围。
2. 零依赖手写 JSON-RPC 2.0，延续 server 端零依赖哲学；协议面小而稳定（initialize/tools/ping）。
3. 协议版本协商：initialize 响应回显客户端请求的 protocolVersion（缺省 "2025-06-18"）。
4. 渲染走 vite dev server 而非 dist 静态文件：与 issue382 黄金链路同模式，源码即用、无需先 build；代价是首次渲染多 1–3s（懒启动可接受）。
5. 配置 JSON 不含 layers/credits：Node 侧拿不到渲染 draw-calls 层信息；version-2 导入仅必需 version/bodyType/selections，回导无影响。
6. item 校验：Node 侧校验 itemId 存在于 catalog 快照；variant/recolor 为可选字符串透传。
7. stdout 纯净：MCP 进程所有日志/子进程输出一律 stderr，防协议污染。
8. 图片内联体积：完整大表 base64 可达 MB 级；工具描述引导 Agent 对 NPC/小怪传 `animations` 子集。

## 验证步骤

1. `npm run agent:test` — 全部通过（含新增 mcp-protocol / mcp-stdio spec，既有 agent-handler spec 在 presets 提取后仍通过）。
2. `npm run lint` — 无新告警。
3. 手动冒烟（渲染链路）：向 `node server/mcp/stdio.mjs` 的 stdin 写入 initialize → tools/list → tools/call `generate_spritesheet`（bodyType=female + 若干 selections + animations:[idle,walk] + outputDir=tmp/mcp-smoke），确认：
   - stdout 返回 image content + structuredContent；
   - `tmp/mcp-smoke/` 下生成 `.png` / `.json`（帧元数据）/ `.config.json`（配置）三个文件；
   - PNG 尺寸 = 832 × 行数×64（2 动作 × 4 方向 = 8 行 → 832×512）。
4. Web UI「导入 JSON」加载 `.config.json`，确认外观一致。
5. MCP 客户端注册验证：

```json
{ "mcpServers": { "lpc-spritesheet": { "command": "node", "args": ["<仓库绝对路径>/server/mcp/stdio.mjs"] } } }
```

确认工具列表出现 8 个工具并能完成一次「列物品 → 生成精灵表」调用。

## 实施偏差记录（实施后回填）

### 偏差 1：渲染后端从「vite dev server」改为「vite build API 最小打包 + 进程内静态服务器」

原计划的 dev server 方案在本机不可用：`vite.config.js` 中 `getSpritesheetsPlugin("serve")` 返回的
`vite-multiple-assets`（DynamicPublicDirectory）在 dev 启动时对 ~88,000 个 spritesheet 文件逐个做
mapper/micromatch 处理，`createServer` 阶段实测阻塞 6–15 分钟（干净单进程环境下复现），任何合理的
就绪超时都无法覆盖。二分定位过程见下「排查记录」。

新方案（server/mcp-renderer.mjs）：

1. 一次性用 `vite build` API + **内联最小配置**（`configFile: false`，仅含
   `itemMetadataResolveAliases` 别名 + `itemMetadataPlugins("build")` 元数据新鲜度插件）把
   `mcp-render.html` 打包到 `tmp/mcp-render-dist/`（产物 9 个文件，几十秒内完成）；
   完全绕开慢插件。产物缺失或 `MCP_REBUILD=1` 时才重建。
2. 进程内 `node:http` 静态服务器（随机空闲端口）：`/` → 渲染包，`/spritesheets/*` → 仓库
   spritesheets/ 目录（无需 robocopy 拷贝 8.8 万文件）。
3. Playwright Chromium 单页面复用、渲染串行化、失败重建页面 —— 与原计划一致。

连带修正：`.gitignore` 无需改动（tmp/、mcp-output/ 均已忽略）。

### 偏差 2：新增「recolor 缺省补全」（sources/mcp/render-main.ts normalizeSelectionRecolors）

冒烟测试发现：Web UI 里 `selection.recolor` 永远有值（树控件点选颜色时必然传入），而 MCP 调用方
传 `recolor: null` 时，`getMultiRecolors` 返回 null → `getSpritePath` 退化为「变体文件名」路径
（如 `hair/afro/adult/walk/afro.png`），对磁盘上扁平布局的调色板类物品（真实文件为
`hair/afro/adult/walk.png`）全部 404，角色只剩默认三件套。

修复：渲染入口在调用 AgentSession 前对 recolor 能力物品（有 recolors 且未指定 recolor/variant）
按调色板默认色补全（parseRecolorKey 取 base → 依次候选用 fixMissingRecolor 校验），并把归一化后
的 `normalizedSelections` 回传给 tools.mjs 用于导出配置 —— 保证导出的配置在 Web UI「导入 JSON」
后渲染一致（与本 UI 自己保存的配置形态完全相同）。

### 偏差 3：eslint 配置补充 `**/*.mjs` 的 Node globals

仓库既有缺口：node globals 只配给了 `**/*.js`（不匹配 .mjs），导致 server/*.mjs 全部报 no-undef
（server/index.mjs、agent-handler.mjs 等既有文件同样报错，`npm run lint` 本就处于失败态）。新增
一个仅声明 globals、不启用新规则的 `**/*.mjs` 配置块，覆盖本次新文件并顺带修复同类既有报错。
既有失败项中与本次无关的（tools_spec.js、vite-plugin-agent-api.js 的 prettier 格式、agent-handler
的 no-case-declarations 等）保持原样，未越界修复。

### 排查记录（为何放弃 dev server 方案）

1. 初次冒烟：stdio 服务器正常，`generate_spritesheet` 在等 vite 就绪 30s 超时。
2. 手动 `npx vite`：进程存活、端口从不监听、零输出 —— 卡在 createServer。
3. `configFile: false` 程序化启动：478ms 即就绪 → 挂点在项目插件。
4. 导入 vite.config.js 本身：860ms → 挂点在插件钩子而非模块加载。
5. 插件二分：前一半（preview-serve / item-metadata / modulepreload / bundled-css）51ms 通过；
   后一半再细分 → 单独 `dynamic assets`（vite-multiple-assets）即挂。
6. 独立计时 fast-glob 同模式扫描 8.8 万文件仅 3.8s → 排除扫描，确认为插件内逐文件 mapper 病态循环。
7. 干净单进程复测：>6 分钟未完成（此前带竞争时 15.5 分钟后才监听）。结论：dev server 方案废弃。
