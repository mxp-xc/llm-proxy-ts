# OpenAI Responses API 支持设计

**日期**: 2026-06-12
**状态**: Draft
**范围**: v0 — 仅格式兼容（不含内置工具、previous_response_id、状态存储等独有能力）

## 1. 目标

添加 `POST /v1/responses` 端点，让使用 OpenAI Responses API 格式的客户端（如 OpenAI 官方 SDK）可以无缝切换到本代理。代理将 Responses API 请求转换为 AI SDK 输入，调用已配置的上游 provider，再将结果渲染为 Responses API 响应格式。

**不在 v0 范围内**：

- 内置工具（web_search、file_search、code_interpreter 等）
- `previous_response_id` / `conversation` 多轮状态
- `store` / 后台执行
- `reasoning` 配置透传
- `text.format` 结构化输出
- `prompt` 模板引用

## 2. 架构

跟随现有 Anthropic Messages 的模式：新增独立协议层，与 `openai-chat`、`anthropic` 并列。

### 数据流

```
客户端 → POST /v1/responses
       → validateOpenAIResponsesRequest (Zod)
       → mapResponsesRequestToAISDKInput
       → routingTable.resolve(model)
       → registry.languageModel(provider, upstreamModel, headers)
       → AI SDK generateText / streamText
       → renderOpenAIResponse / renderOpenAIResponseSSE
       → 客户端
```

### 文件结构

```
新增/修改文件：
apps/core/src/providers/
  openai/
    renderer.ts              ← 新增 renderOpenAIResponse / renderOpenAIResponseSSE
    protocol-types.ts        ← 新增 Responses 相关共享类型
  index.ts                   ← 重新导出新符号

apps/server/src/
  protocols/
    openai-responses.ts      ← 新增：Zod schema + validate + mapToAISDKInput
  app.ts                     ← 新增 POST /v1/responses 路由处理器

apps/core/test/
  openai-responses.test.ts   ← 新增：映射 + 渲染单元测试
```

## 3. 请求格式

### 端点

`POST /v1/responses`

### Zod Schema（v0 支持的字段）

```typescript
const functionToolSchema = z.object({
  type: z.literal('function'),
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  strict: z.boolean().optional(),
})

const inputMessageSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
})

const functionCallOutputSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1),
  output: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
})

const inputItemSchema = z.union([inputMessageSchema, functionCallOutputSchema])

const openAIResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(inputItemSchema)]),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_output_tokens: z.number().int().positive().optional(),
    tools: z.array(functionToolSchema).optional(),
    tool_choice: z
      .union([
        z.enum(['auto', 'none', 'required']),
        z.object({ type: z.literal('function'), name: z.string().min(1) }),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
  })
  .passthrough()
```

### 字段映射

| Responses API 字段                                           | 映射到 AI SDK                                                               | 说明                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- | --------------------- |
| `model`                                                      | 路由选择                                                                    | 必须字段              |
| `input: string`                                              | `messages: [{ role: "user", content }]`                                     | 简写形式              |
| `input: [{ role: "user", content }]`                         | `messages: [{ role, content }]`                                             | message item          |
| `input: [{ type: "function_call_output", call_id, output }]` | `messages: [{ role: "tool", toolCallId: call_id, content: [tool-result] }]` | 工具结果              |
| `instructions`                                               | `messages` 前置 `{ role: "system", content }`                               | 系统/开发者指令       |
| `temperature`                                                | `temperature`                                                               | 直接映射              |
| `top_p`                                                      | `topP`                                                                      | 驼峰转换              |
| `max_output_tokens`                                          | `maxOutputTokens`                                                           | 直接映射              |
| `tools` (FunctionTool)                                       | `tools` (ToolSet)                                                           | 扁平→嵌套转换（见下） |
| `tool_choice: 'auto'/'none'/'required'`                      | `toolChoice`                                                                | 直接映射              |
| `tool_choice: { type: 'function', name }`                    | `toolChoice: { type: 'tool', toolName: name }`                              | 类型名转换            |
| `parallel_tool_calls`                                        | passthrough via `providerOptions`                                           | 透传                  |

### Tool 定义映射（关键差异）

Responses API 的 FunctionTool 是**扁平结构**（内部标记）：

```json
{ "type": "function", "name": "get_weather", "parameters": {...}, "description": "..." }
```

Chat Completions 是**二层嵌套**（外部标记）：

```json
{ "type": "function", "function": { "name": "get_weather", "parameters": {...}, "description": "..." } }
```

