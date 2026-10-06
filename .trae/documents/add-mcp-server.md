# 计划：为精灵表生成器增加 MCP 工具（stdio）

## 概述

新增一个零依赖的 MCP（Model Context Protocol）stdio 服务器，让外部系统的 AI Agent（Trae / Claude Desktop / Cursor / Cline 等本地 MCP 客户端）可以直接调用本项目的工具来：

1. 浏览部件目录（分类 / 物品 / 身体类型 / 动作）
2. 生成序列帧精灵表 PNG（真正的 Node 侧无头渲染，不再依赖浏览器重放）
3. 生成配置 JSON（帧元数据 JSON + 可回导入 Web UI 的 version-2 配置 JSON）

不引入任何 npm 依赖（延续本仓库 server 端零依赖哲学），协议层按 MCP 规范手写 JSON-RPC 2.0 over stdio。

## 现状分析

* 已有 `server/agent-handler.mjs` 提供 `/api/agent/*` HTTP 工具（tools/run/chat），但 `render_spritesheet` 在 Node 侧返回 `deferred:true`，渲染只能由浏览器重放完成 —— MCP 必须解决 Node 侧真实出图。

* `server/catalog-snapshot.mjs` 的 `loadCatalogSnapshot()` 提供同步、零依赖的部件目录视图（扫描 `sheet_definitions/**/*.json`），可直接复用。

* `server/spritesheet-meta.mjs` 的 `buildSpritesheetMeta()` 是纯函数，可在 Node 直接生成帧元数据 JSON（每帧 x/y/width/height、行号、方向、循环帧序）。

* `scripts/issue382-golden-playwright.js` 已验证「spawn vite dev server（win32 下 shell:true）+ Playwright Chromium + runner 页面」的无头渲染模式，本计划复用该模式。

* `sources/agent/session.ts` 的 `AgentSession`（render / toBase64PngSelected / selections 处理）是浏览器端渲染的完整封装，runner 页面直接复用它。

* `sources/state/json.ts` 定义官方配置 JSON（version 2）；`importStateFromJSON` 仅要求 `version + bodyType + selections`，layers/credits 为可选元数据 —— Node 侧无需浏览器上下文即可产出可回导的配置 JSON。

* `server/agent-handler.mjs` 内嵌了 `ANIMATION_PRESETS` 动作推荐表（与 `sources/agent/tools.ts` 重复了一份），需要提取共享避免第三份重复。

* 测试采用 `node --test`（`tests/agent/*_spec.js`，`npm run agent:test`）。

* 服务端日志不能写 stdout（会污染 stdio 协议通道），一律走 stderr。

## 方案设计

### 架构

```
MCP 客户端 (Trae / Claude Desktop / Cursor / …)
  │  stdio（按行分隔的 JSON-RPC 2.0）
  ▼
server/mcp/stdio.mjs        传输层：stdin 行读取 → protocol → stdout 回写
  ├─ server/mcp/protocol.mjs   纯协议层（可单测）：initialize / tools/list / tools/call / ping
  ├─ server/mcp/tools.mjs      工具定义 + 处理器（8 个工具）
  │    ├─ server/catalog-snapshot.mjs    目录类工具
  │    ├─ server/animation-presets.mjs   动作推荐
  │    ├─ server/spritesheet-meta.mjs    帧元数据 JSON
  │    └─ server/mcp-renderer.mjs        无头渲染后端（懒启动）
  │         ├─ spawn npx vite（随机空闲端口，win32 shell:true）
  │         └─ Playwright Chromium 单页面复用
  │              └─ mcp-render.html + sources/mcp/render-main.ts
  │                   └─ 复用 sources/agent/session.ts 的 AgentSession
  └─ 进程退出钩子：关闭浏览器、杀掉 vite 子进程
```

### MCP 工具清单（8 个）

