# TypeScript AI SDK Proxy 设计

## 背景

`llm-proxy-ts` 是现有 Python `llm-proxy` 的 TypeScript 重新设计版本。Python 版本已经验证了本地优先 LLM 反向代理的核心能力，包括 OpenAI-compatible provider/model 路由、`/v1/chat/completions` 非流式和 SSE 流式代理、JSONC 配置、上游错误安全处理、provider/model 级插件配置和 `/health` 健康检查。

TypeScript 版本不逐字迁移 Python 内部实现，而是保留已验证的行为边界，按 TypeScript、Hono 和 Vercel AI SDK 重新设计。目标是构建一个本地优先的 SDK 代理和协议网关：对下游客户端暴露稳定协议入口，对上游供应商通过可配置 provider adapter 调用，并在中间统一处理路由、插件、错误和日志。

## 目标

- 使用 `pnpm` 管理依赖。
- 使用 monorepo 结构，为后续 Web UI 预留空间。
- 首版实现 `apps/server`，基于 Node.js 和 Hono 提供 API 服务。
- 首版对外提供 OpenAI Chat Completions compatible `POST /v1/chat/completions`。
- 首版 provider 类型只实现 `openai-compatible`，内部调用强制走 Vercel AI SDK。
- 用 `@ai-sdk/openai-compatible` 调用 OpenAI-compatible 上游供应商。
- 用自定义 protocol renderer 将 AI SDK 结果渲染回 OpenAI-compatible JSON 或 SSE。
- 支持 OpenAI function tools 和 tool calls，且代理不在本地执行工具。
- 支持 JSONC 配置、`${ENV_NAME}` 占位和明文 `apiKey`。
- 支持 root 级 outbound proxy 配置。
- 支持 provider/model 路由、alias 和可选 flat lookup。
- 支持 provider/model 级插件配置，并实现内置 `vendor_sse_error`。
- 提供结构化日志、request id 和敏感信息脱敏。
- 用 Vitest 覆盖配置、路由、渲染、tools、插件和安全错误处理。

## 非目标

- 首版不开发 Web UI，但仓库结构为 Web UI 预留 `apps/web` 空间。
- 首版不做下游客户端鉴权；本地使用时客户端可直接调用代理。
- 首版不引入数据库、管理后台、计费、配额或多租户能力。
- 首版不开放外部插件动态加载，只实现内置插件和 `PluginRegistry` 边界。
- 首版不实现 Anthropic Messages 或 OpenAI Responses 对外 endpoint。
- 首版不承诺逐字段或逐 chunk 原样保真上游供应商响应。
- 首版不支持 provider-defined tools、OpenAI hosted tools 或 Anthropic native tools。

## 技术栈

- Runtime: Node.js。
- HTTP framework: Hono。
- Package manager: pnpm。
- Monorepo workspace: pnpm workspace。
- AI abstraction: Vercel AI SDK `ai`。
- OpenAI-compatible provider: `@ai-sdk/openai-compatible`。
- Config validation: Zod 作为运行时配置模型和校验的单一事实来源。
- JSON Schema generation: 使用 `zod-to-json-schema` 或等价工具从 Zod schema 自动生成 `settings.schema.json`，不手写维护 schema 文件。
- JSONC parsing: `jsonc-parser`。
- Testing: Vitest。
- Logging: pino。

## 仓库结构

首版建议结构：

```text
apps/
  server/
    src/
      server.ts
      app.ts
      config.ts
      routing.ts
      protocols/
        openai-chat.ts
        openai-chat-renderer.ts
      providers/
        registry.ts
        openai-compatible.ts
      plugins/
        types.ts
        registry.ts
        vendor-sse-error.ts
      logging.ts
    config/
      settings.example.jsonc
      settings.schema.json
packages/
  shared/                  # 后续 Web UI 或 CLI 需要共享类型时再创建
```

首版实际实现 `apps/server`。`packages/shared` 不在首版强制创建，避免空包；当 Web UI 或 CLI 需要共享配置 schema、协议类型或工具函数时再提取。

## 运行时架构

核心请求链路：

```text
OpenAI-compatible client
-> Hono /v1/chat/completions
-> request schema validation
-> model selector routing
-> plugin pipeline
-> AI SDK provider adapter
-> protocol renderer
-> OpenAI-compatible JSON/SSE response
```

模块职责：

