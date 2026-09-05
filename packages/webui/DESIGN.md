# Pi WebUI 设计文档

> 版本:0.84.4 · 适用范围:`packages/webui`
> 状态:设计概要(Implementation Snapshot,基于当前代码)

---

## 1. 项目定位

Pi WebUI 是基于 **Pi Agent Harness**(monorepo 根工作区)构建的多用户 Web 界面。它让多个用户通过浏览器:
- 各自创建、查看、删除**属于自己的持久化会话**;
- 与**主 agent** 对话(实时流式输出);
- 查看并**折叠/展开每次工具调用**及其结果;
- 通过**技能目录(SKILL.md)**与**自定义工具扩展**增强 agent 能力。

它是 coding-agent 实验版运行时(coordinator → server → session-worker 多进程)的**同进程内实现**,复用了同一套协议、路由与 chord 服务机制,但把"每会话一个子进程"换成"每用户一个进程内宿主",以换取部署简单、多用户隔离。

### 1.1 设计目标

| 目标 | 达成方式 |
|---|---|
| 多用户同时访问 | 每用户独立 account + 独立 session 仓库 + 独立 pi-server `Server` 实例 |
| 会话隔离 | 每个用户一个 `JsonlSessionRepo`,目录为 `sessions/<username>/`,用户间不可见、不可附加 |
| 浏览器直连,无 Node 运行时 | 原生 TS + DOM(bundle 后由 esbuild 输出),pi-client 经 WebSocket 连接 |
| 全部依赖既有的 Pi 抽象 | 复用 pi-server 协议路由、chord 服务绑定、AgentHarness 的 durable session |
| 可测试 | vitest 单元/协议/真实 HTTP/WS 集成测试;Playwright 真浏览器 E2E 脚本 |

### 1.2 明确不做(当前范围)

- 不引入 React/Vue 等框架(bundle 只含 marked + 业务代码);
- 不依赖 coding-agent(`@earendil-works/pi-coding-agent`),webui 独立;
- 不引入每会话子进程(会话常驻进程内存中)。

---

## 2. 总体架构

```
                 ┌─────────────────────────── 浏览器 (static/*, esbuild bundle) ───────────────────────────┐
                 │                                                                                          │
                 │  ui/index.ts ── api.ts ── service-source.ts ── transport.ts (WebSocket ByteTransport)    │
                 │    └─ markdown.ts(marked)                                                                │
                 └───────────────┬──────────────────────────────────────────────────────────────────────────┘
                                 │  HTTP(静态 + /api/login + /api/register)
                                 │  WS  (ws://host/ws?token=…, 帧即 pi-protocol 编码字节)
                                 ▼
              ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
              │  websocket-server.ts (createWebuiServer)                                                     │
              │    · one HTTP server + one WebSocketServer(noServer)                                          │
              │    · upgrade 认证:token → username                                                   │
              │    · bridgeSocket:WebSocket ↔ ByteConnection,按 username 路由到该用户的 PiServer.accept()    │
              └───────────────┬───────────────────────────────┬──────────────────────────────────────────────┘
                              │                               │
              ┌───────────────▼───────────────┐   ┌───────────▼───────────────┐
              │  UserRuntime (per user)       │   │  FileAccountStore          │
              │  accounts.json 索引            │   │  · scrypt 密码哈希          │
              │                              │   │  · bearer token(内存,TTL)  │
              │  host.ts (createWebuiHost)    │   └────────────────────────────┘
              │    · NodeExecutionEnv         │
              │    · JsonlSessionRepo         │   sessionsRoot/<username>/…jsonl
              │    · PiServer(serverId)       │
              │    · 每会话一个 AgentHarness   │
              │       └─ main lane + 按需子 lane│
              └──────────────────────────────┘
```

### 2.1 三层结构

1. **Web/UI 层**:浏览器单页应用,原生 TS + DOM。
2. **Websocket 网关节线**(`websocket-server.ts`):HTTP 静态与账号接口、WS 升级认证、字节桥接与每用户路由。它不持有任何会话逻辑,只做认证 + 路由。
3. **每用户宿主**(`host.ts` + `server/index.ts` 的 UserRuntime):会话仓库、AgentHarness、chord 服务提供者、pi-server `Server`。这是"多用户隔离"的落点。

