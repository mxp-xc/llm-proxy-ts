# streamOnly: Provider 强制流式适配设计

**日期：** 2026-06-13
**状态：** Draft

## 背景

某些上游 LLM provider 仅提供 streaming API，不支持非流式请求。当客户端发送 `stream: false` 时，proxy 需要内部走流式调用，收集完整结果后渲染为非流式响应返回。

## 需求

- 在 provider 级别配置 `options.streamOnly: true`，声明该 provider 仅支持流式 API
- 当客户端发 `stream: false` 请求到 `streamOnly` provider 时，proxy 内部走 `streamText()`，收集结果后用 `renderResult()` 渲染非流式响应
- 当客户端发 `stream: true` 时，行为不受影响（正常 SSE 响应）
- 非 `streamOnly` provider 的现有行为不受影响

## 配置结构

在 provider 配置中新增 `options` 子对象：

```jsonc
{
  "providers": {
    "my-stream-only-provider": {
      "type": "openai-compatible",
      "baseURL": "https://...",
      "apiKey": "...",
      "options": {
        "streamOnly": true, // 该 provider 仅支持流式 API
      },
    },
  },
}
```

**Zod schema 变更：**

- 新增 `providerOptionsSchema = z.object({ streamOnly: z.boolean().optional() })`
- 三种 provider schema 均添加 `options: providerOptionsSchema.optional()`
- `ProviderConfig` 类型自动包含 `options?: { streamOnly?: boolean }`

**注意：** `options` 是 proxy 内部行为配置，不会透传给 AI SDK。与 `providerOptions`（未知字段透传）无关。

## 请求处理流程

核心变更在 `handleProtocolRequest` 中：

```
isStream(request)?
  → true:                       gateway.stream()        → SSE 响应（不变）
  → false + route.streamOnly:   gateway.stream()        → collectStreamResult() → renderResult() → JSON 响应
  → false + !route.streamOnly:  gateway.generate()      → renderResult() → JSON 响应（不变）
```

### streamOnly 分支的流收集

调用 `gateway.stream()` 获取 `fullStream`，遍历流收集：

| 字段           | 收集逻辑                                                                             |
| -------------- | ------------------------------------------------------------------------------------ |
| `text`         | 拼接所有 `text-delta` chunk 的 `textDelta`                                           |
| `finishReason` | 取 `finish` chunk 的 `finishReason`                                                  |
| `usage`        | 取 `finish` chunk 的 `usage`（inputTokens / outputTokens / totalTokens）             |
| `toolCalls`    | 取 `tool-call` chunk（toolCallId / toolName / args），`tool-result` chunk 补全 input |
| `response`     | 取流的 `response` metadata（id、timestamp）                                          |

收集完成后，用 `strategy.renderResult()` 渲染为非流式响应，与 `gateway.generate()` 路径完全一致。

超时复用 `withRequestTimeout()`，错误走 `handleUpstreamError()`。

## RoutingTable 扩展

`routingTable.resolve()` 返回的 route 对象新增 `streamOnly?: boolean` 字段：

```typescript
interface Route {
  providerName: string
  upstreamModel: string
  headers: Record<string, string>
  resolvedPlugins: ResolvedPlugin[]
  streamOnly?: boolean // 新增：从 provider.options.streamOnly 读取
}
```

`RoutingTable.fromSettings()` 构建 routing 时从 `settings.providers[providerName].options?.streamOnly` 读取并填入。

## 流收集工具函数

新增 `collectStreamResult()` 工具函数：

```typescript
interface CollectedResult {
  text: string
  finishReason?: FinishReason
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  response?: { id?: string; timestamp?: Date }
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>
}

async function collectStreamResult(stream: AsyncIterable<unknown>): Promise<CollectedResult>
```

**放置位置：** `apps/core/src/providers/shared/` 目录下。

遍历 `fullStream`（AI SDK `streamText().fullStream`），按 chunk type 收集数据。

## 测试策略

1. **配置解析测试：** 验证 `options.streamOnly` 在三种 provider 类型中正确解析和默认值
2. **流收集测试：** `collectStreamResult()` 对各种 chunk 组合（纯文本、含 tool calls、含 usage、空响应）的收集行为
3. **集成测试（通过 `app.fetch()`）：**
   - `streamOnly: true` + 客户端 `stream: false` → 返回非流式 JSON，内部走了流式
   - `streamOnly: true` + 客户端 `stream: true` → 正常 SSE（不受影响）
   - 无 `streamOnly` + 客户端 `stream: false` → 正常 `generateText()`（不受影响）

## 不在范围内

- 反向场景（nonStreamOnly：上游只支持非流式时把结果拆成 SSE）— YAGNI
- model 级别的 streamOnly 配置 — 当前只需 provider 级别
- AI SDK LanguageModel 层封装 — 耦合度太高