- `app.ts` 创建 Hono app，注册 `/health` 和 `/v1/chat/completions`。
- `server.ts` 读取配置并启动 Node HTTP server。
- `config.ts` 负责 JSONC 加载、环境变量占位解析、Zod 校验和触发 schema 生成工具输出 `settings.schema.json`。
- `routing.ts` 负责从客户端 `model` selector 解析出 provider、model route、upstream model、headers 和 plugins。
- `providers/registry.ts` 根据 provider config 创建 AI SDK provider adapter。
- `providers/openai-compatible.ts` 使用 `@ai-sdk/openai-compatible` 创建上游模型。
- `protocols/openai-chat.ts` 定义 OpenAI Chat Completions 请求、响应和错误的协议类型与校验。
- `protocols/openai-chat-renderer.ts` 将 AI SDK `generateText` / `streamText` 结果渲染为 OpenAI-compatible JSON/SSE。
- `plugins/*` 定义插件生命周期、注册表和内置插件。
- `logging.ts` 提供结构化日志、request id 和敏感字段脱敏。

## 配置设计

默认配置路径为 `apps/server/config/settings.jsonc`。仓库提交 `settings.example.jsonc` 和由 Zod schema 生成的 `settings.schema.json`，真实 `settings.jsonc` 加入 `.gitignore`。

示例：

```jsonc
{
  "$schema": "./settings.schema.json",
  "service": {
    "name": "llm-proxy",
    "host": "127.0.0.1",
    "port": 8000,
  },
  "requestTimeoutMs": 30000,
  "proxy": {
    "url": "http://127.0.0.1:7890",
    "verify": false,
  },
  "routing": {
    "enableFlatModelLookup": false,
  },
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "headers": {
        "HTTP-Referer": "http://localhost",
        "X-Title": "llm-proxy",
      },
      "plugins": [
        {
          "name": "vendor_sse_error",
          "config": {
            "maxPreviewEvents": 3,
            "maxPreviewBytes": 65536,
            "rateLimitCodes": ["rate_limit", "too_many_requests"],
          },
        },
      ],
      "models": {
        "deepseek-r1": {
          "upstreamModel": "deepseek/deepseek-r1",
          "aliases": ["default"],
          "headers": {},
          "plugins": [],
        },
      },
    },
    "example-inline-key": {
      "type": "openai-compatible",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "ak-xxx",
      "models": {},
    },
  },
}
```

配置规则：

- `providers` 是按 provider 名称索引的对象，provider 名称来自对象 key。
- `type` 首版只支持 `openai-compatible`。
- `settings.schema.json` 必须由 `zod-to-json-schema` 或等价工具从运行时 Zod 配置模型生成，不能手写或与运行时校验模型分叉维护。
- `apiKey` 支持 `${ENV_NAME}` 占位和明文字符串。
- 示例和文档推荐 `${ENV_NAME}`，但运行时允许明文以便本地快速验证。
- 所有日志、错误和测试快照都不得输出真实 `apiKey`。
- provider/model headers 合并时，model headers 覆盖 provider headers。
- provider `apiKey` 对认证 header 保持权威；配置 headers 不允许覆盖认证头。
- provider plugins 默认应用于该 provider 下所有模型；model 级同名 plugin 覆盖 provider 级配置。

## Proxy 设计

`proxy` 是 root 级 outbound proxy 配置，默认不存在。

- `proxy.url` 支持 HTTP/HTTPS proxy URL。
- `proxy.verify` 控制 TLS 证书验证，默认 `true`。
- proxy 只作用于上游 provider 请求，不影响 Hono 入站服务。
- 如果 AI SDK provider 的普通配置无法直接设置 proxy，则 provider factory 通过自定义 `fetch` 注入 proxy 能力。
- Node 侧可用 undici dispatcher/proxy agent 或等价实现。
- 日志只记录 proxy 是否启用和主机信息，不记录可能包含凭据的完整 proxy URL。

## 路由设计

保留 Python 版已验证的 routing 概念，TypeScript 字段命名使用 camelCase。

关键类型概念：

- `Settings`
- `ProviderConfig`
- `ModelRouteConfig`
- `PluginConfig`
- `RoutingTable`
- `RouteMatch`
- `RoutingError`

行为：

- `model: "openrouter/deepseek-r1"` 解析为 provider `openrouter` 和 model route `deepseek-r1`。
- 上游 AI SDK model id 使用 route 的 `upstreamModel`。
- `enableFlatModelLookup=false` 时，不带 provider 前缀的 model selector 返回 `flat_lookup_disabled`。
- `enableFlatModelLookup=true` 时，model key 和 aliases 可作为 flat selector，但必须全局唯一。
- provider 不存在返回 `unknown_provider`。
- model 不存在返回 `unknown_model`。
- 没有配置任何 provider 返回 `no_providers_configured`。
- 路由错误发生在上游调用前，不触发 provider。

## AI SDK 调用设计

首版所有 provider 调用都走 AI SDK，不保留 passthrough 分支。

非流式链路：

```text
OpenAI Chat request
-> validateOpenAIChatRequest
-> RoutingTable.resolve(model)
-> buildAISDKCallInput(route, request)
-> plugin.beforeProviderCall
-> generateText(...)
-> plugin.afterProviderResult
-> renderOpenAIChatCompletion(result)
```