---

## 3. 多用户隔离模型

### 3.1 决策:每用户一个 PiServer 实例

pi-server 的 `ServerHost` 接口在协议层**没有连接级用户身份**——`ByteConnection` 只带字节、`resolveSession/openSession` 只带 sessionId。因此无法在单个 `Server` 内按连接区分用户。方案:为每个已注册用户**懒创建独立的完整运行时**:

```
UserRuntime = {
  server: PiServer(serverId 相同, listeners: [])
  host:   ServerHost<JsonlSessionMetadata>   ← 内含该用户自己的 repo/harness
}
```

- **serverId 全局共享**:所有用户连的是同一个逻辑 server(登录响应返回 serverId),客户端 `Client.connect({serverId})` 校验一致。
- `websocket-server` 的 upgrade 处理器:token → username → `serverForUser(username)` 拿到该用户 `PiServer`,立即 `server.accept(ByteConnection)`(在首帧到达前挂好 handler)。
- 注册(register)会**同步**完成该用户 runtime 的构建,保证注册后立即可用;已存在账户在启动时全部预构建。

### 3.2 数据隔离

- 每个用户独立目录 `sessionsRoot/<username>/`;
- `JsonlSessionRepo` 以该目录为 root;
- 服务端服务 `SessionManagement` 的 `create/remove/attach` 都在当前用户的 repo 上执行;对他人 session 的 `attach` 会因 repo 中查不到而抛 `session_not_found`。

### 3.3 账号存储

`FileAccountStore`(`accounts.ts`):
- JSON 文件 `accounts.json`,每条 `{username, createdAt, passwordHash}`;
- 密码用 **scrypt** 哈希(`scrypt$N$r$p$salt$hash`),不落明文;
- 登录/注册签发 **bearer token**(随机 32 字节 hex,内存 map,7 天 TTL),WS 升级用 `?token=` 携带(浏览器无法自定义 WS 头)。

---

## 4. 通信协议

### 4.1 帧与连接

浏览器端 WebSocket 传输的是 **pi-protocol 编码的完整帧字节**(4 字节大端长度前缀 + CBOR)。`transport.ts` 实现 `ByteTransport`(send/close),服务端 `bridgeSocket` 把 ws 二进制消息**原样**交给 `PiServer.accept()` 返回的 handler(`onData/onClose/onError`)——不二次拆帧(早期曾误用 `FrameDecoder`,已修正)。

### 4.2 服务编排(chord)

`src/shared/protocol.ts` 定义全部远程服务契约(两端共用):

| 服务 | 作用域 | 成员 |
|---|---|---|
| `SessionDirectory` | server | `state: ReplicatedState<{revision, sessions[]}>` —— 当前用户会话列表 |
| `SessionManagement` | server | `create / remove / attach / detach` |
| `AgentController` | session | `prompt / requestAbort / resume / setModel / capabilities / acquireSubLane / listLanes` |
| `Transcript` | session | `state: ReplicatedState<LaneStateSnapshot>` —— 主 lane 实时快照 |
| `ProviderSettings` | server | `listProviders / getProvider / listModels / upsertProvider / deleteProvider / testProvider / discoverModels` |

- 服务端用 chord `RemoteServiceProvider` + `createRemoteServiceEndpoint` 暴露;
- 客户端用 `ServerServiceSource` / `SessionServiceSource`(简化自 coding-agent experimental 的同名结构)绑定远程服务,遵循**先 use 再 ready** 的水合顺序;
- `SessionDirectory.state` 通过 replicated-state 订阅驱动 UI 刷新。

### 4.3 会话附加(session attachment)

客户端流程:
1. `SessionManagement.create()` → 服务端创建 durable session 并 resident 打开;
2. `SessionManagement.attach(sessionId)` → 服务端经 `presentation.attachSession()` 走 pi-server session router → 触发 `ServerHost.openSession()` 的 `RoutedSessionHandle.attachClient()`;
3. 客户端 `SessionServiceSource.whenAttached()` 等待 `client.attachment` 就位后再 `ready()` 会话级服务。

