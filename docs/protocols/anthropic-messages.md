# Anthropic Messages 协议

Anthropic Claude 的核心对话接口。所有生成均经 `POST /v1/messages`,工具与输出约束是该端点的特性,非独立 API。

- 端点:`POST /v1/messages`
- 官方文档:[Messages API](https://platform.claude.com/docs/en/api/messages) · [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) · [Tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) · [Models](https://platform.claude.com/docs/en/about-claude/models/overview)
- 项目实现:`src/providers/anthropic/`

## 请求参数

### 核心(必填)

| 参数         | 类型   | 说明                                                    |
| ------------ | ------ | ------------------------------------------------------- |
| `model`      | string | 模型 ID,如 `claude-opus-4-8`                            |
| `messages`   | array  | 对话消息,`role` 为 `user` / `assistant`,首条须为 `user` |
| `max_tokens` | number | 输出 token 上限                                         |

### 指令与上下文

| 参数             | 类型            | 说明                                                  |
| ---------------- | --------------- | ----------------------------------------------------- |
| `system`         | string \| array | 顶层系统提示(不在 `messages` 内),可带 `cache_control` |
| `metadata`       | object          | `user_id`                                             |
| `stop_sequences` | array           | 自定义停止序列                                        |

### 采样(Claude 4.7+ 移除,传则 400)

| 参数          | 类型   | 说明   |
| ------------- | ------ | ------ |
| `temperature` | number | 0–1    |
| `top_p`       | number | 核采样 |
| `top_k`       | number | top-k  |

### 推理与输出

| 参数            | 类型    | 说明                                                                                                                                                        |
| --------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinking`      | object  | `{type:"adaptive", display?}`(4.6+ 推荐)/ `{type:"enabled", budget_tokens}`(旧)/ `{type:"disabled"}`;`display:"summarized" \| "omitted"`(4.7+ 默认 omitted) |
| `output_config` | object  | `{effort, format, task_budget}`;`format` 即 Structured Outputs,`effort` 控制推理深度                                                                        |
| `stream`        | boolean | 流式 SSE                                                                                                                                                    |

### 工具

| 参数          | 类型   | 说明                                                                                                        |
| ------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `tools`       | array  | 自定义工具 + 内置工具(web_search / code_execution / bash / text_editor / mcp_toolset 等)                    |
| `tool_choice` | object | `{type:"auto"}` / `{type:"any"}` / `{type:"tool", name}` / `{type:"none"}`,可带 `disable_parallel_tool_use` |

### 缓存与上下文管理

| 参数                 | 类型   | 说明                                                                                             |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `cache_control`      | object | 顶层(自动)或块级,`{type:"ephemeral", ttl?}`,最多 4 断点                                          |
| `context_management` | object | `{edits:[{type:"clear_tool_uses_20250919" \| "clear_thinking_20251015" \| "compact_20260112"}]}` |

### 高级 / beta

| 参数            | 类型   | 说明                                                                 |
| --------------- | ------ | -------------------------------------------------------------------- |
| `service_tier`  | string | `auto` / `default` / `flex` / `priority`                             |
| `inference_geo` | string | 数据驻留,如 `us`                                                     |
| `speed`         | string | `fast`(fast mode,beta `fast-mode-2026-02-01`,Opus 4.8/4.7/4.6)       |
| `betas`         | array  | beta header 列表                                                     |
| `mcp_servers`   | array  | MCP connector(beta `mcp-client-2025-11-20`),须配 `mcp_toolset`       |
| `container`     | object | Agent Skills(beta `code-execution-2025-08-25` + `skills-2025-10-02`) |

## messages 与 content blocks

`messages[].content` 为字符串或 block 数组。请求侧 block 类型:

- `text`:`{type:"text", text, cache_control?}`
- `image`:`{type:"image", source:{type:"url"|"base64", ...}}`
- `document`:`{type:"document", source:{type:"base64"|"file"|"url", ...}, citations?}`
- `tool_use`:`{type:"tool_use", id, name, input}`(assistant 回放)
- `tool_result`:`{type:"tool_result", tool_use_id, content, is_error?}`(user 侧回传)
- `thinking`:`{type:"thinking", thinking, signature}`(推理块回放,须原样传回)

## 响应(非流式)

`type: "message"`。顶层:`id` / `type` / `role:"assistant"` / `content[]` / `model` / `stop_reason` / `stop_sequence` / `usage`。

`content[]` block 类型:

- `text`:`{type:"text", text, citations?}`
- `tool_use`:`{type:"tool_use", id, name, input}`
- `thinking`:`{type:"thinking", thinking, signature}`
- 内置工具结果:`server_tool_use` / `server_tool_result` / `web_search_tool_result` / `bash_code_execution_tool_result` 等

`usage`:`{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`,可选 `iterations`(fallback)。

## 流式(SSE 事件)

| 事件                  | 说明                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `message_start`       | 含 message 元数据(id/model/usage 等),content 为空                                             |
| `content_block_start` | 新 block 开始,带 `index` 与 `content_block`                                                   |
| `content_block_delta` | 增量,`delta.type` 为 `text_delta` / `input_json_delta` / `thinking_delta` / `signature_delta` |
| `content_block_stop`  | block 结束,带 `index`                                                                         |
| `message_delta`       | 消息级更新,含 `stop_reason` / `stop_sequence` / `usage`                                       |
| `message_stop`        | 消息结束                                                                                      |
| `ping`                | 心跳                                                                                          |
| `error`               | 流中错误,`{type:"error", error:{type, message}}`                                              |

## stop_reason

| 值                              | 含义                        |
| ------------------------------- | --------------------------- |
| `end_turn`                      | 自然结束                    |
| `max_tokens`                    | 达到 `max_tokens`           |
| `stop_sequence`                 | 命中停止序列                |
| `tool_use`                      | 请求调用工具                |
| `pause_turn`                    | 服务端工具循环暂停,重发可续 |
| `refusal`                       | 安全拒绝,查 `stop_details`  |
| `model_context_window_exceeded` | 上下文窗口耗尽(4.5+)        |

## tool use

- 工具定义:`{name, description, input_schema, strict?, cache_control?}`;`strict:true` 保证 input 严格校验
- `tool_choice`:`auto`(默认)/ `any` / `{type:"tool", name}` / `none`
- 并行工具调用默认开启,多条 `tool_use` → 一条 user 消息回传所有 `tool_result`
- `tool_result`:`{type:"tool_result", tool_use_id, content, is_error?}`
- 内置工具为 server-side,结果以 `server_tool_result` 等 block 返回,`pause_turn` 表示循环暂停

## error

HTTP 状态与 `error.type`:

| HTTP | type                    | 可重试 |
| ---- | ----------------------- | ------ |
| 400  | `invalid_request_error` | 否     |
| 401  | `authentication_error`  | 否     |
| 403  | `permission_error`      | 否     |
| 404  | `not_found_error`       | 否     |
| 413  | `request_too_large`     | 否     |
| 429  | `rate_limit_error`      | 是     |
| 500  | `api_error`             | 是     |
| 529  | `overloaded_error`      | 是     |

## 对照项目实现

| 官方概念           | 项目类型 / 函数                                        | 文件                                  |
| ------------------ | ------------------------------------------------------ | ------------------------------------- |
| 请求消息           | `AnthropicMessage`                                     | `src/providers/anthropic/types.ts`    |
| 请求 content block | `AnthropicContentBlock`(text / tool_use / tool_result) | 同上                                  |
| 工具定义           | `AnthropicTool`                                        | 同上                                  |
| tool_choice        | `AnthropicToolChoice`                                  | 同上                                  |
| thinking           | `AnthropicThinking`                                    | 同上                                  |
| stop_reason        | `AnthropicStopReason`                                  | 同上                                  |
| 非流式响应         | `AnthropicMessageResponse`                             | 同上                                  |
| 错误               | `AnthropicErrorResponse` / `AnthropicErrorType`        | 同上                                  |
| 流式事件           | `AnthropicSSEData`(7 类)                               | 同上                                  |
| 协议校验           | `messageSchema` 等                                     | `src/providers/anthropic/protocol.ts` |
| 渲染               | renderer(非流式 + SSE)                                 | `src/providers/anthropic/renderer.ts` |

**项目覆盖子集(v0)**:请求侧 content block 覆盖 `text` / `tool_use` / `tool_result`,未覆盖 `image` / `thinking` / `document`;响应侧覆盖 `text` / `tool_use`,未覆盖 `thinking` / 内置工具结果 block;流式覆盖 `message_start` / `content_block_start` / `content_block_delta`(text_delta / input_json_delta)/ `content_block_stop` / `message_delta` / `message_stop` / `error`,未覆盖 `ping` / `thinking_delta` / `signature_delta`;`stop_reason` 覆盖 `end_turn` / `max_tokens` / `stop_sequence` / `tool_use` / `pause_turn` / `refusal`,未覆盖 `model_context_window_exceeded`;`thinking` 类型已定义(enabled+budget_tokens / adaptive / disabled)但请求侧 thinking 块回放未实现。

## 来源

- claude-api 官方参考(cache 2026-06-04)
- 项目 `src/providers/anthropic/` 实现
- 验证日期 2026-07-10
- 官方文档会随版本变动,复用前建议抓取 `platform.claude.com/docs/en/api/messages` 验证