| 工具                         | 参数                                                                                      | 说明                                                         |
| -------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `list_categories`          | –                                                                                       | 部件分类树（复用 catalog-snapshot）                                 |
| `list_items`               | `typeName?`, `category?`, `detailed?`                                                   | 物品列表（itemId/name/variants）                                 |
| `get_item`                 | `itemId`                                                                                | 单物品元数据                                                     |
| `list_body_types`          | –                                                                                       | male/female/teen/child/muscular/pregnant                   |
| `list_animations`          | –                                                                                       | 全部可用动作                                                     |
| `suggest_animation_preset` | `role?`                                                                                 | 按角色定位推荐动作清单（摆件/村民/BOSS/玩家…）                                |
| `build_config`             | `bodyType?`, `selections?`, `animations?`                                               | 只产出配置 JSON（校验 + 补全默认三件套 body/head/face），不渲染                |
| `generate_spritesheet`     | `bodyType?`, `selections?`, `animations?`, `includeImage?`, `outputDir?`, `filePrefix?` | 校验 → 无头渲染 PNG → 帧元数据 JSON + 配置 JSON；`outputDir` 传入则写盘并返回路径 |

`generate_spritesheet` 返回内容：

* content\[0]：`{type:"image", data:<base64>, mimeType:"image/png"}`（`includeImage:false` 时省略；完整大表很大，工具描述里引导 NPC 类角色传 `animations` 子集）

* content\[1]：`{type:"text"}` JSON 摘要（文件路径、尺寸、includedAnimations）

* `structuredContent`：`{ config, meta, files }`（config = version-2 配置；meta = 帧元数据）

### 配置 JSON 形态

```json
{
  "version": 2,
  "bodyType": "male",
  "selections": { "body": {...}, "heads": {...}, "expression": {...}, ... },
  "selectedAnimation": "walk",
  "animations": ["idle", "walk"]
}
```

`selections` 每项 `{itemId, name, variant, recolor, subId}`，与 `AgentSession.serialize()` 一致；可通过 Web UI「导入 JSON」直接回导（importStateFromJSON 仅必需 version/bodyType/selections）。

### 渲染后端细节（server/mcp-renderer.mjs）

* 懒启动：首次调用 `generate_spritesheet` 才启动；后续调用复用。

* 端口：`net.createServer().listen(0)` 取随机空闲端口，vite 用 `--port N --strictPort --host 127.0.0.1`，spawn `shell: process.platform === "win32"`（沿用 issue382 脚本模式）。

* 就绪探测：轮询 `GET http://127.0.0.1:N/mcp-render.html` 直到 200（上限 30s）。

* Chromium：`playwright.chromium.launch({headless:true})` 单例；单页面复用；每次渲染 `page.evaluate((cfg) => window.__MCP_RENDER__(cfg), config)` 直接 await 返回结果（无需轮询标志位）。

* 串行化：promise 队列保证一次只跑一个渲染。

* 超时：首次渲染（含页面加载）120s，后续 60s；失败时销毁页面重建，错误信息透传给 MCP result。

* 清理：`shutdown()` 关浏览器 + 杀 vite；挂到 `process.on("exit"/"SIGINT"/"SIGTERM")`。

* runner 页面 `window.__MCP_RENDER__(cfg)` 实现（sources/mcp/render-main.ts）：

  1. `new AgentSession({selections, bodyType, animation})`（空 selections 时 session 自带默认三件套）
  2. `await session.render()`（内部等待 catalogReady）
  3. `session.toBase64PngSelected(animations)` 得 base64 + width/height + includedAnimations
  4. 返回 `{base64, width, height, fullWidth, fullHeight, includedAnimations}`

## 变更文件清单

### 新建