映射时从扁平结构提取 `name`/`parameters`/`description` → AI SDK `ToolSet`：

```typescript
// Responses FunctionTool → AI SDK ToolSet
function mapResponsesFunctionTool(tool): ToolSet[string] {
  const definition: ToolSet[string] = {
    inputSchema: jsonSchema(tool.parameters ?? { type: 'object', properties: {} }),
  }
  if (tool.description !== undefined) definition.description = tool.description
  return definition
}
```

### `developer` 角色处理

Responses API 新增 `developer` 角色（优先级高于 `system`）。v0 将 `developer` 映射为 `system` 消息，与现有行为一致。

## 4. 响应格式

### 非流式

```typescript
interface OpenAIResponse {
  id: string                           // "resp_" + UUID
  object: 'response'
  created_at: number                   // Unix 秒
  model: string
  status: 'completed' | 'incomplete'
  output: ResponseOutputItem[]
  output_text: string                  // 便捷字段：纯文本内容
  usage?: ResponseUsage
  // 以下字段回传默认值
  instructions: string | null
  temperature: number | null
  top_p: number | null
  tool_choice: string | null
  tools: FunctionTool[]
  parallel_tool_calls: boolean
  truncation: 'disabled'
}

interface ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseFunctionToolCall

interface ResponseOutputMessage {
  id: string                           // "msg_" + UUID
  type: 'message'
  status: 'completed' | 'incomplete'
  role: 'assistant'
  content: Array<ResponseOutputText | ResponseOutputRefusal>
}

interface ResponseOutputText {
  type: 'output_text'
  text: string
  annotations: unknown[]               // v0 始终为空数组
}

interface ResponseOutputRefusal {
  type: 'refusal'
  refusal: string
}

interface ResponseFunctionToolCall {
  id: string                           // "fc_" + UUID
  type: 'function_call'
  status: 'completed' | 'incomplete'
  call_id: string                      // 工具调用唯一 ID
  name: string
  arguments: string                    // JSON 字符串
}

interface ResponseUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details: { cached_tokens: number }
  output_tokens_details: { reasoning_tokens: number }
}
```

### Status 映射

| AI SDK finishReason | Response status |
| ------------------- | --------------- |
| `'stop'`            | `'completed'`   |
| `'length'`          | `'incomplete'`  |
| `'tool-calls'`      | `'incomplete'`  |
| `'content-filter'`  | `'incomplete'`  |
| 有 toolCalls        | `'incomplete'`  |
| 其他                | `'completed'`   |

### 渲染逻辑

```
renderOpenAIResponse(input: RenderResultInput) → OpenAIResponse:
1. 有 toolCalls → output 包含 ResponseFunctionToolCall items
2. 有 text → output 包含 ResponseOutputMessage item（含 output_text content part）
3. output_text 便捷字段 = 拼接所有文本内容
4. usage → Responses 格式（含 input_tokens_details/output_tokens_details）
5. id → "resp_" + UUID
```

## 5. 流式 SSE 格式

### 事件类型

每个 SSE 事件格式：

```
event: <event_type>
data: <json>
```

### 核心事件序列

```
1. response.created
   → { type: "response.created", response: { id, object, status: "in_progress", ... } }

2. response.in_progress
   → { type: "response.in_progress", response: { ... } }

3. response.output_item.added
   → { type: "response.output_item.added", output_index: 0,
       item: { id: "msg_xxx", type: "message", status: "in_progress", role: "assistant", content: [] } }

4. response.content_part.added
   → { type: "response.content_part.added", item_id: "msg_xxx", output_index: 0, content_index: 0,
       part: { type: "output_text", text: "", annotations: [] } }

5. response.output_text.delta  (重复多次)
   → { type: "response.output_text.delta", item_id: "msg_xxx", output_index: 0, content_index: 0,
       delta: "Hello" }

6. response.output_text.done
   → { type: "response.output_text.done", item_id: "msg_xxx", output_index: 0, content_index: 0,
       text: "Hello world" }

7. response.content_part.done
   → { type: "response.content_part.done", item_id: "msg_xxx", output_index: 0, content_index: 0,
       part: { type: "output_text", text: "Hello world", annotations: [] } }

8. response.output_item.done
   → { type: "response.output_item.done", output_index: 0,
       item: { id: "msg_xxx", type: "message", status: "completed", role: "assistant",
               content: [{ type: "output_text", text: "Hello world", annotations: [] }] } }

9. response.completed
   → { type: "response.completed", response: { 完整 Response 对象 } }
```

