# AGENTS.md — @llm-proxy/server

本包是 Hono HTTP 服务器，暴露 OpenAI Chat Completions 兼容 API。依赖 `@llm-proxy/core` 提供配置和 Provider 工厂。

## 请求流程

```
Client → Hono app (/v1/chat/completions)
  → validateOpenAIChatRequest（Zod 校验）
  → RoutingTable.resolve(provider/model)
  → mapOpenAIChatRequestToAISDKInput（OpenAI → AI SDK 格式）
  → ProviderRegistry.languageModel()（创建 AI SDK 模型实例）
  → gateway.generate() 或 gateway.stream()（AI SDK generateText/streamText）
  → renderOpenAIChatCompletion 或 renderOpenAIChatCompletionSSE
  → Client
```

## 命令

| 命令 | 作用 |
|---|---|
| `pnpm generate:schema` | 从 Zod schema 重新生成 `config/settings.schema.json` |

## 模块职责

| 模块 | 职责 |
|---|---|
| `server.ts` | 入口，解析配置路径，启动 `@hono/node-server` |
| `app.ts` | Hono 应用工厂，路由处理器，超时逻辑，流检查；可注入 `ModelGateway` 和 `ProviderRegistry` 用于测试 |
| `routing.ts` | `RoutingTable` — 解析 `provider/model` 选择器和别名，支持可选的扁平模型查找 |
| `providers/registry.ts` | `ProviderRegistry` — 创建 AI SDK `LanguageModel` 实例，处理 apiKey 数组的轮询选择 |
| `protocols/openai-chat.ts` | 请求校验（Zod）+ OpenAI 格式到 AI SDK 输入的映射（messages、tools、tool_choice、provider options） |
| `protocols/openai-chat-renderer.ts` | 将 AI SDK 结果渲染回 OpenAI Chat Completion 格式（非流式 + SSE 流式含 tool calls） |
| `protocols/openai-models.ts` | `/v1/models` 和 `/v1/models/*` 端点，从配置生成模型列表 |
| `plugins/registry.ts` | 插件名校验，provider/model 插件合并（model 按 name 覆盖 provider） |
| `plugins/types.ts` | 插件类型定义 |
| `plugins/vendor-sse-error.ts` | 在转发前检查 SSE chunk 中的上游限流错误 |
| `logging.ts` | Pino 日志，请求 ID 生成，敏感信息脱敏 |

## 设计决策

- **可注入依赖：** `createApp()` 接受 `ModelGateway` 和 `ProviderRegistry` 覆盖。测试通过注入避免真实上游调用。
- **API Key 轮询：** `apiKey` 为数组时，`ProviderRegistry` 按请求循环选择 key（索引按 provider name 追踪）。
- **流首包检查：** `vendor_sse_error` 插件在转发前窥视第一个 SSE chunk — 检测到限流错误时中断流并返回 429。
- **Provider options 透传：** 请求中不在 `mappedRequestKeys` 集合内的未知字段，作为 `providerOptions.{providerName}` 转发给 AI SDK。

## 配置

- 默认配置：`config/settings.jsonc`（已 gitignore，禁止提交）
- 示例配置：`config/settings.example.jsonc`
- 路径覆盖：`LLM_PROXY_SETTINGS_FILE` 环境变量
- JSON Schema：`config/settings.schema.json`（自动生成，不要手动编辑）

### 敏感数据规则

- 禁止提交 `.env`、`settings.jsonc` 或真实 API key。
- 日志自动脱敏的 key：`apikey`、`api_key`、`authorization`、`x-api-key`、`proxy-authorization`（不区分大小写）。
- API key 选择日志仅记录 provider 名称、key 索引和总数。

## 关键依赖

| 依赖 | 用途 |
|---|---|
| `ai` | Vercel AI SDK（`generateText`/`streamText`） |
| `hono` | HTTP 框架 |
| `@hono/node-server` | Node.js 适配器 |
| `pino` + `pino-pretty` + `pino-roll` | 结构化日志（控制台 pretty + 文件 pretty + 滚动） |
| `@llm-proxy/core` | 配置、Provider 工厂（`workspace:*`） |

## 测试

通过 `app.fetch()` 直接测试 Hono 应用，无需 HTTP 服务器。`createApp()` 依赖注入是主要测试接缝。

`vitest.config.ts` 配置了 `@llm-proxy/core` 路径别名，指向 `../core/src/index.ts`。

| 测试文件 | 覆盖 |
|---|---|
| `chat-endpoint.test.ts` | Chat Completions 端点（非流式 + 流式） |
| `models-endpoint.test.ts` | `/v1/models` 端点 |
| `health.test.ts` | 健康检查 |
| `openai-chat.test.ts` | 请求校验和映射 |
| `openai-chat-renderer.test.ts` | 响应渲染 |
| `routing.test.ts` | 路由解析和别名 |
| `provider-registry.test.ts` | Provider 注册和 API key 轮询 |
| `security-and-plugins.test.ts` | 插件合并和安全 |
| `smoke.test.ts` | 真实上游流式测试（需 `LLM_PROXY_TEST_BASE_URL` + `LLM_PROXY_TEST_API_KEY` + `LLM_PROXY_TEST_MODEL`） |