---

## 5. 服务端设计

### 5.1 `host.ts`(createWebuiHost)核心要点

- **持久化**:会话由 `JsonlSessionRepo` 管理,数据落在 `sessions/<username>/`;重启后 `SessionDirectory` 自动列出既有会话。
- **AgentHarness 装配**:
  - 内置工具:`read / write / edit / bash`;
  - 可扩展:`tools` 选项追加自定义工具(契约 `AgentHarnessTool<{ env: NodeExecutionEnv }>`);
  - 技能:`skills`(Skill 数组)与 `skillsDir`(从目录 `loadSkills` 加载 SKILL.md),经 `formatSkillsForSystemPrompt` 注入系统提示;
  - 每个打开的 session 常驻一个 harness,`main` lane 加按需子 lane(`acquireSubLane`)。
- **Transcript 实时快照**(流式):
  - `lane.watch()` 创建订阅;事件到达时用 **`reduceLaneSnapshot` 原地把事件合并进可变快照**(watch 自己的 snapshot 只在显式 resnapshot 时更新,不能直接发布);
  - 发布前 **JSON 往返归一化**(`toJson`)——同进程桥接没有 stdio 传输来过滤非 JSON 值,必须手工丢弃 `undefined/function`,否则协议编码 `encodeServerMessage` 校验失败会整条连接关闭;
  - 事件造成 rebase(compaction/navigation 等)时走 `resnapshot()` 重建快照。
- **服务端服务**是 per-attachment 的:`attachClient(presentation)` 里创建 provider,`create/remove` 用 `presentation.prepareSessionRemoval` 释放路由,session 数据改动后 `publishDirectory` 让所有订阅者刷新。

### 5.2 `websocket-server.ts`(createWebuiServer)

- 单 HTTP server + `WebSocketServer({noServer:true})`;
- `upgrade`:校验 token → username → `serverForUser(username)` → `handleUpgrade`,connection 回调里 `accept` 后 `bridgeSocket`;
- HTTP API:`/api/login`、`/api/register`(注册后 await `onUserRegistered` 完成构建);
- 静态服务:映射 `staticDir`,`normalize` + `startsWith` 防目录穿越,404 兜底。
- WS 升级失败的请求返回 401 并 destroy,不进入协议层。

### 5.3 `index.ts`(startWebui)与 `main.ts`(CLI)

- `startWebui(options)`:数据根/账号/模型解析、按账号预构建 UserRuntime、组装 `createWebuiServer`;
- `main.ts`:可执行入口,支持 `--port/--hostname/--data/--username/--password/--create-user` 等参数;
- `scripts/run-local.mjs`:本地开发用,**内置自定义 Ollama provider**(OpenAI 兼容端点),`--skills-dir` 可挂技能目录,`OLLAMA_MODEL` 选择模型(默认 `gemma4:e4b-mlx`,因为它支持工具调用且输出进 content)。

### 5.4 `providers.ts`(用户配置的 provider)