流式链路：

```text
OpenAI Chat request stream=true
-> validateOpenAIChatRequest
-> RoutingTable.resolve(model)
-> buildAISDKStreamInput(route, request)
-> plugin.beforeProviderCall
-> streamText(...)
-> renderOpenAIChatCompletionSSE(fullStream)
-> plugin.inspectStreamChunk / mapProviderError
```

OpenAI request 到 AI SDK 输入的映射：

- `messages` 映射到 AI SDK `messages`。
- `temperature`、`top_p`、`presence_penalty`、`frequency_penalty`、`stop` 等常用参数映射到 AI SDK settings。
- `max_tokens` 和 `max_completion_tokens` 映射为 `maxOutputTokens`，同时出现时优先 `max_completion_tokens`。
- `stream` 决定调用 `generateText` 或 `streamText`。
- provider/model headers 合并后传给 AI SDK 调用。
- 未识别的 provider-specific 字段尽量放入 `providerOptions[providerName]`；不能映射时记录 debug 日志。
- `parallel_tool_calls` 如 AI SDK/provider 支持则通过 provider options 传递；不支持时记录 warning。

## OpenAI Chat Completions 渲染设计

首版兼容目标是 OpenAI Chat Completions 协议形状，而不是上游原始响应逐字段保真。供应商特殊字段能从 AI SDK 的 `response.body`、`providerMetadata`、raw stream chunk 中安全补充就补充；不能补充就记录结构化日志。

非流式响应：

- `id` 优先使用 AI SDK response/provider metadata 中可用 ID，否则生成 `chatcmpl_<id>`。
- `object` 固定为 `chat.completion`。
- `created` 使用上游 timestamp 或当前 Unix 秒。
- `model` 默认返回客户端请求里的 model selector。
- `choices[0].message.role` 固定为 `assistant`。
- `choices[0].message.content` 来自 AI SDK `text`。
- `finish_reason` 从 AI SDK `finishReason` 映射为 OpenAI 风格：`stop`、`length`、`content_filter`、`tool_calls` 或 `null`。
- `usage` 从 AI SDK usage 映射为 `prompt_tokens`、`completion_tokens`、`total_tokens`；未知字段省略。
- provider 特殊字段只在 renderer 明确认可或通过安全白名单时透传。

流式响应：

- SSE `content-type` 为 `text/event-stream`。
- 每个 `text-delta` 渲染为 OpenAI `chat.completion.chunk`。
- 结束时输出带 `finish_reason` 的 chunk，再输出 `data: [DONE]`。
- 如果响应头已经发送后出现 provider 错误，只能输出安全 error chunk 或中断流，并记录日志。
- 如果错误可在响应头发送前识别，插件可以改写为 JSON 错误响应。

## Tools 设计

OpenAI function tools 是首版核心能力。代理只负责协议转换和模型 tool call 返回，不在本地执行工具。

请求映射：

- OpenAI `tools` 中的 `type: "function"` 映射为 AI SDK tool definition。
- `function.name`、`function.description`、`function.parameters` 映射到 AI SDK tool 的名称、描述和 JSON Schema。
- AI SDK tool 不提供 `execute`，让模型只生成 tool call。
- `tool_choice: "auto" | "none" | "required"` 映射到 AI SDK `toolChoice`。
- `tool_choice: { "type": "function", "function": { "name": "..." } }` 映射为指定工具。
- OpenAI assistant message 中已有 `tool_calls` 映射为 AI SDK assistant tool-call parts。
- OpenAI `role: "tool"` message 映射为 AI SDK tool result message。
- `tool_call_id` 必须保留，用于多轮工具调用对齐。
- malformed tool result 返回 400 兼容错误，不调用上游。

非流式响应：

- AI SDK `toolCalls` 渲染为 OpenAI `choices[0].message.tool_calls`。
- 每个 tool call 包含 `id`、`type: "function"`、`function.name`、`function.arguments`。
- `function.arguments` 必须是 JSON string。
- 有 tool calls 时 `finish_reason` 映射为 `tool_calls`。
- 如果同时有文本和 tool calls，尽量同时保留 `content` 和 `tool_calls`。

流式响应：

- AI SDK full stream 中的 tool call start/delta/complete 事件渲染为 OpenAI SSE `delta.tool_calls`。
- 每个 tool call 分配稳定 `index`。
- function arguments 增量按字符串 chunk 输出。
- 如果 AI SDK 只提供完整 tool call，没有细粒度 arguments delta，首版可一次性输出完整 `arguments` chunk。
- 最终 finish chunk 使用 `finish_reason: "tool_calls"`。

## 插件设计

插件配置继续使用 Python 版方向：`plugins: [{ name, config }]`。首版只加载内置插件，但实现 `PluginRegistry`，以后可以扩展外部插件加载。

