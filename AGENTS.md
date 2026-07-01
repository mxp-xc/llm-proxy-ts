# AGENTS.md

本文件为 AI 代理提供架构与开发指导。

## 项目概述

`llm-proxy-ts` 是本地优先的 LLM 协议转换代理。核心能力：将上游 provider（无论其原生协议）同时以多种下游协议格式暴露——同一个上游可以同时提供 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 等 API。通过 Vercel AI SDK 统一调用上游，再由各协议的 renderer 渲染成对应格式返回客户端。新增协议只需实现 `ProtocolStrategy` 接口：必填成员 `validate`、`validationMessage`、`getModel`、`isStream`、`mapToAISDKInput`、`renderResult`、`renderStreamSSE`、`formatErrors`，可选成员 `getCustomToolNames`、`getHasClientToolSearch`、`getNamespaceFlatMap`（后三个仅 openai-responses 实现）。

## 命令

| 命令                                | 用途                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| `pnpm install`                      | 安装依赖                                                   |
| `pnpm dev serve`                    | 启动开发服务器（tsx watch 热重载）                         |
| `pnpm dev serve --no-watch`         | 启动服务器（无热重载）                                     |
| `pnpm dev models sync`              | 交互式同步上游模型到配置文件                               |
| `pnpm dev models sync -p <name>`    | 同步指定 provider（非交互）                                |
| `pnpm dev models sync --dry-run`    | 预览变更，不写入                                           |
| `pnpm dev models list`              | 列出已配置模型                                             |
| `pnpm dev codex install`            | 配置 Codex CLI（写 `~/.codex/config.toml`，多选+搜索模型） |
| `pnpm test`                         | 全部测试（Vitest，无网络）                                 |
| `pnpm test test/xxx.test.ts`        | 运行单个测试                                               |
| `pnpm typecheck`                    | `tsc --noEmit`                                             |
| `pnpm generate:schema`              | 从 Zod schema 生成 `config/settings.schema.json`           |
| `pnpm format` / `pnpm format:check` | Prettier 格式化 / 检查                                     |

## 架构

### 请求流程

三个 `/v1` 端点共享 `handleProtocolRequest`，通过 `ProtocolStrategy` 策略接口区分协议特定的验证、映射、渲染和错误格式化：

```
Client → Hono app
  ├─ /v1/chat/completions  → handleProtocolRequest(openaiCompatibleStrategy)
  ├─ /v1/responses         → handleProtocolRequest(openaiResponsesStrategy)
  ├─ /v1/messages          → handleProtocolRequest(anthropicStrategy)
  ├─ GET /v1/models[/*]    → listModels 预构建缓存（createApp 作用域一次性构建 modelsList + modelsById）
  ├─ /oauth/*              → OAuth 回调路由（仅 tokenManager && nonce 时挂载：/oauth/login/:provider、/oauth/callback）
  └─ /codex                → createCodexApp 子应用
       ├─ POST /codex/v1/responses  → handleProtocolRequest(openaiResponsesStrategy)
       └─ GET  /codex/v1/models     → buildCodexModelsResponse（4 层 catalog 覆盖）
```

所有端点共享同一个 `RoutingTable`，任意端点都可路由到任意类型的 provider——协议转换的核心：上游只要一种协议，客户端可任选下游格式访问。`/codex` 子应用为 Codex CLI 提供兼容端点，复用 `openaiResponsesStrategy`，并以 codex bundled catalog 格式暴露模型列表。三个 `/v1` 端点与 `/codex` 共享 `ProtocolContext`（`routingTable`/`settings`/`gateway`/`resolveModel`），由 `handleProtocolRequest` 统一编排验证、路由、映射、渲染与错误格式化。

### 核心模块

