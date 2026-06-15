# AGENTS.md

本文件为 AI 代理提供架构与开发指导。

## 项目概述

`llm-proxy-ts` 是本地优先的 LLM 协议转换代理。核心能力：将上游 provider（无论其原生协议）同时以多种下游协议格式暴露——同一个上游可以同时提供 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 等 API。通过 Vercel AI SDK 统一调用上游，再由各协议的 renderer 渲染成对应格式返回客户端。新增协议只需实现 `ProtocolStrategy` 接口（`validate`、`getModel`、`isStream`、`mapToAISDKInput`、`renderResult`、`renderStreamSSE`、`formatErrors`）。

## 命令

| 命令 | 用途 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm dev serve` | 启动开发服务器（tsx watch 热重载） |
| `pnpm dev serve --no-watch` | 启动服务器（无热重载） |
| `pnpm dev models sync` | 交互式同步上游模型到配置文件 |
| `pnpm dev models list` | 列出已配置模型 |
| `pnpm test` | 全部测试（Vitest，无网络） |
| `pnpm test test/xxx.test.ts` | 运行单个测试 |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm generate:schema` | 从 Zod schema 生成 `config/settings.schema.json` |

## 架构

### 请求流程

三个端点共享 `handleProtocolRequest`，通过 `ProtocolStrategy` 策略接口区分协议特定的验证、映射、渲染和错误格式化：

```
Client → Hono app
  ├─ /v1/chat/completions  → handleProtocolRequest(openaiCompatibleStrategy)
  ├─ /v1/responses         → handleProtocolRequest(openaiResponsesStrategy)
  └─ /v1/messages          → handleProtocolRequest(anthropicStrategy)
```

三个端点共享同一个 `RoutingTable`，任意端点都可路由到任意类型的 provider——协议转换的核心：上游只要一种协议，客户端可任选下游格式访问。

### 核心模块

- **`src/server/`** — Hono HTTP 服务器。`app.ts` 定义路由，`handle-protocol.ts` 通用请求处理，`gateway.ts` / `stream-inspect.ts` / `stream-utils.ts` 处理流和超时。`createApp()` 接受 `ModelGateway`、`ProviderRegistry`、`TokenManager` 覆盖——主要测试接缝，通过 `app.fetch()` 直接测试。
- **`src/providers/`** — Provider 注册表 + 协议策略。`registry.ts` 按 `provider.type`（discriminated union）分派到对应工厂。每种协议一个子目录（`openai-compatible/`、`openai-responses/`、`anthropic/`），各含 `protocol.ts`（请求 schema + AI SDK 映射）、`renderer.ts`（响应渲染）、`strategy.ts`（策略实例）。`shared/` 放共享工厂、渲染工具和 `ProtocolStrategy` 接口。
- **`src/routing.ts`** — model → provider 映射。
- **`src/cli/`** — Commander.js v15 命令。每命令一个 `create*Command()` 函数，业务逻辑保持框架无关。新增命令：写 `createXxxCommand()` → 在 `cli.ts` 或 `models.ts` 中 `addCommand()`。
- **`src/oauth/`** — OAuth Token 管理（Authorization Code + Client Credentials）。
- **`src/plugins/`** — 插件系统。`loader.ts` 加载外部插件，`registry.ts` 管理生命周期，`vendor-sse-error` 窥视首包检测限流。
- **`test/`** — 镜像 `src/` 结构。

### Provider Options 分层

类型特定/行为控制字段统一放 `provider.options`，每个类型有自己的 options schema：

- 通用字段（`streamOnly`、`enableFlatModelLookup`）所有类型共享
- `openai-compatible`：`modelsEndpoint`、`includeUsage`
- `anthropic`：`anthropicVersion`
- `openai`：`organization`、`project`

顶层只保留连接/认证/路由字段（`type`、`baseURL`、`apiKey`、`headers`、`models`、`plugins`、`oauth`）。旧版顶层字段会抛出迁移错误。

## 关键设计决策

- **Provider 类型**：`providerConfigSchema` 用 `z.discriminatedUnion('type', [...])`，`registry.ts` 按 type 分派。
- **`${ENV_NAME}` 占位符**：仅匹配完整字符串（`^\$\{...\}$`），部分匹配不替换。
- **OAuth fetch 组合**：OAuth → proxy → global 链式。OAuth 激活时 `apiKey` 设为 `oauth-placeholder` 绕过 SDK 校验，由 OAuth fetch 负责注入真实 `Authorization` 头并删除 SDK 自动添加的认证头。Token 刷新用 30 秒余量。启动时自动刷新过期 token，未认证 provider 打印登录 URL 不阻塞。
- **Anthropic tool_choice**：始终对象格式（`{ type: 'auto' }`），不兼容裸字符串。
- **Provider options 透传**：不在 `mappedRequestKeys` 内的未知字段作为 `providerOptions.{sdkType}` 转发，key 为 SDK 协议标识符（如 `openaiCompatible`、`anthropic`、`openai`），非用户配置的 provider 名称。
- **Logger DI**：`createProviderRegistry` 依赖注入 `Logger`，不耦合实现。

## TypeScript

`tsconfig.base.json` 启用 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`verbatimModuleSyntax`。**所有本地导入必须用 `.js` 扩展名**（ESM + `NodeNext`）。

## 敏感数据

- 禁止提交 `.env`、`settings.jsonc`、`auth.json` 或真实 API key
- 日志自动脱敏：`apikey`、`api_key`、`authorization`、`x-api-key`、`proxy-authorization`（不区分大小写）
- OAuth `clientSecret` 应使用 `${ENV_VAR}` 占位符

## 当前范围（v0）

- 仅支持 `openai-compatible` 和 `anthropic` provider 类型
- 不做下游客户端鉴权、计费、配额、多租户、数据库或 Web UI
- 响应形状以 OpenAI Chat Completions 兼容为目标，不保证逐字段原样透传上游响应