- **每用户一个 catalog**:`createWebuiHost` 用 `createProviderRegistry({ store, baseline })` 新建 `Models` 实例——先装用户配置的 provider,再叠 `baseline`(builtin),配置项因此赢过默认模型选择;共享 `MutableModels` 会把 API key 跨用户泄漏。
- **存储**:`FileProviderStore` 写 `sessions/<username>/providers.json`(文件 `0600`),进程内 `Map` + 每次变更落盘;坏文件在 `ready()` 抛错而不是静默清空。
- **校验**:`normalizeEndpoint` 校验 baseUrl(http(s) 前缀,去尾斜杠)/非空 apiKey,`normalizeProviderConfig` 再校验 name/至少一个 model/model id 去重,`uniqueProviderId` 用 `-2` 后缀避免撞名;编辑保留 `id` 与 `createdAt`。
- **构建**:`buildProvider` 用 `createProvider({ api: openAICompletionsApi() })` 生成静态 provider,auth 始终 resolve `{ apiKey, baseUrl }`(本地无 key 端点用占位 key 如 `ollama`)。
- **可用性**:`listModels()`/`defaultModel()` 走 `getAvailable()`,只返回 auth 齐备的模型,避免 UI 展示选不中的模型。
- **探测连接**:`probeEndpoint(baseUrl, apiKey)` 请求 `{baseUrl}/models` 解析 `data[].id`,失败走返回值(`ok:false, error`)而非抛异常,10s 超时。已保存的 provider 走 `test(id)`,未保存的表单走 `probe(config)`(即 `discoverModels`,不落盘),两者共用同一探测实现。
- **错误传输**:`host.ts` 用 `asInvalidValue` 把 provider 相关抛错转成 `ServerError("service_invalid_value")`,否则服务端 `toProtocolError` 会把它降级成 `internal_error` / "Internal server error",UI 拿不到真实原因。

---

## 6. 客户端设计(浏览器)

### 6.1 分层

| 文件 | 职责 |
|---|---|
| `transport.ts` | WebSocket `ByteTransport`:token 进 query;`open` 前缓存待发帧(否则 hello 会在 CONNECTING 期被丢弃导致握手超时);兼容 ArrayBuffer/Blob |
| `service-source.ts` | `ServerServiceSource`/`SessionServiceSource`:连接状态、attachment 跟踪、`whenAttached`、订阅管理 |
| `api.ts` | `login/register/connectWebui` + `WebuiClient` 封装(prompt/abort/resume/removeSession/onSessionsChange 等) |
| `ui/index.ts` | 三屏 SPA:登录 → 会话列表 → 聊天(含子 lane 面板、工具卡片、流式渲染) |
| `ui/settings.ts` | 设置弹窗:provider 增删改查 + `/models` 连通性测试;编辑表单的 `Fetch models` 走 `discoverModels` 拉取未保存 endpoint 的模型列表并合并进表格(保留已填参数,只追加新 id);`onProvidersChanged` 通知聊天顶栏刷新模型列表 |
| `ui/markdown.ts` | 基于 marked 的安全 markdown → HTML(`renderer.html` 返回空丢弃原始 HTML,防 XSS);HTML/SVG/xml 代码块外包 `.md-code`,前端再挂 Source/Preview 切换 |

### 6.2 状态与刷新

- 目录变化(登录水合、创建、删除)由 `client.onSessionsChange()` 订阅驱动,`refreshText` 仅在 **sessions 非空时才渲染列表、为空才显示 empty 提示**;
- transcript 同样订阅 replicated state,每个事件重渲染;
- 展开状态(outside `toolCardState` Map 以调用 id 为 key)在重渲染间保持;
- 顶栏模型选择器按 provider 分组列出 `listModels()`,`change` 走 `AgentController.setModel()`,transcript 快照的 `configuration.model` 反向同步选中项;设置里增删 provider 由 `onProvidersChanged` 回调重新拉取列表;
- `createSession()` 没有可用模型时直接打开设置弹窗,而不是把服务端报错弹给用户。

### 6.3 会话持久化(刷新不丢登录)

- 登录/注册成功后将 `{serverId, token, username}` 写入 `localStorage`;
- `mount()` 启动时读到存档就自动 `connectWebui` 恢复;失败/失效则清存储回登录页;
- 强制刷新不再回到登录页。

### 6.4 聊天渲染(ChatGPT 风格布局)