- **`src/server/`** — Hono HTTP 服务器。`app.ts` 定义路由并组装 `createApp()`，`handle-protocol.ts` 通用请求处理（`ProtocolContext` 携带 `routingTable`/`settings`/`gateway`/`resolveModel`/`errorLogger`），`gateway.ts` 流规范化（`normalizeStream`/`defaultGateway`），`stream-inspect.ts` 首包插件检查，`stream-utils.ts` 请求超时（`withRequestTimeout`/`RequestTimeoutError`）与异步迭代转流，`logging.ts` pino logger 工厂与日志脱敏（`cleanOldLogs` 同时清理 7 天普通日志与 30 天错误日志），`error-logger.ts` 错误日志落盘（NDJSON，截断+脱敏），`tee-stream.ts` 流式 chunk 缓冲包装器（错误日志用），`types.ts` 定义 `ModelGateway`/`AppDependencies`/`AppEnv`，`server.ts` 生产启动入口（加载 settings、插件、OAuth、`serve`、后台刷新 auth 状态），`oauth/` 回调路由与启动期状态刷新。`createApp()` 的 `AppDependencies` 接受 `settings`（必填）及 `providerRegistry`、`gateway`、`logger`、`tokenManager`、`nonce`、`getAuthStatuses`、`pluginRegistry`、`authFilePath`、`codexCatalogCache`、`errorLogger` 覆盖——主要测试接缝，通过 `app.fetch()` 直接测试。
- **`src/providers/`** — Provider 注册表 + 协议策略，二者正交：**provider type**（`openai-compatible`、`anthropic`、`openai`）决定如何用 AI SDK 连上游（工厂），**protocol strategy**（`openaiCompatibleStrategy`、`openaiResponsesStrategy`、`anthropicStrategy`）决定下游请求/响应格式。`registry.ts` 按 `provider.type`（discriminated union）分派到工厂；`anthropic/`、`openai/` 各含 `provider.ts` 工厂，`openai-compatible/` 只有策略（工厂 `createOpenAICompatibleProvider` 在 `shared/provider-factory.ts`），`openai-responses/` 只有策略实现（无工厂，不创建 LanguageModel，复用 `RoutingTable` 解析出的任意 provider 类型的 LanguageModel）。每个策略目录含 `protocol.ts`（请求 schema + AI SDK 映射）、`renderer.ts`（响应渲染）、`strategy.ts`（策略实例）。`shared/` 放共享工厂（`provider-factory.ts`）、`ProtocolStrategy` 接口（`strategy.ts`）、错误格式化（`error-format.ts`）、渲染/映射/SSE/流收集工具（`renderer-utils.ts`/`protocol-utils.ts`/`sse-utils.ts`/`stream-collector.ts`）及 AI SDK 类型（`aisdk-types.ts`）。
- **`src/routing.ts`** — model → provider 映射。
- **`src/cli/`** — Commander.js v15 命令。子命令按目录组织（`serve.ts`、`models/`、`codex/`），每个目录 `index.ts` 导出 `createXxxCommand()`，`cli.ts` 仅 `addCommand` 聚合。业务逻辑保持框架无关。
- **`src/oauth/`** — OAuth Token 管理（Authorization Code + Client Credentials）。
- **`src/plugins/`** — 插件系统。`loader.ts` 加载外部插件，`registry.ts` 管理生命周期与三级插件合并（global → provider → model，同名以 model 级优先），`builtins/vendor-sse-error` 窥视首包检测限流，`types.ts` 定义 `Plugin`/`ProxyPlugin`/`AuthPlugin` 接口，`helpers.ts`/`store-adapter.ts` 提供认证 fetch 与持久化适配。AuthPlugin 仅允许全局级且不能与 provider.oauth 共存。
- **`src/codex-catalog.ts` / `src/codex-types.ts` / `src/server/codex.ts`** — Codex CLI 兼容支持。`CodexCatalogCache` 进程级缓存 `codex debug models --bundled` 输出（懒加载 + 并发去重），`buildCodexModelsResponse` 按 4 层覆盖生成 codex ModelInfo（见「关键设计决策」）。
- **`test/`** — 镜像 `src/` 结构。

### Provider Options 分层

类型特定/行为控制字段统一放 `provider.options`，每个类型有自己的 options schema：

- 通用字段（`streamOnly`、`enableFlatModelLookup`、`reasoning_effort`、`codex`）所有类型共享
- `openai-compatible`：`modelsEndpoint`、`includeUsage`
- `anthropic`：`anthropicVersion`
- `openai`：`organization`、`project`

顶层只保留连接/认证/路由字段（`type`、`baseURL`、`apiKey`、`headers`、`models`、`plugins`、`oauth`）。旧版顶层字段会抛出迁移错误。

## 关键设计决策