插件生命周期：

```ts
interface ProxyPlugin {
  name: string

  beforeRequest?(ctx: PluginContext): Promise<void | PluginResponse>
  beforeProviderCall?(ctx: PluginContext): Promise<void | ProviderCallPatch>
  afterProviderResult?(ctx: PluginContext): Promise<void | ProviderResultPatch>
  inspectStreamChunk?(ctx: PluginContext): Promise<void | PluginResponse>
  mapProviderError?(ctx: PluginContext): Promise<void | PluginResponse>
}
```

首版内置插件：

- `vendor_sse_error`：处理部分供应商在流式事件或 raw chunk 中返回错误的行为。
- 它检查 AI SDK `fullStream` 中的 `raw`、`error` 或可解析 chunk。
- 如果响应头发送前命中限流等错误，返回 JSON `429`。
- 如果响应已经开始，只能输出安全错误 chunk 或中断流，并记录日志。

插件解析规则：

- provider 级 plugins 默认应用到该 provider 下所有模型。
- model 级 plugins 追加到 provider 级配置。
- 同名 plugin 由 model 级覆盖 provider 级，避免重复执行。
- 未知插件名在配置加载或 registry 构建阶段报错。

## 错误处理和安全

错误响应原则：返回可预测、兼容、脱敏的 JSON body，不泄露本地和上游密钥。

- 路由错误返回 OpenAI-compatible error body，`type` 使用 `routing_error`。
- 上游超时返回 `504`。
- 网络或未知上游请求失败返回 `502`。
- provider status error 尽量保留安全 status code 和公开 body；敏感 headers 不透传。
- 客户端 `Authorization` 不转发到上游。
- provider/model headers 中的 `authorization` 大小写变体不能覆盖 provider `apiKey` 认证。
- 响应 headers 只透出安全字段，例如 `content-type` 和 `x-request-id`。
- `apiKey`、客户端 Authorization、敏感 headers、完整 proxy URL、疑似密钥的 tool 参数不得进入日志或响应。

## 日志设计

使用 pino 输出结构化日志。

每个请求生成 `requestId`，并通过响应 header `x-request-id` 返回。

常规日志字段：

- `requestId`
- `protocol`
- `provider`
- `modelSelector`
- `upstreamModel`
- `stream`
- `statusCode`
- `durationMs`
- `errorType`

默认日志级别为 `info`，可通过 `LOG_LEVEL=debug` 开启调试日志。供应商特殊字段无法透传时，在 debug 日志中记录字段名和原因，不记录完整敏感内容。

## 测试设计

使用 Vitest。Hono app 通过内存请求测试，AI SDK 调用层通过 mock provider 或 mock adapter 测试。

测试覆盖：

- `/health` 返回本地状态，不触发 provider。
- JSONC 配置加载成功。
- `${ENV_NAME}` 和明文 `apiKey` 都支持。
- root `proxy` 配置能传入 provider fetch/transport 层。
- `provider/model` 路由成功。
- provider 内 alias 路由成功。
- flat lookup 启用、禁用和歧义错误。
- 路由错误不调用 provider。
- provider/model headers 合并且不能覆盖 API key auth。
- 纯文本非流式 OpenAI Chat Completions 响应渲染。
- 纯文本 SSE OpenAI Chat Completions chunk 渲染。
- function tools 请求映射为 AI SDK tools，且不执行本地工具。
- 非流式 tool calls 渲染成 OpenAI `message.tool_calls`。
- 流式 tool calls 渲染成 OpenAI `delta.tool_calls`。
- 多轮 `role: tool` 输入可映射。
- malformed tool result 返回 400 且不调用上游。
- 上游超时返回安全 `504`。
- 上游网络错误返回安全 `502`。
- `vendor_sse_error` 命中后在响应头发送前返回 `429`。
- 日志和响应不泄露 provider key、客户端 Authorization、敏感 headers、完整 proxy URL。

## 验收标准

- `pnpm install` 后可在 monorepo 中启动 `apps/server`。
- `GET /health` 返回服务状态和 provider 数量。
- `POST /v1/chat/completions` 支持 OpenAI Chat Completions compatible 非流式请求。
- `POST /v1/chat/completions` 支持 `stream=true` 并返回 OpenAI-compatible SSE。
- 首版 provider type `openai-compatible` 通过 Vercel AI SDK 调上游。
- provider/model 路由、alias 和 flat lookup 行为符合设计。
- function tools 和 tool calls 在非流式、流式、多轮输入中可用。
- JSONC 配置支持 `${ENV_NAME}` 和明文 `apiKey`。
- root proxy 配置作用于上游请求。
- 内置 `vendor_sse_error` 插件可把已识别的流式供应商限流错误转换为 `429` JSON。
- 所有错误和日志遵守脱敏规则。
- Vitest 测试通过。