- 整体布局仿 ChatGPT:左侧窄边栏(品牌 + New chat + 按日期分组的会话列表 Today/Yesterday/Previous 7 days/Older + 底部用户条),右侧为居中内容列(最大宽 720px);
- 顶栏仅含会话标题与运行状态点,移动端折叠为抽屉(menu 按钮 + backdrop);
- 消息不使用双侧气泡:用户消息为右对齐浅灰圆角气泡(24px 圆角),助手消息为无气泡扁平 markdown 块(左侧圆形头像标记,流式时末尾闪烁光标);
- 会话标题从首条用户消息自动截断生成(内存 Map,刷新列表时复用),否则显示 `Session <id8>`;
- 输入区为 ChatGPT 式圆角卡片(自动增高的 textarea + 图标行:图片附件、Resume、圆形发送/停止按钮,Enter 发送、Shift+Enter 换行),下方居中提示文案;
- 工具卡片与未配对 toolResult 与助手文本同列宽:头部 `工具名` + 折叠箭头,展开显示 Arguments(格式化 JSON)+ Result,默认折叠,展开状态按 toolCallId 保持;
- 主题:深色系为默认风格的中性灰阶(light/dark 均通过 `prefers-color-scheme` 适配),强调色为黑/白反色,无渐变;
- IME 兼容:Enter 提交前检查 `isComposing`/`keyCode===229`,中文输入法选词不误发。

---

## 7. 扩展机制

### 7.1 工具扩展

`createWebuiHost({ tools })`:在 `read/write/edit/bash` 之外追加任意 `AgentHarnessTool<{ env }>`(契约含 `name/label/description/parameters/execute`)。测试里用 `echo` 工具验证了注入链路。

### 7.2 技能(Skills)

- 目录约定:任一目录下(可嵌套)`SKILL.md`(frontmatter `name/description`);
- `skillsDir` 选项指定根目录,`loadSkills(env, dir)` 递归加载;
- 加载结果经 `formatSkillsForSystemPrompt` 注入系统提示:模型看到 `<available_skills>` 清单,任务匹配时用 read 工具自行读取技能文件执行;
- 也可以直接传入 `skills` 数组(应用内定义)。

---

## 8. 安全设计

| 风险 | 对策 |
|---|---|
| 越权访问他人会话 | 每用户独立 repo + 独立 Server/ServerHost;attach 目标不在自身 repo 即拒绝 |
| 密码泄露 | scrypt 加盐哈希,不落明文 |
| token 窃取 | 随机高熵 token、TTL、仅内存存储(重启失效) |
| XSS(模型输出) | marked renderer 丢弃原始 HTML(`html()` → `""`),代码块由 marked 自身转义 |
| HTML/SVG 预览 iframe | `sandbox="allow-scripts"`,**不给** `allow-same-origin`:预览跑在 opaque origin,读不到主文档 `localStorage`(含 `pi-webui-session` token)与 cookie |
| 静态目录遍历 | `normalize` 后 `startsWith(staticDir)` 校验 |
| WS 未授权连接 | upgrade 阶段校验 token,失败 401 关闭 |

---

## 9. 测试策略

`test/`(vitest,全部用 faux provider,无真实 API 调用):

| 文件 | 覆盖 |
|---|---|
| `accounts.test.ts` | scrypt 哈希/持久化/重复用户/短密码/token 生命周期 |
| `host.test.ts` | 协议全链路(create/list/attach/remove)、跨重启持久化、prompt+transcript、子 lane、双用户隔离与重启独立、provider 设置(无 provider 拒绝建会话、`discoverModels` 在 wire 上可用且校验错误保留信息、保存后作为种子模型、setModel、按用户隔离) |
| `providers.test.ts` | `FileProviderStore` 落盘/权限/坏文件、`normalizeProviderConfig` 校验与去重、`buildProvider` 默认值、registry 列表与 `getAvailable()` 过滤、`test()`/`probe()` 探活(本地 HTTP 服务,probe 不落盘) |
| `server.test.ts` | 真实 HTTP/WS:静态服务、登录/注册/鉴权、无效 token 拒绝、端到端会话流、线上隔离 |
| `client-api.test.ts` | connectWebui 水合/订阅驱动、attach 后 prompt、detach 清 attachment |
| `skills.test.ts` | 技能目录加载 + 扩展工具注入后 prompt 不崩、assistant 回复落地 |
| `markdown.test.ts` | 行内格式/标题列表/代码块转义/HTML 注入剥离/GFM 表格、HTML/SVG 代码块的 `.md-code` 预览包裹 |
| `test-helpers.ts` | tempDir 清理、faux 模型、内存 loopback 传输、attachment 等待 |

