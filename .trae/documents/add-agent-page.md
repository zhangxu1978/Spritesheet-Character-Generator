# 增加 Agent 页面（对话式精灵图生成 + AI 工具 + API）

## Summary

在现有 Universal LPC Spritesheet Character Generator 中新增一个独立的 **Agent 页面**，允许用户通过自然语言对话生成/调整精灵图，并在页面内实时预览动作动画。同时把现有的核心功能（修改选择项、设置身体类型、切换动作、获取 PNG）封装成 AI 可调用的**结构化工具**，并对外提供 HTTP **API**，让外部 Agent 平台能发送需求 → 调用工具 → 返回最终精灵图（PNG / dataURL）。

整个方案尽量复用现有渲染管线（`canvas/renderer.ts`、`canvas/download.ts`、`state/state.ts`），不引入新的渲染引擎；UI 沿用现有的 Mithril + Bulma 风格；新增 Agent 路由 `/agent`；新增服务端中间件（Express + Vite 中间件模式）只用于暴露 API。

***

## Current State Analysis

通过 Phase 1 探索得到的关键事实：

1. **前端框架**：Mithril + TypeScript + Bulma（`sources/main.ts` 是单一入口），挂载点为 `index.html` 中的 `#mithril-filters`、`#mithril-preview`、`#mithril-spritesheet-preview`。
2. **核心 API**（已存在，可作为 AI 工具目标）：

   * `selectItem(itemId, variant, isSelected, subId)` — 选/取消选某个部件（`state/state.ts`）。

   * `selectDefaults()` — 重置默认角色。

   * `applyMatchBodyColor(variant, recolor)` — 联动其它身体色部件。

   * `setPreviewAnimation(animation)` + `startPreviewAnimation()` / `stopPreviewAnimation()` — 切换预览动作（`canvas/preview-animation.ts`）。

   * `renderCharacter(selections, bodyType, targetCanvas?)` — 同步渲染到 canvas（`canvas/renderer.ts`）。

   * `canvasToBlob(canvas)` + `downloadAsPNG(filename)` — 输出 PNG（`canvas/download.ts`）。

   * `canvas` 是 `initCanvas()` 后挂载到模块作用域的 offscreen canvas（`SHEET_WIDTH=832`, `SHEET_HEIGHT=3456`）。
3. **可枚举的领域元数据**（已经存放在 `state/catalog.ts` 的 `defaultCatalog`，是 AI 工具查询物品清单的来源）：

   * `getCategoryTree()` → 部件分类（body / head / torso / legs / feet / …）。

   * `getItemLite(id)` → 名称、可选 variant、可选 recolor、支持的身体类型、可执行动作。

   * `getPaletteMetadata()` → 调色板信息（palette/material/version）。

   * `getMetadataIndexes()` → 按 type\_name 索引的物品清单。
4. **动作集**已经定义在 `state/constants.ts` 的 `ANIMATIONS` / `ANIMATION_OFFSETS` / `ANIMATION_CONFIGS`，可直接给 Agent 作为枚举。
5. **构建配置**：`vite.config.js` 的 `rolldownOptions.input = { main: "index.html" }`，使用 `serve` / `dev` 启动。要让新页面/新 API 跑起来，需要：

   * 在 `index.html` 增加 `#mithril-agent` 挂载点（或者单独 `agent.html`）。

   * 增加 Express dev server 把 `/api/agent/*` 路由串到工具层（在 `vite.config.js` 用 `configureServer`）。

   * 生产构建产物需要把 Express 服务作为独立入口（新增 `server.mjs` + `npm run start`）。
6. **现有冲突点**：目前所有选择/渲染都依赖全局单例 `state`。Agent 工具调用如果直接 mutate `state`，会和 UI 渲染互相耦合 → 需要引入一个**独立的 headless session**（独立 `state` 副本 + 独立 offscreen canvas），这样 API 请求和 UI 完全隔离。

***

## Proposed Changes

