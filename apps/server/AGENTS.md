# AGENTS.md — @llm-proxy/server

本包是 Hono HTTP 服务器，暴露 OpenAI Chat Completions 兼容 API。依赖 `@llm-proxy/core` 提供配置、Provider 工厂、协议映射、路由和插件等业务逻辑。

## 请求流程

```
Client → Hono app (/v1/chat/completions)
  → validateOpenAIChatRequest（Zod 校验，core）
  → RoutingTable.resolve(provider/model)（core）
  → mapOpenAIChatRequestToAISDKInput（OpenAI → AI SDK 格式，core）
  → ProviderRegistry.languageModel()（创建 AI SDK 模型实例，core）
  → gateway.generate() 或 gateway.stream()（AI SDK generateText/streamText）
  → renderOpenAIChatCompletion 或 renderOpenAIChatCompletionSSE（core）
  → Client
```

## 命令

| 命令                   | 作用                                                 |
| ---------------------- | ---------------------------------------------------- |
| `pnpm generate:schema` | 从 Zod schema 重新生成 `config/settings.schema.json` |

## 模块职责

| 模块                | 职责                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`         | 入口，解析配置路径，OAuth 初始化，启动 `@hono/node-server`                                                                       |
| `app.ts`            | Hono 应用工厂，路由处理器，超时逻辑，流检查，OAuthError 处理；可注入 `ModelGateway`、`ProviderRegistry`、`TokenManager` 用于测试 |
| `logging.ts`        | Pino 日志，请求 ID 生成，敏感信息脱敏                                                                                            |
| `oauth/callback.ts` | OAuth 回调端点 — `/oauth/login/:provider`（重定向到授权 URL）、`/oauth/callback`（交换授权码）                                   |
| `oauth/startup.ts`  | OAuth 启动校验 — 遍历 OAuth provider，自动刷新过期 token，打印需要登录的 provider URL                                            |

## 设计决策

- **可注入依赖：** `createApp()` 接受 `ModelGateway`、`ProviderRegistry`、`TokenManager` 覆盖。测试通过注入避免真实上游调用。
- **OAuth 认证：** Provider 配置 `oauth` 后，通过自定义 `fetch` 函数在每次请求时动态注入 `Authorization` 头。OAuth fetch 与 proxy fetch 可组合（OAuth → proxy → global）。OAuth 优先于静态 `apiKey`。
- **OAuth 启动校验：** 服务启动时检查 OAuth provider 的 token 状态，自动刷新过期 token，未认证的 provider 打印登录 URL 且不阻塞启动。
- **流首包检查：** `vendor_sse_error` 插件在转发前窥视第一个 SSE chunk — 检测到限流错误时中断流并返回 429。
- **Provider options 透传：** 请求中不在 `mappedRequestKeys` 集合内的未知字段，作为 `providerOptions.{providerName}` 转发给 AI SDK。

## 配置

- 默认配置：`config/settings.jsonc`（已 gitignore，禁止提交）
- 示例配置：`config/settings.example.jsonc`
- 路径覆盖：`LLM_PROXY_SETTINGS_FILE` 环境变量
- JSON Schema：`config/settings.schema.json`（自动生成，不要手动编辑）

### 敏感数据规则

- 禁止提交 `.env`、`settings.jsonc`、`auth.json` 或真实 API key。
- 日志自动脱敏的 key：`apikey`、`api_key`、`authorization`、`x-api-key`、`proxy-authorization`（不区分大小写）。
- API key 选择日志仅记录 provider 名称、key 索引和总数。
- OAuth `clientSecret` 应使用 `${ENV_VAR}` 占位符，避免写入配置文件明文。

## 关键依赖

| 依赖                | 用途                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| `ai`                | Vercel AI SDK（`generateText`/`streamText`）                                  |
| `hono`              | HTTP 框架                                                                     |
| `@hono/node-server` | Node.js 适配器                                                                |
| `pino`              | 结构化日志源；console 和 `.log` 文件默认输出 Java/Python 风格 plain text 日志 |
| `@llm-proxy/core`   | 配置、Provider 工厂、协议映射、路由、插件（`workspace:*`）                    |

## 测试

通过 `app.fetch()` 直接测试 Hono 应用，无需 HTTP 服务器。`createApp()` 依赖注入是主要测试接缝。

`vitest.config.ts` 配置了 `@llm-proxy/core` 路径别名，指向 `../core/src/index.ts`。

| 测试文件                       | 覆盖                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `chat-endpoint.test.ts`        | Chat Completions 端点（非流式 + 流式）                                                               |
| `models-endpoint.test.ts`      | `/v1/models` 端点                                                                                    |
| `health.test.ts`               | 健康检查                                                                                             |
| `logging.test.ts`              | 日志脱敏和请求 ID                                                                                    |
| `oauth-callback.test.ts`       | OAuth 回调端点                                                                                       |
| `oauth-startup.test.ts`        | OAuth 启动校验                                                                                       |
| `oauth-registry.test.ts`       | OAuth Provider 注册和 fetch 注入                                                                     |
| `security-and-plugins.test.ts` | 插件合并和安全                                                                                       |
| `smoke.test.ts`                | 真实上游流式测试（需 `LLM_PROXY_TEST_BASE_URL` + `LLM_PROXY_TEST_API_KEY` + `LLM_PROXY_TEST_MODEL`） |