此外提供 `scripts/ui-e2e.mjs`(Playwright 驱动真实 Chrome):登录 → 会话列表渲染 → 刷新恢复 → 流式/工具卡片等 UI 行为回归。

运行:包内 `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/`,或根目录 `npm run check`(biome/tsgo/browser-smoke 等全量)。

---

## 10. 构建与运行

```bash
# 构建(服务端 tsgo + 浏览器 bundle)
npm run build          # = tsgo -p tsconfig.build.json && node scripts/build-browser.mjs

# 类型检查 / 测试
npm run typecheck      # tsgo -p tsconfig.test.json
npm test               # vitest --run

# 本地运行(接本地 Ollama,OpenAI 兼容端点)
OLLAMA_MODEL=gemma4:e4b-mlx npx tsx scripts/run-local.mjs \
  --port 3112 --data /tmp/pi-webui-run2 \
  --create-user --username admin --password admin1234 \
  [--skills-dir /path/to/skills]
```

浏览器打开 `http://127.0.0.1:3112` 即可。

---

## 11. 目录结构速览

```
packages/webui/
├─ package.json              # deps: chord, pi-agent-core, pi-ai, pi-client, pi-protocol, pi-server, marked, ws
├─ tsconfig.build.json       # 服务端构建(NodeNext, paths → dist 别名)
├─ tsconfig.test.json        # 类型检查(node+vitest types,含 test/)
├─ vitest.config.ts          # vitest + workspace 源码别名
├─ src/
│  ├─ shared/protocol.ts     # 两端共享服务契约
│  ├─ server/
│  │  ├─ accounts.ts         # 用户/密码/token
│  │  ├─ host.ts             # 每用户 ServerHost + AgentHarness + chord 服务
│  │  ├─ websocket-server.ts # HTTP/WS 网关、认证、路由、桥接
│  │  ├─ index.ts            # startWebui + 每用户 UserRuntime 编排
│  │  └─ main.ts             # CLI 入口
│  └─ client/
│     ├─ transport.ts        # WS ByteTransport(帧直通、open 前缓冲)
│     ├─ service-source.ts   # server/session 两级远程服务绑定
│     ├─ api.ts              # WebuiClient 封装
│     ├─ ui/
│     │  ├─ index.ts         # 三屏 SPA + 流式 + 工具卡片
│     │  └─ markdown.ts      # 安全 markdown 渲染
│     └─ index.ts            # 入口(mount)
├─ static/                   # index.html / styles.css / app.js(bundle 产物,gitignore)
├─ scripts/
│  ├─ build-browser.mjs      # esbuild bundle
│  ├─ run-local.mjs          # 本地 Ollama runner
│  └─ ui-e2e.mjs             # Playwright 真浏览器 E2E
└─ test/                     # vitest 用例 + test-helpers.ts
```

---

## 12. 关键实现要点(Debug 笔记)

这些点都是实测踩过坑后固化的,改动时务必保持:

1. **不要二次拆帧**:`ByteConnection` 传输的已是完整 pi-protocol 帧字节,桥接层原样透传。
2. **浏览器 WS 的 open 前缓冲**:pi-client 连接即发 hello,transport 必须在 `open` 前缓存帧,否则服务端握手超时(表现为 "Byte transport closed")。
3. **快照必须 reduce 后发布**:`lane.watch()` 的 snapshot 不自更新,须用 `reduceLaneSnapshot` 原地合并事件;rebase 事件走 `resnapshot`。
4. **快照发布前 JSON 归一化**:同进程桥接无传输清洗,`toJson()` 丢掉 `undefined/function`,否则协议编码抛错断连。
5. **先 use 再 ready**:chord 绑定的水合顺序;目录/transcript 快照异步到达,UI 用订阅驱动而非一次性读取。
6. **目录为空才显示 empty 提示**;有会话绝不渲染 "No sessions yet"。
7. **服务端 attachClient 支持异步**(await 目录刷新后返回 attachment),保证首订阅快照即最新。