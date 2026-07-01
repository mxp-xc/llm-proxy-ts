# /codex 上下文根 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/codex` 上下文根(Hono 子应用挂载),提供 `POST /codex/v1/responses`(复用 `openaiResponsesStrategy`)与 `GET /codex/v1/models`(复用 `listModels` 自定义实现)两个端点,行为与现有 `/v1/responses`、`/v1/models` 严格一致。

**Architecture:** 沿用项目已有的子应用挂载模式(同 `/oauth` → `createOAuthCallbackApp`)。新增 `src/server/codex.ts` 导出 `createCodexApp(deps): Hono<AppEnv>`,在 `createApp` 内构造 `protocolCtx` 后通过 `app.route('/codex', createCodexApp(...))` 挂载。子应用用同一 `protocolCtx` 与 `openaiResponsesStrategy`,不引入 `/codex` 专属分支。主 app 的 `app.use('*', ...)` 全局中间件对挂载点生效,`/codex/*` 自动获得 requestId/logger/计时/`x-request-id`。

**Tech Stack:** Hono v4.12、TypeScript(ESM + NodeNext,`.js` 扩展名)、Vitest、Vercel AI SDK。

## Global Constraints

- 所有本地导入必须用 `.js` 扩展名(ESM + `NodeNext`)。
- `tsconfig.base.json` 启用 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`verbatimModuleSyntax`——type-only 导入用 `import type`。
- 测试用 Vitest,无网络;通过 `createApp({...}).request('/path')` 直接测试。
- `/codex/v1/responses` 必须与 `/v1/responses` 严格一致:同一 `openaiResponsesStrategy`、同一 `protocolCtx`,不引入 `/codex` 专属分支。
- 子应用仅两个端点(`/v1/responses`、`/v1/models`),不新增 models 详情或其它路由。
- 现有 `/v1/*` 端点代码与行为均不改动。
- 命令:`pnpm test`(全部测试)、`pnpm test test/server/codex-endpoint.test.ts`(单文件)、`pnpm typecheck`。
- commit 需用户审批后方可执行(CLAUDE.md 约定);分支:`main`。

---

### Task 1: /codex/v1/models 端点 + 子应用骨架

**Files:**

- Create: `src/server/codex.ts`
- Create: `test/server/codex-endpoint.test.ts`
- Modify: `src/server/app.ts`(加导入 + 挂载 `app.route('/codex', ...)`)

**Interfaces:**

- Consumes: `listModels(settings: Settings): OpenAIModelList`(来自 `../index.js`)、`AppEnv`(来自 `./types.js`)、`Settings`(来自 `../index.js`)
- Produces: `createCodexApp(deps: { settings: Settings }): Hono<AppEnv>`(本任务签名只含 `settings`;Task 2 扩展为含 `protocolCtx`)

- [ ] **Step 1: Write the failing test**

创建 `test/server/codex-endpoint.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { makeSettings } from '../helpers/settings.js'
import { stubRegistry } from '../helpers/registry.js'

const openrouterSettings = makeSettings({
  openrouter: {
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'secret',
    headers: {},
    plugins: [],
    models: { chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] } },
  },
})

describe('GET /codex/v1/models', () => {
  it('returns the same list as /v1/models', async () => {
    const app = createApp({ settings: openrouterSettings, providerRegistry: stubRegistry })
    const [codexRes, v1Res] = await Promise.all([
      app.request('/codex/v1/models'),
      app.request('/v1/models'),
    ])
    expect(codexRes.status).toBe(200)
    expect(await codexRes.json()).toEqual(await v1Res.json())
  })

  it('injects x-request-id (middleware covers /codex)', async () => {
    const app = createApp({ settings: openrouterSettings, providerRegistry: stubRegistry })
    const res = await app.request('/codex/v1/models')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test test/server/codex-endpoint.test.ts`
Expected: FAIL —— `/codex/v1/models` 返回 404(路由不存在),`expect(codexRes.status).toBe(200)` 失败。

- [ ] **Step 3: Create `src/server/codex.ts`**

```typescript
import { Hono } from 'hono'
import { listModels } from '../index.js'
import type { Settings } from '../index.js'
import type { AppEnv } from './types.js'

interface CodexAppDeps {
  settings: Settings
}

export function createCodexApp(deps: CodexAppDeps): Hono<AppEnv> {
  const { settings } = deps
  const app = new Hono<AppEnv>()

  app.get('/v1/models', (c) => c.json(listModels(settings)))

  return app
}
```

- [ ] **Step 4: Mount `/codex` in `src/server/app.ts`**

在导入区(`import { createOAuthCallbackApp } from './oauth/callback.js'` 下一行)加:

```typescript
import { createCodexApp } from './codex.js'
```

在 `app.post('/v1/responses', ...)` 路由之后、`return app` 之前加挂载:

```typescript
app.route('/codex', createCodexApp({ settings }))
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test test/server/codex-endpoint.test.ts`
Expected: PASS —— 两个用例(列表一致 + x-request-id 注入)均通过。

- [ ] **Step 6: Commit**

```bash
git add src/server/codex.ts src/server/app.ts test/server/codex-endpoint.test.ts
git commit -m "feat: add /codex context root with /v1/models endpoint"
```

---

### Task 2: /codex/v1/responses 端点

**Files:**

- Modify: `src/server/codex.ts`(加 `protocolCtx` 依赖 + `/v1/responses` 路由)
- Modify: `src/server/app.ts`(挂载调用改为传 `protocolCtx`)
- Modify: `test/server/codex-endpoint.test.ts`(加 imports + `stripVolatile` + `POST /codex/v1/responses` describe 块)

**Interfaces:**

