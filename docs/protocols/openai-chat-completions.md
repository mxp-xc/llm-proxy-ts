# OpenAI Chat Completions 协议

传统对话补全接口，兼容性最广。OpenAI 仍支持，但新项目推荐 Responses。

- 端点：`POST /v1/chat/completions`
- 官方文档：[overview](https://developers.openai.com/api/reference/chat-completions/overview/) · [create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/)
- 项目实现：`src/providers/openai-compatible/`

## 请求参数

### 核心

| 参数       | 类型    | 必填 | 说明                                                                                        |
| ---------- | ------- | ---- | ------------------------------------------------------------------------------------------- |
| `messages` | array   | 是   | 对话消息列表，role 可为 `developer` / `system` / `user` / `assistant` / `tool` / `function` |
| `model`    | string  | 是   | 模型 ID                                                                                     |
| `stream`   | boolean | 否   | 流式返回 SSE                                                                                |
| `store`    | boolean | 否   | 是否存储用于蒸馏 / eval                                                                     |

### 采样

| 参数                | 类型            | 说明                                    |
| ------------------- | --------------- | --------------------------------------- |
| `temperature`       | number          | 0–2                                     |
| `top_p`             | number          | 核采样                                  |
| `frequency_penalty` | number          | -2–2                                    |
| `presence_penalty`  | number          | -2–2                                    |
| `logit_bias`        | map[number]     | token 偏置（-100–100）                  |
| `logprobs`          | boolean         | 返回 logprob                            |
| `top_logprobs`      | number          | 每个 token 的 top logprob 数            |
| `seed`              | number          | deprecated，尽力确定性采样              |
| `stop`              | string \| array | 最多 4 个停止序列；reasoning 模型不支持 |

### 长度与输出

| 参数                    | 类型   | 说明                                                         |
| ----------------------- | ------ | ------------------------------------------------------------ |
| `max_completion_tokens` | number | 含可见 + 推理 token 的上限（推荐）                           |
| `max_tokens`            | number | deprecated，不兼容 o-series                                  |
| `n`                     | number | 1–128，候选数                                                |
| `modalities`            | array  | `text` / `audio`                                             |
| `response_format`       | object | `text` / `json_object` / `json_schema`（Structured Outputs） |
| `prediction`            | object | Predicted Outputs                                            |
| `audio`                 | object | 音频输出配置（format / voice）                               |

### 工具

| 参数                  | 类型             | 说明                                    |
| --------------------- | ---------------- | --------------------------------------- |
| `tools`               | array            | function / custom 工具定义              |
| `tool_choice`         | string \| object | `none` / `auto` / `required` / 指定工具 |
| `parallel_tool_calls` | boolean          | 并行函数调用                            |
| `functions`           | array            | deprecated，被 `tools` 取代             |
| `function_call`       | string \| object | deprecated，被 `tool_choice` 取代       |

### 推理与其他

| 参数                     | 类型   | 说明                                                                     |
| ------------------------ | ------ | ------------------------------------------------------------------------ |
| `reasoning_effort`       | string | `none` / `minimal` / `low` / `medium` / `high` / `xhigh`，reasoning 模型 |
| `metadata`               | map    | 最多 16 键值对                                                           |
| `service_tier`           | string | `auto` / `default` / `flex` / `scale` / `priority`                       |
| `prompt_cache_key`       | string | 缓存键，替代 `user`                                                      |
| `prompt_cache_retention` | string | `in-memory` / `24h`                                                      |
| `safety_identifier`      | string | 用户标识                                                                 |
| `user`                   | string | 用户标识（旧）                                                           |
| `stream_options`         | object | `include_usage` / `include_obfuscation`                                  |

## 响应（非流式）

`object: "chat.completion"`。`choices[]` 每项含：

- `message`：`{ role:"assistant", content, tool_calls?, refusal?, annotations? }`
- `tool_calls[]`：`{ id, type:"function", function:{ name, arguments } }`，`arguments` 为 JSON 字符串
- `finish_reason`：`stop` / `length` / `tool_calls` / `content_filter`
- `logprobs`

`usage`：`{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details{ cached_tokens, audio_tokens }, completion_tokens_details{ reasoning_tokens, audio_tokens, accepted_prediction_tokens, rejected_prediction_tokens } }`。

顶层另有 `id` / `created` / `model` / `system_fingerprint` / `service_tier`。

## 流式

`object: "chat.completion.chunk"`。`choices[].delta`：`{ role?, content?, tool_calls? }` + `finish_reason`。

- 文本增量：`delta.content`
- 工具调用增量：`delta.tool_calls[]` 用 `index` 关联同一调用，先发 `id` + `function.name`，再发 `function.arguments` 增量片段
- `stream_options.include_usage:true` 时，末尾发一个 `choices:[]` + `usage` 的 chunk，随后 `data: [DONE]`
- 错误：流中发 `{ error:{ type, code?, message } }` 后结束

## 对照项目实现

| 官方概念   | 项目类型 / 函数                 | 文件                                          |
| ---------- | ------------------------------- | --------------------------------------------- |
| 非流式响应 | `OpenAIChatCompletion`          | `src/providers/openai-compatible/types.ts`    |
| 流式 chunk | `OpenAIChatChunk`               | 同上                                          |
| 流式错误   | `OpenAIChatStreamError`         | 同上                                          |
| 非流式渲染 | `renderOpenAIChatCompletion`    | `src/providers/openai-compatible/renderer.ts` |
| 流式渲染   | `renderOpenAIChatCompletionSSE` | 同上                                          |

项目类型为最小子集（`content` / `tool_calls` / `usage` 核心字段），未覆盖 `refusal` / `annotations` / `logprobs` / `audio` 等。流式渲染将内部 `ProxyStreamPart`（`text-delta` / `tool-input-start` / `tool-input-delta` / `tool-call` / `finish`）映射为 chunk delta。

## 来源

验证日期 2026-07-10。create 深链服务端返回 200 但未进官方 sitemap，访问不稳定。
