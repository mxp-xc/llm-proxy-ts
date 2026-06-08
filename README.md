# llm-proxy-ts

本地优先的 LLM 反向代理，暴露 OpenAI Chat Completions 兼容 API，通过 Vercel AI SDK 转发到上游 OpenAI-compatible provider。

Python/FastAPI 原版：[llm-proxy](https://github.com/mxp-xc/llm-proxy)

## 快速开始

```bash
pnpm install
cp config/settings.example.jsonc config/settings.jsonc
# 编辑 config/settings.jsonc，填入上游 baseURL 和 apiKey
pnpm dev
```

自定义配置路径：`LLM_PROXY_SETTINGS_FILE=path/to/settings.jsonc pnpm dev`

## API

| 端点                        | 说明                             |
| --------------------------- | -------------------------------- |
| `GET /health`               | 服务状态和 provider 数量         |
| `POST /v1/chat/completions` | 非流式 + `stream: true` SSE 流式 |
| `GET /v1/models`            | 可用模型列表                     |

请求格式兼容 OpenAI Chat Completions API，支持 messages、tools、tool_choice 等字段。未知字段作为 `providerOptions` 透传给上游。

## 配置

配置文件为 JSONC 格式，示例见 [`config/settings.example.jsonc`](config/settings.example.jsonc)。

核心字段：

- **service** — 监听地址和端口
- **providers** — 上游 provider 定义，每个包含 `baseURL`、`apiKey`、`models`
- **apiKey 轮询** — `apiKey` 支持字符串数组，按请求 round-robin 选择
- **模型别名** — `models` 中可定义 `aliases` 和自定义 `upstreamModel`
- **`${ENV_NAME}`** — 占位符，加载时从环境变量解析（仅匹配完整字符串）
- **proxy** — 可选 HTTP 代理（undici `ProxyAgent`）
- **plugins** — provider/model 级插件（如 `vendor_sse_error` 检测上游限流）

## 项目结构

```
apps/core/     @llm-proxy/core   — 配置系统、Provider 工厂、CLI 工具
apps/server/   @llm-proxy/server — Hono HTTP 服务器
config/        示例配置 + JSON Schema
```

## 命令

| 命令                   | 作用                                             |
| ---------------------- | ------------------------------------------------ |
| `pnpm dev`             | 启动开发服务器                                   |
| `pnpm test`            | 运行全部测试                                     |
| `pnpm typecheck`       | 类型检查                                         |
| `pnpm generate:schema` | 从 Zod schema 生成 `config/settings.schema.json` |
| `pnpm models:sync`     | 交互式同步上游模型到配置文件                     |

## 安全

- 禁止提交 `.env`、`settings.jsonc` 或真实 API key
- 日志自动脱敏 `apikey`、`authorization`、`x-api-key` 等敏感字段
- API key 选择日志仅记录 provider 名称和 key 索引