### 1. 工具层 — 把现有功能暴露为结构化 AI 工具（前后端共用）

新增 `sources/agent/tools.ts`，定义一组**纯函数式**的工具实现，输入/输出用 JSON-schema 描述：

| 工具名                      | 用途                                                  | 实现                                                 |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------- |
| `list_categories`        | 列出可选部件分类                                            | `defaultCatalog.getCategoryTree()`                 |
| `list_items`             | 按分类/type\_name 列出可装备的物品                             | `defaultCatalog.getMetadataIndexes()` 过滤           |
| `get_item`               | 获取物品细节（variants、recolors、支持的身体类型、可执行动作）             | `defaultCatalog.getItemLite()` / `getItemMerged()` |
| `set_body_type`          | 切换身体类型                                              | 写入 session 副本 `state.bodyType`                     |
| `set_selection`          | 选择/取消一个部件（含 variant / recolor）                      | `selectItem(...)`                                  |
| `clear_selection`        | 移除一个部件                                              | `selectItem(..., true)`                            |
| `apply_match_body_color` | 联动身体色                                               | `applyMatchBodyColor(...)`                         |
| `set_animation`          | 切换预览动作                                              | `setPreviewAnimation(...)`                         |
| `render_spritesheet`     | 把当前 session 渲染到一张新的 offscreen canvas，返回 PNG（base64） | `renderCharacter(...)` + `canvasToBlob(...)`       |
| `reset_to_defaults`      | 重置                                                  | `selectDefaults()`                                 |

工具签名统一为：

```ts
type ToolContext = { session: SessionState };
type ToolHandler<Args> = (ctx: ToolContext, args: Args) => Promise<Result<unknown, ToolError>>;
```

每个工具都导出对应的 **JSON Schema**（`getToolSchemas(): ToolSchema[]`），供 Agent 调用方声明 `tools` / `functions`。

### 2. Agent Session 层 — 隔离 UI 与 API 的状态

新增 `sources/agent/session.ts`：

* `createSession()` 接受 `defaultCatalog` 副本，构造一份**新的** state + 自己的 offscreen canvas：

  * 复制 `state` 的初始字段（selections/bodyType/animation/…）。

  * `canvas = new OffscreenCanvas(SHEET_WIDTH, SHEET_HEIGHT)` 或浏览器 `HTMLCanvasElement`（headless 用 `node-canvas` 在 server 端，但本期为了零新依赖，使用 server-side 渲染时仅返回 hash/JSON + PNG via 已有的服务端 SSR）。

* 每个 session 持有 `toolContext`；UI 的 Agent 页面和 API 都共用一个 in-memory `Map<sessionId, Session>`。

* 提供 `serialize(session)` / `deserialize(sessionId, json)` 以便把 session 状态写进 hash 让 Agent 页面可分享。

### 3. 对话界面 — 新增 Agent 页面

新增文件：

* `agent.html` — 新页面入口。

* `sources/agent/main.ts` — 独立挂载（沿用 `main.ts` 模式：DOMContentLoaded → `m.mount`）。

* `sources/agent/AgentApp.ts` — 顶层布局：

  * 左侧：聊天面板 `ChatPanel`（消息列表 + 输入框 + 发送按钮）。

  * 右侧：预览面板 `AgentPreview`（单个 `canvas` + 动作下拉 + "下载 PNG"）。

* `sources/agent/ChatPanel.ts`：

  * 渲染 `state.chatMessages: ChatMessage[]`（用户/助手/工具调用/工具结果 4 种类型）。

  * 集成 `agentClient`（见下）。

* `sources/agent/AgentPreview.ts` — 调用 `setPreviewAnimation` + `startPreviewAnimation`，把 session 的 offscreen canvas 实时复制到该预览 canvas。