### 函数调用事件序列

```
response.output_item.added       → { type: "function_call", call_id, name, arguments: "" }
response.function_call_arguments.delta  → { delta: "{\"loc" }
response.function_call_arguments.delta  → { delta: "ation" }
response.function_call_arguments.done   → { arguments: "{\"location\":\"Paris\"}" }
response.output_item.done        → 完整 function_call item
```

### 渲染逻辑

`renderOpenAIResponseSSE` 接收 AI SDK `StreamTextResult` 的异步迭代器，根据 `StreamTextResult` 的事件类型映射为 Responses API 的 SSE 事件：

| AI SDK 事件       | Responses SSE 事件                                                     |
| ----------------- | ---------------------------------------------------------------------- |
| `text-delta`      | `response.output_text.delta`                                           |
| `tool-call`       | `response.output_item.added` + `response.function_call_arguments.done` |
| `tool-call-delta` | `response.function_call_arguments.delta`                               |
| `finish`          | `response.output_item.done` + `response.completed`                     |

## 6. 路由处理器

在 `app.ts` 中新增 `POST /v1/responses` 路由，模式与 `/v1/chat/completions` 和 `/v1/messages` 一致：

```typescript
app.post('/v1/responses', async (c) => {
  // 1. 验证请求
  const request = validateOpenAIResponsesRequest(await c.req.json())
  // 2. 解析路由
  const route = routingTable.resolve(request.model)
  // 3. 映射到 AI SDK 输入
  const callInput = mapResponsesRequestToAISDKInput(request, route.providerName)
  // 4. 获取模型
  const model = resolvedRegistry.languageModel(
    route.providerName,
    route.upstreamModel,
    route.headers,
  )
  // 5. 调用（stream 或 generate）
  // 6. 渲染响应
  // 7. 错误处理（同 Chat Completions 模式）
})
```

错误响应格式遵循 OpenAI 风格：

- 验证失败 → `{ error: { type: "invalid_request_error", code: "invalid_request", message } }`，400
- 路由失败 → `{ error: { type: "invalid_request_error", code: "unknown_model", message } }`，404
- OAuth 需要登录 → `{ error: { type: "auth_required", code: "oauth_login_needed", message, loginUrl } }`，503
- 上游超时 → `{ error: { type: "server_error", code: "upstream_timeout", message } }`，504
- 上游其他错误 → `{ error: { type: "server_error", code: "upstream_error", message } }`，500

## 7. 测试策略

### 请求映射测试

- `input: string` → user message
- `input: [EasyInputMessage]` → messages 数组
- `input: [function_call_output]` → tool message with call_id
- `instructions` → 前置 system message
- `developer` 角色 → system message
- `tools` 扁平 → ToolSet 转换
- `tool_choice` 字符串和对象映射
- 未知 input item 类型 → 忽略
- passthrough 字段 → providerOptions

### 响应渲染测试

- 纯文本输出 → message item with output_text
- 工具调用输出 → function_call item
- 混合输出（文本 + 工具调用）
- status 映射（stop→completed, length→incomplete, tool-calls→incomplete）
- usage 映射（含 input_tokens_details/output_tokens_details）
- output_text 便捷字段

### SSE 渲染测试

- 纯文本流式：created → in_progress → output_item.added → content_part.added → text.delta\* → text.done → content_part.done → output_item.done → completed
- 函数调用流式：output_item.added → arguments.delta\* → arguments.done → output_item.done
- 事件格式正确性（event 行 + data 行）
- sequence_number 递增

### 边界测试

- 空 text + 无 toolCalls → 空输出
- 非法请求 → 400
- 未知 model → 404

## 8. 与现有代码的复用

- **`RenderResultInput`**（`protocol-types.ts`）：共享的渲染器输入接口，无需修改
- **`FinishReason`**（`protocol-types.ts`）：共享的完成原因类型
- **`toErrorMessage`**（`protocol-types.ts`）：错误消息转换，直接复用
- **`mapFunctionTool`**（`openai-chat.ts`）：类似的 ToolSet 映射逻辑，可提取为共享函数或独立实现
- **路由逻辑**：与 Chat Completions 完全一致（routingTable.resolve → registry.languageModel）
- **错误处理模式**：与 Chat Completions 一致（OAuthError / RequestTimeoutError / 上游错误）
- **SSE 流基础设施**：`readableStreamFromAsyncIterable`、`withRequestTimeout`、`inspectFirstStreamChunk` 直接复用