| 文件                                 | 内容                                                                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/animation-presets.mjs`     | 从 agent-handler.mjs 提取 `ANIMATION_PRESETS` + `suggestAnimationPresetData(role)` 纯函数                                                                                                                                                 |
| `server/mcp/protocol.mjs`          | 纯函数 `handleMessage(state, msg, ctx)`：initialize（回显客户端 protocolVersion，缺省 "2025-06-18"）、`notifications/initialized`、`ping`、`tools/list`、`tools/call`（异常 → isError result）、未知带 id 方法 → -32601、通知 → null、解析失败 → -32768/-32600；容忍数组批量消息 |
| `server/mcp/tools.mjs`             | 8 个工具的 JSON Schema + handler；`validateConfig()`（bodyType 白名单、itemId 存在性、animations 白名单、补全默认三件套）；文件写盘逻辑（mkdir -p、png/meta/config 三文件）                                                                                                |
| `server/mcp/stdio.mjs`             | 入口：readline 逐行读 stdin → JSON.parse → handleMessage → 非null响应写 stdout；日志全走 stderr；注册退出清理                                                                                                                                             |
| `server/mcp-renderer.mjs`          | 上述无头渲染后端                                                                                                                                                                                                                            |
| `mcp-render.html`                  | 仓库根，仿 agent.html 的极简加载壳                                                                                                                                                                                                             |
| `sources/mcp/render-main.ts`       | 定义 `window.__MCP_RENDER__`，复用 AgentSession                                                                                                                                                                                          |
| `tests/agent/mcp-protocol_spec.js` | 协议握手 / tools-list / 未知方法 / 通知 / build\_config 校验与默认补全 / 工具错误路径                                                                                                                                                                      |
| `tests/agent/mcp-stdio_spec.js`    | 真实 spawn 子进程走一遍 initialize + tools/list（验证 stdio 帧）                                                                                                                                                                                 |

### 修改

| 文件                         | 变更                                                                      |
| -------------------------- | ----------------------------------------------------------------------- |
| `server/agent-handler.mjs` | `ANIMATION_PRESETS` 改为从 `server/animation-presets.mjs` 导入（行为不变，消除重复）    |
| `package.json`             | scripts 增加 `"mcp": "node server/mcp/stdio.mjs"`；`agent:test` 追加两个新 spec |
| `.gitignore`               | 追加 `mcp-output/`（generate\_spritesheet 常用落盘目录）                          |

### 不改动

* 现有 `/api/agent/*` 行为、agent.html、sources/agent/\*（MCP 是独立并行通道）

* 不新增任何 npm 依赖（Playwright 已在 devDependencies，node --test 为内置）

## 关键决策与假设

1. **传输方式**：仅 stdio（用户已确认）。HTTP MCP 未来可在 `server/index.mjs` 上叠加，不在本次范围。
2. **零依赖手写协议**：延续仓库 server 端零依赖哲学；工具服务器所需协议面（initialize/tools/ping）小而稳定。若未来遇到客户端兼容性问题，可再换官方 SDK。
3. **协议版本协商**：initialize 响应回显客户端请求的 `protocolVersion`（缺省 "2025-06-18"），最大化兼容。
4. **渲染走 vite dev server 而非 dist 静态文件**：与 issue382 黄金链路同模式，源码即用、无需先 build；代价是首次渲染多 1–3s 启动时间（懒启动可接受）。
5. **配置 JSON 不含 layers/credits**：Node 侧拿不到渲染 draw-calls 的层信息；version-2 导入仅必需 version/bodyType/selections，回导无影响。
6. **item 校验**：Node 侧校验 itemId 存在 catalog 快照；variant/recolor 为可选字符串透传（与现有 server 镜像行为一致）。
7. **stdout 纯净**：MCP 进程所有日志/子进程输出一律 stderr，防协议污染。
8. **图片内联体积**：完整大表 base64 可达 MB 级；工具描述引导 Agent 对 NPC/小怪传 `animations` 子集（沿用现有 render\_spritesheet 的措辞）。

## 验证步骤

1. `npm run agent:test` —— 全部通过（含新增 mcp-protocol / mcp-stdio spec，以及既有 agent-handler spec 因 presets 提取后仍通过）。
2. `npm run lint` —— 无新告警。
3. 手动冒烟（渲染链路）：

   * 以 JSON 文件为输入向 `node server/mcp/stdio.mjs` 的 stdin 写入 initialize → tools/list → tools/call `generate_spritesheet`（bodyType=female + 若干 selections + animations:\[idle,walk] + outputDir=tmp/mcp-smoke），确认：

     * stdout 返回 image content + structuredContent；

     * `tmp/mcp-smoke/` 下生成 `.png` / `.json`（帧元数据）/ `.config.json`（配置）三个文件；

     * PNG 尺寸 = 832 × 行数×64（2 动作 × 4 方向 = 8 行 → 832×512）。

   * 打开 Web UI「导入 JSON」加载 `.config.json`，确认角色外观与导出一致。
4. 在任一 MCP 客户端（如 Trae）注册：

   ```json
   { "mcpServers": { "lpc-spritesheet": { "command": "node", "args": ["<仓库绝对路径>/server/mcp/stdio.mjs"] } } }
   ```

   确认工具列表出现 8 个工具并能完成一次「列物品 → 生成精灵表」调用。