* `sources/agent/client.ts` — `agentClient`：

  * 默认 `mode = "browser"` 时直接调用 `runToolsLocally`（复用工具层，零网络）。

  * 模式 `"server"` 时 fetch `/api/agent/chat`，由后端转发 LLM（本计划仅实现本地 stub，可后续接入）。

  * 模式 `"custom"` 时把 messages 发到用户配置的 endpoint。

UI 与现有主站的关系：

* 在 `index.html` 顶栏增加链接 `主页 / Agent`（hash 路由 `#/agent`）。

* `main.ts` 读取 `location.hash`，若为 `#/agent` 则挂载 `AgentApp`、隐藏 `#columns-container`，否则维持原行为。

### 4. 服务端 API — 给外部 Agent 调用

新增 `server/` 目录：

* `server/index.mjs` — Express 服务，启动在 `process.env.PORT || 4173`。

  * 生产时静态托管 `dist/`。

  * 开发时由 Vite 的 `configureServer(server)` 注入中间件（见 5）。

  * 路由：

    * `GET  /api/agent/tools` → `getToolSchemas()`。

    * `POST /api/agent/run` body `{ sessionId?, tool, args }` → 调工具并返回结果（base64 PNG 或 JSON）。

    * `POST /api/agent/chat` body `{ messages, mode? }` →

      * `mode="echo"`：本地 stub，把用户最后一条消息作为目标工具的输入（按关键字匹配，例如 "给我一个红色头发的法师" → 推断 bodyType=muscular, head=heads\_human\_male, recolor=red, weapon=wand 等）。

      * `mode="minimax"`（默认）：读取根目录 `config.json`，按 `agent.provider="MiniMax"` 把消息 + 工具 schemas 打到 `${baseUrl}/chat/completions`，把 `tool_call` 逐个回填，直到拿到 `render_spritesheet` 为止。配置缺失/网络错误时自动 fallback 到 echo 模式并 warn。

      * 该接口支持流式（Server-Sent Events）以便在 Agent 页面看到步骤。

    * `GET  /api/agent/session/:id` / `PUT` / `DELETE` 简单的 session CRUD。

* `server/agent-stub.mjs` — 关键字 → 工具参数映射（不依赖任何 LLM 时也能用）：

  * 颜色词（红/蓝/绿/黑/白/紫/金/银/橙/棕/灰） → recolor。

  * 角色词（法师/战士/弓箭手/骑士/盗贼/忍者） → 武器 + 服装。

  * 动作词（跑/走/攻击/砍/射/待/坐/跳/爬） → `set_animation`。

  * 身体词（男/女/青少年/儿童/肌肉/孕妇） → `set_body_type`。

  * 头发词（长发/短发/马尾/光头/卷发） → hair 类型 + variant。

API 返回结构统一：

```json
{ "ok": true, "data": <toolResult> }
{ "ok": false, "error": { "kind": "...", "message": "..." } }
```

### 5. Vite 集成 — dev server 跑 API

修改 `vite.config.js`：

* 新增 `vitePluginAgentApi()`（`vite/vite-plugin-agent-api.js`）：

  ```js
  export function vitePluginAgentApi() {
    return {
      name: "agent-api",
      configureServer(server) {
        server.middlewares.use("/api/agent", async (req, res, next) => {
          // 复用 server/agent-handler.mjs 的纯函数 handle(req)
        });
      },
    };
  }
  ```

* 把 `server/agent-handler.mjs` 写成与平台无关的 `(req, res) => Promise<void>`，dev 中间件和 Express 都直接调用它。

### 6. 路由与导航

* 修改 `index.html` 与 `sources/main.ts`：根据 `location.hash` 在挂载 `#mithril-filters` 或新建 `#mithril-agent` 之间切换。

* 新增 `agent.html`，`<script src="sources/agent/main.ts">`，可作为独立的 `vite build` 入口（`rolldownOptions.input.agent = "agent.html"`）。

### 7. 测试与脚本

