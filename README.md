# llm-proxy-ts

本地优先的 LLM 协议转换代理。核心能力：将上游 provider（无论其原生协议）同时以多种下游协议格式暴露——同一个上游可以同时提供 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 等 API。客户端只需对接自己偏好的协议格式。

## 快速开始

```bash
bun install
cp config/settings.example.jsonc config/settings.jsonc
# 编辑 config/settings.jsonc，填入上游 baseURL 和 apiKey
bun dev serve
```

自定义配置路径：`LLM_PROXY_SETTINGS_FILE=path/to/settings.jsonc bun dev serve`

## API

| 端点                         | 说明                                             |
| ---------------------------- | ------------------------------------------------ |
| `GET /health`                | 服务状态和 provider 数量                         |
| `POST /v1/chat/completions`  | OpenAI Chat（非流式 + `stream: true` SSE）       |
| `POST /v1/responses`         | OpenAI Responses（命名事件 SSE）                 |
| `POST /v1/messages`          | Anthropic Messages（非流式 + SSE）               |
| `GET /v1/models`             | 可用模型列表                                     |
| `GET /v1/models/*`           | 单模型详情                                       |
| `POST /codex/v1/responses`   | Codex CLI 兼容端点（复用 OpenAI Responses 协议） |
| `GET /codex/v1/models`       | Codex bundled catalog 格式模型列表               |
| `GET /oauth/login/:provider` | OAuth 登录入口（仅配置 oauth 时挂载）            |
| `GET /oauth/callback`        | OAuth 授权码回调（仅配置 oauth 时挂载）          |

请求格式兼容对应上游 API，支持 messages、tools、tool_choice 等字段。未知字段作为 `providerOptions` 透传给上游。

## CLI

基于 Commander.js，通过 `bun dev <command>` 调用：

| 命令                                      | 用途                                                   |
| ----------------------------------------- | ------------------------------------------------------ |
| `bun dev serve`                           | 启动开发服务器（默认无热重载）                         |
| `bun dev serve --watch`                   | 以 bun watch 模式启动开发服务器                        |
| `bun dev models sync`                     | 交互式同步上游模型到配置文件                           |
| `bun dev models sync -p <name>`           | 同步指定 provider                                      |
| `bun dev models sync --dry-run`           | 预览变更，不写入                                       |
| `bun dev models list`                     | 列出已配置模型                                         |
| `bun dev codex install`                   | 配置 Codex CLI 指向本代理（写 `~/.codex/config.toml`） |
| `bun run test`                            | 运行全部测试                                           |
| `bun run test test/xxx.test.ts`           | 运行单个测试                                           |
| `bun run typecheck`                       | 类型检查                                               |
| `bun run format` / `bun run format:check` | 写入 / 检查 Prettier 格式                              |
| `bun run generate:schema`                 | 从 Zod schema 生成 `config/settings.schema.json`       |

## 配置

配置文件为 JSONC 格式，示例见 [`config/settings.example.jsonc`](config/settings.example.jsonc)。

核心字段：

- **service** — 服务名（默认 `llm-proxy`）、监听地址和端口
- **requestTimeoutMs** — 请求超时毫秒（默认 30000）
- **routing** — 路由选项（`enableFlatModelLookup` 全局裸名查找）
- **providers** — 上游 provider 定义，每个包含 `type`、`baseURL`、`apiKey`、`headers`、`models`、`plugins`、`oauth`、`options`；类型特定配置放在 `options`
- **apiKey 轮询** — `apiKey` 支持字符串数组，按请求 round-robin 选择
- **模型别名** — `models` 中可定义 `aliases` 和自定义 `upstreamModel`
- **`${ENV_NAME}`** — 占位符，加载时从环境变量解析（仅匹配完整字符串）
- **proxy** — 可选 HTTP 代理（undici `ProxyAgent`）
- **plugins** — 全局/provider/model 三级插件（如 `vendor_sse_error` 检测上游限流）
- **oauth** — 支持 Authorization Code 和 Client Credentials 两种流程
- **codex** — 全局 Codex 兼容配置，含 `models_catalog`（catalog override，如 `templateSlug`、`context_window` 默认 200000，可被 `provider.options.codex`、`model.codex` 覆盖）和 `install`（codex install 写入 `~/.codex/config.toml` 的 provider 配置）

## 日志

`serve` 使用现有 Pino 结构化日志记录运行状态和请求遥测；其他一次性 CLI 命令只使用终端输出，不创建日志文件。日志可通过以下环境变量配置：

| 环境变量               | 默认值   | 说明                                  |
| ---------------------- | -------- | ------------------------------------- |
| `LLM_PROXY_LOG_LEVEL`  | `info`   | Pino 日志级别；非法值会使服务启动失败 |
| `LLM_PROXY_LOG_DIR`    | `./logs` | 普通日志和错误 NDJSON 的目录          |
| `LLM_PROXY_LOG_FORMAT` | `pretty` | `pretty` 文本或 `json` 结构化输出     |

每个协议请求最多包含三个稳定事件：`request.received`、上游调用前的 `request.route_resolved`，以及恰好一次的 `request.completed`。终态包含 HTTP `status`、`durationMs`、路由和执行模式；成功时还会记录可用的 finish reason、token usage 和上游 request ID。流式响应即使已经返回 HTTP 200，流内错误仍会通过 `outcome` 反映真实结果。

`outcome` 固定为：`success`、`validation_error`、`routing_error`、`client_error`、`auth_required`、`rate_limited`、`timeout`、`upstream_error`、`upstream_aborted`、`incomplete_stream`、`client_cancelled`、`internal_error`。成功的 `/health` 探针不写请求事件。

普通日志按中国日期跨日轮转并保留 7 天；启用 `errorLogging` 时，上游超时和真实上游/流失败另写脱敏、截断后的 `errors-YYYY-MM-DD.ndjson`，保留 30 天。验证、路由、认证、限流、上游 abort 和客户端取消不写错误 NDJSON。

## 安全

- 禁止提交 `.env*`、`config/settings.jsonc`、`config/auth.json`、日志或真实 API key
- 日志递归脱敏 API key、Authorization、OAuth token、client secret、cookie 等敏感字段
- 普通请求遥测不记录 prompt、completion、tool input、raw chunk、headers、OAuth code/state/nonce 或凭据
- API key 选择日志仅记录 provider 名称以及 `{ index, count }`，不记录 key、片段或指纹
