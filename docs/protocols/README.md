# 协议标准参考

本目录收录 `llm-proxy-ts` 支持的各 LLM 协议的官方标准规范，作为协议转换代理实现的契约依据。

文档为**结构化提炼**（非官方原文搬运）：记录端点、请求参数、响应 schema、流式格式与协议间差异对照，并标注官方文档来源与验证日期。深层 schema 细节请查阅对应官方链接。

## 协议清单

| 协议                    | 端点                        | 官方文档                                                                                                                                                                                                                                                                 | 项目实现                           | 说明                              |
| ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------- |
| OpenAI Chat Completions | `POST /v1/chat/completions` | [overview](https://developers.openai.com/api/reference/chat-completions/overview/) · [create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/)                                                                       | `src/providers/openai-compatible/` | 传统对话补全接口，兼容性最广      |
| OpenAI Responses        | `POST /v1/responses`        | [overview](https://developers.openai.com/api/reference/responses/overview/) · [create](https://developers.openai.com/api/reference/resources/responses/methods/create/) · [streaming](https://developers.openai.com/api/reference/resources/responses/streaming-events/) | `src/providers/openai-responses/`  | OpenAI 推荐的新接口，agentic 原语 |
| Anthropic Messages      | `POST /v1/messages`         | [Messages](https://platform.claude.com/docs/en/api/messages) · [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)                                                                                                                              | `src/providers/anthropic/`         | Anthropic Claude 对话接口         |

> Chat Completions 的 create 深链未纳入官方 sitemap，访问不稳定（部分网络返回 404）；稳定入口是其 overview 页，左侧导航进入 "Create a completion"。

## Chat Completions 与 Responses 差异对照

OpenAI 官方推荐新项目使用 Responses，Chat Completions 仍受支持。详见[迁移指南](https://developers.openai.com/api/docs/guides/migrate-to-responses)。

| 维度                   | Chat Completions                               | Responses                                                                                     |
| ---------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 输入                   | `messages[]`                                   | `input`（string 或 items 数组）                                                               |
| 系统指令               | `system` / `developer` message                 | 顶层 `instructions`，或等价 message item                                                      |
| 输出                   | `choices[].message`                            | `output[]`（类型化 items）                                                                    |
| 多候选                 | `n` 参数                                       | 不支持，需多次请求                                                                            |
| 结构化输出             | `response_format`                              | `text.format`                                                                                 |
| 推理控制               | `reasoning_effort`（顶层）                     | `reasoning.effort`（对象）                                                                    |
| 工具定义               | 外 tagged：`{type:"function", function:{...}}` | 内 tagged：`{type:"function", name, ...}`                                                     |
| 工具调用↔结果关联      | `tool_call_id`                                 | `call_id`                                                                                     |
| 工具调用 strict        | 默认非 strict                                  | 省略 `strict` 时尝试 strict，失败回退                                                         |
| 流式                   | `chat.completion.chunk` + `delta`              | 类型化 SSE 事件（官方 47 个）                                                                 |
| 多轮状态               | 手动累积 `messages`                            | `previous_response_id` / `conversation` / 手动回放 items                                      |
| 存储                   | `store`（新账户默认开）                        | `store`（默认开）                                                                             |
| 加密推理（无状态/ZDR） | —                                              | `store:false` + `include:["reasoning.encrypted_content"]`                                     |
| 内置工具               | 不原生支持                                     | `web_search` / `file_search` / `computer_use` / `code_interpreter` / MCP / `image_generation` |
| 内置工具执行           | 需自建                                         | 上游 inline 执行，`providerExecuted` 语义                                                     |

## 来源与验证

- 抓取与验证日期：2026-07-10
- 文档站：`developers.openai.com`（OpenAI 文档已从 `platform.openai.com` 迁移至此）
- 抓取方式：官方文档站为重度 SPA，需无头浏览器渲染；`curl` 仅拿到空壳
- 官方文档会随版本变动，复用前建议 `curl -s -o /dev/null -w '%{http_code}' -L <url>` 验证可用性