* `tests/agent/` 下新增 Vitest/Node 测试：

  * `tools_spec.js`：对每个工具用最小 catalog fixture 跑一遍。

  * `agent-handler_spec.js`：用 `supertest` 或纯函数调 `handle()`，覆盖 `/api/agent/run` 与 `/api/agent/chat?mode=echo`。

* `package.json` 增加：

  * `"start": "node server/index.mjs"`

  * `"agent:test": "node ./tests/node/run-node-tests.js"`（已存在的测试 runner，加测试文件即可）。

### 8. 关键文件清单

新增：

* `sources/agent/main.ts`

* `sources/agent/AgentApp.ts`

* `sources/agent/ChatPanel.ts`

* `sources/agent/AgentPreview.ts`

* `sources/agent/client.ts`

* `sources/agent/session.ts`

* `sources/agent/tools.ts`

* `sources/agent/types.ts`

* `agent.html`

* `vite/vite-plugin-agent-api.js`

* `server/index.mjs`

* `server/agent-handler.mjs`

* `server/agent-stub.mjs`

* `tests/agent/tools_spec.js`

* `tests/agent/agent-handler_spec.js`

修改：

* `index.html`（顶部导航 + Agent 入口）。

* `sources/main.ts`（按 hash 分发挂载点）。

* `vite.config.js`（注册新插件 + `agent.html` 作为第二个 build 输入）。

* `package.json`（`start` 脚本）。

***

## LLM 配置（MiniMax）

`config.json` 已声明使用 MiniMax 作为 Agent 页面与 `/api/agent/chat` 的模型底座：

```json
{
  "agent": {
    "provider": "MiniMax",
    "apiKey": "sk-cp-...",
    "model": "MiniMax-M3",
    "baseUrl": "https://api.minimaxi.com/v1",
    "temperature": 0.1
  }
}
```

实施约束：

1. **配置加载**：`server/llm-config.mjs` 读取项目根 `config.json`，仅在 server 端使用（避免把 key 打包进前端 bundle）。
   - 用 Node `fs.readFileSync` + `JSON.parse`；解析失败时返回 echo stub 并打 warn。
   - 缺失字段时按"echo 模式"运行（保留 demo 可用性），不要 throw。
2. **OpenAI 兼容调用**：MiniMax 的 `/v1/chat/completions` 兼容 OpenAI Chat Completions 协议，所以复用 OpenAI SDK 风格请求体即可：
   ```js
   POST {baseUrl}/chat/completions
   {
     "model": config.agent.model,            // "MiniMax-M3"
     "temperature": config.agent.temperature, // 0.1
     "messages": [...],
     "tools": <getToolSchemas() 转 OpenAI tools 格式>,
     "tool_choice": "auto",
     "stream": false
   }
   Authorization: Bearer {apiKey}
   ```
3. **工具格式映射**：MiniMax 的 `tools` 字段沿用 OpenAI 的 `[{ type: "function", function: { name, description, parameters: JSONSchema } }]`，所以 `getToolSchemas()` 直接输出这套结构即可，不需要单独的转换层。
4. **客户端调用**：浏览器端的 `sources/agent/client.ts` 永远不直连 MiniMax（避免泄露 key），统一走 `/api/agent/chat`；server 端在内存里转发。
5. **流式输出**：可选 SSE；MiniMax 支持 `stream: true`，server 中间件解析 `data: {json}\n\n` 并转成自家 SSE 协议（`event: tool_call` / `event: tool_result` / `event: final`）推到浏览器。
6. **Echo 模式保留**：当 `config.json` 缺失 / key 无效 / 网络错误时自动回落到 `agent-stub.mjs` 的关键字匹配，保证 dev/demo 可用。
7. **测试**：不把真实 key 写进测试；测试用 `node:test` 注入假 `fetch`（`globalThis.fetch = vi.fn(...)`）断言请求体结构（model、messages、tools 数量）。

涉及到的文件（与原计划一致，新增/改动一行说明 LLM 调用细节）：

