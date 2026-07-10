# OpenAI Responses 协议

OpenAI 推荐的新接口，agentic 原语。支持内置工具、多轮状态、加密推理。新项目应优先使用，而非 Chat Completions。

- 端点：`POST /v1/responses`
- 官方文档：[overview](https://developers.openai.com/api/reference/responses/overview/) · [create](https://developers.openai.com/api/reference/resources/responses/methods/create/) · [streaming](https://developers.openai.com/api/reference/resources/responses/streaming-events/)
- 项目实现：`src/providers/openai-responses/`

## 请求参数

25 个顶层参数。

### 核心

| 参数           | 类型            | 必填 | 说明                                           |
| -------------- | --------------- | ---- | ---------------------------------------------- |
| `input`        | string \| array | 否   | 文本输入，或 input items 数组                  |
| `model`        | string          | 否   | 模型 ID（ResponsesModel）                      |
| `instructions` | string          | 否   | 顶层系统指令                                   |
| `store`        | boolean         | 否   | 默认 `true`，存储以支持 `previous_response_id` |
| `stream`       | boolean         | 否   | 流式                                           |
| `background`   | boolean         | 否   | 后台运行                                       |

### 多轮与状态

| 参数                   | 类型                       | 说明                                         |
| ---------------------- | -------------------------- | -------------------------------------------- |
| `previous_response_id` | string                     | 链接上一响应（需 `store:true`）              |
| `conversation`         | string \| `{id}`           | 所属会话，items 自动 prepend                 |
| `context_management`   | array                      | `[{ type:"compaction", compact_threshold }]` |
| `include`              | array                      | 额外输出，如 `reasoning.encrypted_content`   |
| `prompt`               | `{id, variables, version}` | 引用 prompt 模板                             |

### 采样与长度

| 参数                | 类型                                    | 说明                                                             |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| `temperature`       | number                                  | 0–2                                                              |
| `top_p`             | number                                  | 核采样                                                           |
| `max_output_tokens` | number                                  | 输出 token 上限                                                  |
| `truncation`        | string                                  | `auto` / `disabled`                                              |
| `text`              | `{ format, verbosity }`                 | `format` 即 Structured Outputs（替代 Chat 的 `response_format`） |
| `reasoning`         | `{ effort, generate_summary, summary }` | 推理控制（替代 Chat 的 `reasoning_effort`）                      |

### 工具

| 参数                  | 类型             | 说明                                                                                       |
| --------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| `tools`               | array            | function / web_search / file_search / computer / code_interpreter / mcp / image_generation |
| `tool_choice`         | string \| object | `auto` / `none` / `required` / 指定                                                        |
| `parallel_tool_calls` | boolean          | 并行工具调用                                                                               |

### 其他

| 参数                | 类型   | 说明                                               |
| ------------------- | ------ | -------------------------------------------------- |
| `metadata`          | map    | 16 键值对                                          |
| `service_tier`      | string | `auto` / `default` / `flex` / `scale` / `priority` |
| `prompt_cache_key`  | string | 缓存键                                             |
| `safety_identifier` | string | 用户标识                                           |
| `user`              | string | 用户标识                                           |

## input items 类型

`input` 为数组时，元素是类型化 item：

- `message`：`role` 为 `user` / `assistant` / `system` / `developer`，`content` 为 `input_text` / `input_image` / `input_file`
- `function_call`：工具调用（输出回放）
- `function_call_output`：工具结果，带 `call_id` 关联
- `custom_tool_call` / `custom_tool_call_output`
- `reasoning`：推理 item（可加密回放）
- `web_search_call` / `file_search_call` / `computer_call` / `code_interpreter_call` / `mcp_call`：内置工具调用（输出回放）

## 响应（非流式）

`object: "response"`。顶层字段：`id` / `created_at` / `model` / `status` / `output[]` / `output_text` / `usage?` / `error?` / `instructions` / `temperature` / `top_p` / `tool_choice` / `tools` / `parallel_tool_calls` / `truncation`。

`status`：`completed` / `incomplete` / `failed`。

`output[]` items：

- `message`：`{ id, type:"message", status, role:"assistant", content:[{ type:"output_text", text, annotations }] }`
- `function_call`：`{ id, type:"function_call", status, call_id, name, arguments }`
- `custom_tool_call`：`{ id, type:"custom_tool_call", status, call_id, name, input }`
- `web_search_call`：`{ id, type:"web_search_call", status, action }`
- `tool_search_call`：`{ id, type:"tool_search_call", call_id, status, execution:"client", arguments }`
- `reasoning`：`{ id, type:"reasoning", content, summary }`
- `file_search_call` / `computer_call` / `code_interpreter_call` / `mcp_call` / `image_generation_call`

`usage`：`{ input_tokens, output_tokens, total_tokens, input_tokens_details:{ cached_tokens }, output_tokens_details:{ reasoning_tokens } }`。

`output_text` 为便捷字段，拼接所有 `output_text` 内容。

## 流式（47 个类型化 SSE 事件）

每个事件带 `type` 与 `sequence_number`。官方 [streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events/) 列出 47 个 `response.*` 事件。

### 生命周期

- `response.created` / `response.in_progress` / `response.queued` / `response.completed` / `response.incomplete` / `response.failed`

### output item / content part

- `response.output_item.added` / `response.output_item.done`
- `response.content_part.added` / `response.content_part.done`

### 文本

- `response.output_text.delta` / `response.output_text.done`
- `response.output_text.annotation.added`
- `response.refusal.delta` / `response.refusal.done`

### function / custom tool

- `response.function_call_arguments.delta` / `response.function_call_arguments.done`

### reasoning

- `response.reasoning_summary_part.added` / `response.reasoning_summary_part.done`
- `response.reasoning_summary_text.delta` / `response.reasoning_summary_text.done`
- `response.reasoning_text.delta` / `response.reasoning_text.done`

### 内置工具

- web_search：`response.web_search_call.in_progress` / `.searching` / `.completed`
- file_search：`response.file_search_call.in_progress` / `.searching` / `.completed`
- code_interpreter：`response.code_interpreter_call.in_progress` / `.interpreting` / `.completed` / `response.code_interpreter_call_code.delta` / `.done`
- image_generation：`response.image_generation_call.in_progress` / `.generating` / `.partial_image` / `.completed`
- mcp：`response.mcp_call.in_progress` / `.completed` / `.failed` / `response.mcp_call_arguments.delta` / `.done`

### audio

- `response.audio.delta` / `response.audio.done` / `response.audio.transcript.delta` / `response.audio.transcript.done`

## 对照项目实现

| 官方概念    | 项目类型 / 函数                                                                                         | 文件                                         |
| ----------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 非流式响应  | `OpenAIResponse`                                                                                        | `src/providers/openai-responses/types.ts`    |
| output item | `ResponseOutputItem`（message / function_call / custom_tool_call / web_search_call / tool_search_call） | 同上                                         |
| usage       | `ResponseUsage`                                                                                         | 同上                                         |
| 流式事件    | `OpenAIResponseStreamEvent`                                                                             | 同上                                         |
| 非流式渲染  | `renderOpenAIResponse`                                                                                  | `src/providers/openai-responses/renderer.ts` |

**流式事件覆盖**：项目 `OpenAIResponseStreamEvent` 实现 16 个事件——`response.created` / `in_progress` / `output_item.added` / `content_part.added` / `output_text.delta` / `output_text.done` / `content_part.done` / `output_item.done` / `function_call_arguments.delta` / `function_call_arguments.done` / `reasoning_summary_text.delta` / `reasoning_summary_text.done` / `completed` / `failed`。

项目额外处理两个官方 streaming-events 页未列录的事件：

- `response.error`——迁移指南以 `error` 指代，官方页面 47 个事件中未出现，项目作为错误事件类型实现
- `response.custom_tool_call_input.delta`——custom tool 输入增量，官方页面未列录

项目未覆盖内置工具事件（web_search / file_search / code_interpreter / mcp / image_generation）、audio、refusal、annotation、`reasoning_text.*`、`reasoning_summary_part.*`、`response.queued` / `incomplete`。

**status 映射**：`mapResponseStatus` 将 finishReason 映射为 `completed` / `incomplete`。hosted `web_search_call`（`providerExecuted`，上游 inline 执行）不触发 `incomplete`——仅 function / custom tool call 触发，避免暂停 agent loop。

## 来源

验证日期 2026-07-10。
