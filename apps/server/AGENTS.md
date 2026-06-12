# AGENTS.md — @llm-proxy/server

Hono HTTP 服务器，暴露 OpenAI Chat Completions 兼容 API。依赖 `@llm-proxy/core`。

## 请求流程

```
Client → Hono app
  ├─ /v1/chat/completions  → handleProtocolRequest(openaiCompatibleStrategy)
  ├─ /v1/responses         → handleProtocolRequest(openaiResponsesStrategy)
  └─ /v1/messages          → handleProtocolRequest(anthropicStrategy)
```

三个端点共享同一个 `handleProtocolRequest` 通用函数，通过 `ProtocolStrategy` 策略接口区分协议特定的验证、映射、渲染和错误格式化逻辑。

## 关键架构

- **server 的 `protocols/` 是旧版独立实现**，app.ts 实际从 `@llm-proxy/core` 导入协议逻辑。server 本地副本已不再使用，后续可删除。
- **端点隔离：** `/v1/messages` 仅路由到 `type: 'anthropic'` provider，`/v1/chat/completions` 和 `/v1/responses` 仅路由到 `type: 'openai-compatible'`。错误响应格式由各策略的 `ProtocolErrorFormatter` 决定。
- **可注入依赖：** `createApp()` 接受 `ModelGateway`、`ProviderRegistry`、`TokenManager` 覆盖——这是主要测试接缝，通过 `app.fetch()` 直接测试，无需 HTTP 服务器。
- **流首包检查：** `vendor_sse_error` 插件窥视第一个 SSE chunk，检测限流错误时中断流返回 429。
- **Provider options 透传：** 不在 `mappedRequestKeys` 内的未知字段作为 `providerOptions.{providerName}` 转发。
- **OAuth 启动校验：** 自动刷新过期 token，未认证的 provider 打印登录 URL 且不阻塞启动。

## 命令

| 命令                   | 作用                                                 |
| ---------------------- | ---------------------------------------------------- |
| `pnpm generate:schema` | 从 Zod schema 重新生成 `config/settings.schema.json` |

## 敏感数据

- 禁止提交 `.env`、`settings.jsonc`、`auth.json` 或真实 API key。
- 日志自动脱敏：`apikey`、`api_key`、`authorization`、`x-api-key`、`proxy-authorization`（不区分大小写）。
- OAuth `clientSecret` 应使用 `${ENV_VAR}` 占位符。