- `server/index.mjs`：在 `/api/agent/chat` handler 里 `import { loadConfig } from "./llm-config.mjs"`，按 `config.agent.provider === "MiniMax"` 走 MiniMax 分支。
- `server/llm-config.mjs`（新增）：读 `config.json`，导出 `{ provider, apiKey, model, baseUrl, temperature }`。
- `server/minimax-client.mjs`（新增）：封装 `chatCompletion({ messages, tools })`，用 `fetch` 打到 `${baseUrl}/chat/completions`。
- `sources/agent/client.ts`：仅消费 `event: tool_call` / `event: final` SSE 流；模型选型由 server 决定。

---

## Assumptions & Decisions

1. **不引入新的渲染框架**：直接复用 `renderCharacter` 的 offscreen canvas。Agent session 自己持有一份独立的 canvas，避免与 UI 共享。
2. **工具实现走"纯函数 + 上下文对象"模式**：便于在 Node 端跑（不依赖 DOM），也让未来直接接入 MCP / Anthropic tools 协议时无需重构。
3. **Agent 页面只渲染对话 + 预览，不复用左侧筛选器**：避免占用太多屏幕；筛选仍可在主站完成，Agent 通过 URL hash 接收初始 selections。
4. **服务端使用 Express**（最小依赖，已经被 Vite 生态广泛支持）；避免引入 MCP SDK 之类的额外抽象层。
5. **Echo 模式作为缺省**（不需要任何 LLM 密钥），保证 demo 可直接跑；OpenAI 转发作为可选增强。
6. **不存储历史对话**：session 仅缓存渲染状态；消息历史只在当前浏览器 tab 内存里。这样避免数据库引入。
7. **不修改现有 catalog / renderer 的公开 API**：工具层在它们之上包装，老路径照常工作；tests 不需要重写。
8. **本地 Agent session 与 API session 不互通**：UI Agent 的"本地"模式直接走工具层（无网络），API session 用于跨进程/外部 Agent 访问；二者通过相同的 `agent-handler.mjs` 函数保证行为一致。

***

## Verification

实施完成后，按以下步骤验证：

1. **构建**：`npm run build` 通过，无 TS / lint 错误。
2. **dev**：`npm run dev`，访问 `http://localhost:5173/#/agent`：

   * 输入"给我一个穿蓝袍子拿法杖的女法师，演示走和攻击动作"。

   * 右侧预览 canvas 实时变化，能下载 PNG。

   * 输入"换成肌肉男拿剑"，状态正确更新。
3. **API 单独验证**（用 `curl.exe`）：

   ```powershell
   curl.exe -s http://localhost:4173/api/agent/tools | Select-String "render_spritesheet"
   curl.exe -s -X POST http://localhost:4173/api/agent/chat -H "Content-Type: application/json" -d '{\"mode\":\"echo\",\"messages\":[{\"role\":\"user\",\"content\":\"红色长发的女法师走\"}]}'
   ```

   响应里应包含 `tool_calls` 与最终 `render_spritesheet` 的 PNG base64。默认走 MiniMax（`mode` 不传即生效）；加 `?mode=echo` 可强制本地 stub 验证。
4. **测试**：`npm run test:node` 通过，新增的 `tests/agent/*_spec.js` 全部绿。
5. **回归**：原主页（无 hash）行为不变；`syncSelectionsToHash` / `initState` 流程不被打断。

***

## Open Questions

在执行前需要用户确认（若无异议则按 Assumptions 默认）：

1. **服务端语言/框架**：选 Express（最小依赖，Vite 生态兼容）。是否接受？
2. **LLM 集成**：模型底座已由 `config.json` 锁定为 MiniMax（`MiniMax-M3`，`https://api.minimaxi.com/v1`，OpenAI 兼容协议）；echo 模式仅作 fallback。本期不再接入其它 provider。
3. **Agent 页面入口**：是否做成 `#/agent` hash 路由 + 独立 `agent.html` 双入口（更利于打包和分享链接）？