- **Provider 类型与协议策略正交**：`providerConfigSchema` 用 `z.discriminatedUnion('type', [...])` 分派 3 种 provider type（连上游），protocol strategy 独立选择下游格式，任意端点可路由到任意 provider type。
- **`${ENV_NAME}` 占位符**：仅匹配完整字符串（`^\$\{...\}$`），部分匹配不替换。
- **OAuth fetch 组合**：OAuth → proxy → global 链式。OAuth 激活时 `apiKey` 设为 `oauth-placeholder` 绕过 SDK 校验，由 OAuth fetch 负责注入真实 `Authorization` 头并删除 SDK 自动添加的认证头。Token 刷新用 30 秒余量。启动时自动刷新过期 token，未认证 provider 打印登录 URL 不阻塞。
- **Anthropic tool_choice**：始终对象格式（`{ type: 'auto' }`），不兼容裸字符串。
- **Provider options 透传**：不在 `mappedRequestKeys` 内的未知字段作为 `providerOptions.{sdkType}` 转发，key 为 SDK 协议标识符（`openaiCompatible`、`anthropic`、`openai`），非用户配置的 provider 名称。openai-compatible 策略额外写一份 `providerOptions.openai`，使 `/v1/chat/completions` 路由到 openai-type provider 时 `@ai-sdk/openai` 能读到；部分已知字段（`parallel_tool_calls`、`reasoning` 等）显式做 snake_case→camelCase 转换后塞入。
- **Logger DI**：`createProviderRegistry` 依赖注入 `Logger`，不耦合实现。
- **Codex catalog 4 层覆盖**：`/codex/v1/models` 为每个模型 id 生成一条 ModelInfo——基底取 codex bundled catalog 中 `templateSlug` 对应条目，`slug`/`display_name` 固定为 id，再按 `settings.codex.models_catalog` → `provider.options.codex` → `model.codex` 三层 catalog override 覆盖。`templateSlug` 缺失时逐层 fallback，全缺省则动态取 catalog 首个 `supported_in_api` slug；`context_window` 缺失时按 `model.limit.context` → 各层 `codex.context_window` → `settings.codex.models_catalog.context_window`（默认 200000）fallback。`reasoning_effort`（模型属性，2 层 model + provider）在 catalog override 之前应用，映射到 `default_reasoning_level` / `supported_reasoning_levels`；raw catalog override 作为 escape hatch 可覆盖。`CodexCatalogCache` 在 `createApp` 作用域单例，禁 per-request new。
- **Codex install 配置**：`settings.codex.install`（providerId 默认 `llm-proxy`、providerName 默认 `LLM Proxy`、requiresOpenaiAuth 默认 `false`、checkForUpdateOnStartup 默认 `false`）控制 `pnpm dev codex install` 写入 `~/.codex/config.toml` 的 provider table 与顶层 `check_for_update_on_startup`；默认模型的 `default_reasoning_level` 非空时写入 `model_reasoning_effort` 顶层 key。
- **错误日志**：`settings.errorLogging`（`enabled` 默认 `true`、`maxBodyLength` 默认 256KB）控制上游异常时的完整入参+出参落盘。`handleProtocolRequest` 在流式（含 streamOnly）、非流式三路径的 `handleUpstreamError` 及流消费 `onError` 中触发 `ErrorLogger.log()`，排除 400/404/429/503（OAuthError）。流式路径用 `teeStream` 缓冲 chunk 引用（`enabled` 为 `false` 时跳过，零开销），出错时连同入参写入 `logs/errors-YYYY-MM-DD.ndjson`（中国时区日期，30 天轮转）。`ErrorLogger` 在 `createApp` 作用域单例，通过 `AppDependencies` 注入。

## TypeScript

`tsconfig.base.json` 启用 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`verbatimModuleSyntax`。**所有本地导入必须用 `.js` 扩展名**（ESM + `NodeNext`）。

## 敏感数据

- 禁止提交 `.env`、`settings.jsonc`、`auth.json` 或真实 API key
- 日志自动脱敏：`apikey`、`api_key`、`authorization`、`x-api-key`、`proxy-authorization`（不区分大小写）
- OAuth `clientSecret` 应使用 `${ENV_VAR}` 占位符

## 当前范围（v0）

- 支持 `openai-compatible`、`anthropic`、`openai` 三种 provider 类型
- 不做下游客户端鉴权、计费、配额、多租户、数据库或 Web UI
- 响应形状以 OpenAI Chat Completions 兼容为目标，不保证逐字段原样透传上游响应
