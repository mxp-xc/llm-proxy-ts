# /codex 上下文根设计

**日期**: 2026-06-23
**状态**: Draft
**范围**: v0 — 新增 `/codex` 上下文根,仅两个端点(`POST /codex/v1/responses` + `GET /codex/v1/models`),行为复用现有 openai-responses 与自定义 models 实现

## 1. 目标

新增 `/codex` 上下文根,提供与 openai-responses 协议等价的独立入口。客户端可将 base URL 指向 `http://host:port/codex`,用标准 Responses API 路径(`/v1/responses`)和模型列表路径(`/v1/models`)访问代理。`/codex` 与全局 `/v1` 命名空间隔离,各自拥有独立的 `/v1` 子层,不与全局 `/v1` 混用。

动机:按协议/用途分组,为特定入口(如 codex)提供独立上下文根。

**不在范围内**:

- 不拆分 openai-compatible / anthropic / openai-responses 三个协议到各自根(保留现有 `/v1/*` 不变)
- `GET /codex/v1/models/*`(模型详情)不实现
- `/codex` 不挂 `chat/completions` 或 `messages` 端点(仅 responses)
- 不做 `/codex` 专属的鉴权 / 限流 / 插件配置

## 2. 架构

沿用项目已有的子应用挂载模式(同 `/oauth` → `createOAuthCallbackApp`):新增独立 Hono 子应用,挂载到 `/codex`。

### 数据流

```
客户端 → POST /codex/v1/responses
       → 主 app 全局中间件(requestId / logger / 计时 / x-request-id)
       → /codex 子应用路由
       → handleProtocolRequest(c, openaiResponsesStrategy, protocolCtx)
       → validate → routingTable.resolve → mapToAISDKInput → gateway → render
       → 客户端
```

`GET /codex/v1/models` 直接返回 `listModels(settings)`,不经过 protocol 流程。

### 文件结构

```
新增/修改文件:
src/server/
  codex.ts                    ← 新增:createCodexApp(deps): Hono<AppEnv>
  app.ts                      ← 修改:挂载 app.route('/codex', createCodexApp(...))

test/server/
  codex-endpoint.test.ts      ← 新增:端点行为 + 中间件覆盖测试
```

## 3. 端点清单

| 方法 | 路径                  | 处理                                                             | 等价于               |
| ---- | --------------------- | ---------------------------------------------------------------- | -------------------- |
| POST | `/codex/v1/responses` | `handleProtocolRequest(c, openaiResponsesStrategy, protocolCtx)` | `POST /v1/responses` |
| GET  | `/codex/v1/models`    | `c.json(listModels(settings))`                                   | `GET /v1/models`     |

`/codex/v1/models` 为自定义实现(复用 `listModels`),不透传上游 models 端点,与 `/v1/models` 返回同源。

## 4. 组件

### createCodexApp

```typescript
// src/server/codex.ts
interface CodexAppDeps {
  settings: Settings
  protocolCtx: ProtocolContext
}

export function createCodexApp(deps: CodexAppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const { settings, protocolCtx } = deps

  app.post('/v1/responses', (c) => handleProtocolRequest(c, openaiResponsesStrategy, protocolCtx))
  app.get('/v1/models', (c) => c.json(listModels(settings)))

  return app
}
```

### 挂载

在 `createApp` 内,构造 `protocolCtx` 之后、与现有 `/v1/*` 路由并列处:

```typescript
app.route('/codex', createCodexApp({ settings, protocolCtx }))
```

挂载点位于 `app.use('*', ...)` 全局中间件之后,确保 `/codex/*` 请求经过 requestId / logger / 计时 / `x-request-id`。

## 5. 关键实现点

### 中间件覆盖

Hono `app.route('/codex', subApp)` 把子应用路由合并进主 app 路由树。主 app 的 `app.use('*', mw)` 全局中间件按路径匹配对 `/codex/*` 生效。`/codex` 请求自动获得 requestId、logger、计时、`x-request-id` header。以测试验证(断言 `/codex/v1/responses` 响应含 `x-request-id`)。

### 子应用类型

子应用用 `new Hono<AppEnv>()`,与主 app 同类型,确保 `handleProtocolRequest` 内 `c.set/c.get`(`provider`、`requestedModel`、`actualModel`、`keySelection`)类型正确。`protocolCtx`(含 `routingTable`、`settings`、`gateway`、`resolveModel`)通过闭包从 `createApp` 传入,与主 app 同源——任意 `/codex` 模型可路由到任意已配置 provider。

### 自定义 models

`/codex/v1/models` 复用 `listModels(settings)`,返回 `{ object: 'list', data: [...] }`(OpenAI 格式),与 `/v1/models` 完全一致。不透传上游 provider 的 models 端点。

## 6. 错误处理

完全复用现有,无新逻辑:

- `POST /codex/v1/responses`:校验 / 路由 / OAuth / 超时 / 上游错误经 `handleProtocolRequest` + `openaiResponsesStrategy.formatErrors`,与 `POST /v1/responses` 逐字一致(400 / 404 / 503 / 500 / 504 同格式)
- `GET /codex/v1/models`:无参数,不产生协议错误;空 provider 配置返回空列表(同 `/v1/models`)

## 7. 测试策略

新增 `test/server/codex-endpoint.test.ts`,镜像现有 `models-endpoint.test.ts` 与 responses 测试,用 `createApp({...}).request('/codex/...')`:

- `POST /codex/v1/responses` 非流式:同输入与 `/v1/responses` 响应一致
- `POST /codex/v1/responses` 流式:SSE 事件序列与 `/v1/responses` 一致
- `POST /codex/v1/responses` 错误:未知 model → 404、非法请求 → 400(格式同 `/v1/responses`)
- `GET /codex/v1/models`:返回与 `/v1/models` 一致(对象形状、模型列表)
- 中间件覆盖:`/codex/v1/responses` 与 `/codex/v1/models` 响应均含 `x-request-id`

## 8. 与现有代码的复用

- `handleProtocolRequest`(`src/server/handle-protocol.ts`):通用协议处理,直接复用,不修改
- `openaiResponsesStrategy`(`src/providers/openai-responses/strategy.ts`):Responses 协议策略实例,直接复用
- `listModels`(`src/providers/models.ts`):自定义模型列表,直接复用
- `ProtocolContext`、`AppEnv`(`src/server/types.ts`):类型与上下文,直接复用
- 子应用挂载模式:沿用 `createOAuthCallbackApp` + `app.route('/oauth', ...)` 先例

## 9. 约束与已知陷阱

- `/codex/v1/responses` 行为必须与 `/v1/responses` 严格一致(同一 strategy、同一 protocolCtx),不引入 `/codex` 专属分支
- 子应用仅两个端点,不新增 models 详情或其它路由
- 现有 `/v1/*` 端点代码与行为均不改动
- 中间件覆盖依赖 Hono `app.route` 合并机制;若实现时验证发现 `x-request-id` 未注入,需在子应用内补挂全局中间件(当前预期无需)