- Consumes: `handleProtocolRequest(c, strategy, ctx)` 与 `ProtocolContext`(来自 `./handle-protocol.js`)、`openaiResponsesStrategy`(来自 `../index.js`)、Task 1 的 `createCodexApp`、`makeGateway`/`stubRegistry`/`makeSettings`(test helpers)、`GenerateTextReturn`/`ProxyStreamPart`(类型)
- Produces: `createCodexApp(deps: { settings: Settings; protocolCtx: ProtocolContext }): Hono<AppEnv>`(最终签名)

- [ ] **Step 1: Add the failing tests**

在 `test/server/codex-endpoint.test.ts` 顶部 imports 追加:

```typescript
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import { makeGateway } from '../helpers/gateway.js'
import type { GenerateTextReturn } from '../../src/server/types.js'
```

在文件末尾追加 `stripVolatile` helper 与 `POST /codex/v1/responses` describe 块:

```typescript
/** 剥离响应中的随机字段(id / created_at),用于跨路径结构对比。 */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'id' || k === 'created_at') continue
      out[k] = stripVolatile(v)
    }
    return out
  }
  return value
}

const responsesBody = JSON.stringify({ model: 'openrouter/chat', input: 'hi' })

describe('POST /codex/v1/responses', () => {
  it('returns the same non-streaming response as /v1/responses (minus volatile fields)', async () => {
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'hello',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as GenerateTextReturn
      },
    })
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })
    const [codexRes, v1Res] = await Promise.all([
      app.request('/codex/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: responsesBody,
      }),
      app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: responsesBody,
      }),
    ])
    expect(codexRes.status).toBe(200)
    expect(stripVolatile(await codexRes.json())).toEqual(stripVolatile(await v1Res.json()))
  })

  it('streams the same SSE event sequence as /v1/responses', async () => {
    const gateway = makeGateway({
      stream() {
        return (async function* () {
          yield { type: 'text-delta', text: 'Hello' }
          yield { type: 'text-delta', text: ' world' }
          yield {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })
    const body = JSON.stringify({ model: 'openrouter/chat', input: 'hi', stream: true })
    const [codexRes, v1Res] = await Promise.all([
      app.request('/codex/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    ])
    expect(codexRes.status).toBe(200)
    expect(codexRes.headers.get('content-type')).toBe('text/event-stream')
    const eventTypes = (text: string) =>
      text
        .split('\n')
        .filter((l) => l.startsWith('event:'))
        .map((l) => l.slice(6).trim())
    expect(eventTypes(await codexRes.text())).toEqual(eventTypes(await v1Res.text()))
  })

  it('returns the same 404 error as /v1/responses for unknown model', async () => {
    const app = createApp({ settings: openrouterSettings, providerRegistry: stubRegistry })
    const body = JSON.stringify({ model: 'unknown/model', input: 'hi' })
    const [codexRes, v1Res] = await Promise.all([
      app.request('/codex/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    ])
    expect(codexRes.status).toBe(404)
    expect(await codexRes.json()).toEqual(await v1Res.json())
  })

  it('injects x-request-id (middleware covers /codex)', async () => {
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'hello',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as GenerateTextReturn
      },
    })
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })
    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: responsesBody,
    })
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/server/codex-endpoint.test.ts`
Expected: FAIL —— `POST /codex/v1/responses` 返回 404(路由未定义);`GET /codex/v1/models` 用例仍通过(Task 1 已实现)。

- [ ] **Step 3: Add `/v1/responses` route to `src/server/codex.ts`**

将 `src/server/codex.ts` 整体替换为:

```typescript
import { Hono } from 'hono'
import { listModels, openaiResponsesStrategy } from '../index.js'
import type { Settings } from '../index.js'
import { handleProtocolRequest } from './handle-protocol.js'
import type { ProtocolContext } from './handle-protocol.js'
import type { AppEnv } from './types.js'

interface CodexAppDeps {
  settings: Settings
  protocolCtx: ProtocolContext
}

export function createCodexApp(deps: CodexAppDeps): Hono<AppEnv> {
  const { settings, protocolCtx } = deps
  const app = new Hono<AppEnv>()

  app.post('/v1/responses', (c) => handleProtocolRequest(c, openaiResponsesStrategy, protocolCtx))
  app.get('/v1/models', (c) => c.json(listModels(settings)))

  return app
}
```

- [ ] **Step 4: Pass `protocolCtx` to the mount in `src/server/app.ts`**

把 Task 1 加的挂载行:

```typescript
app.route('/codex', createCodexApp({ settings }))
```

改为:

```typescript
app.route('/codex', createCodexApp({ settings, protocolCtx }))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test test/server/codex-endpoint.test.ts`
Expected: PASS —— 全部用例(非流式对比、流式事件序列对比、404 对比、x-request-id)通过。

- [ ] **Step 6: Commit**

```bash
git add src/server/codex.ts src/server/app.ts test/server/codex-endpoint.test.ts
git commit -m "feat: add POST /codex/v1/responses endpoint"
```

---

### Task 3: 类型检查 + 全量测试 + 文档提交

**Files:**

- Verify only(不改实现代码)

- [ ] **Step 1: Run typecheck**

Run: `pnpm typecheck`
Expected: 无错误退出(Exit code 0)。

- [ ] **Step 2: Run full test suite**

Run: `pnpm test`
Expected: 全部测试通过(含原有 `/v1/*` 测试与新增 `/codex/*` 测试,无回归)。

- [ ] **Step 3: Commit spec & plan docs**

```bash
git add docs/superpowers/specs/2026-06-23-codex-endpoint-design.md docs/superpowers/plans/2026-06-23-codex-endpoint.md
git commit -m "docs: add /codex context root design spec & implementation plan"
```
