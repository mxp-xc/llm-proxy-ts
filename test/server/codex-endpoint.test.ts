import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { makeSettings } from '../helpers/settings.js'
import { stubRegistry } from '../helpers/registry.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import { makeGateway } from '../helpers/gateway.js'
import type { GenerateTextReturn } from '../../src/server/types.js'
import { CodexCatalogCache, type CodexCatalogFetcher } from '../../src/server/codex-catalog.js'

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

const FULL_MODEL = {
  slug: 'gpt-5.4',
  display_name: 'GPT-5.4',
  supported_reasoning_levels: [],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 0,
  base_instructions: 'x',
  supports_reasoning_summaries: false,
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: false,
  experimental_supported_tools: [],
}

const codexFetcher: CodexCatalogFetcher = async () =>
  JSON.stringify({ models: [FULL_MODEL] })

describe('GET /codex/v1/models', () => {
  it('returns codex ModelsResponse with one entry per listModels id', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogCache: new CodexCatalogCache(codexFetcher),
    })
    const res = await app.request('/codex/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.models).toHaveLength(1)
    expect(body.models[0].slug).toBe('openrouter/chat')
    expect(body.models[0].visibility).toBe('list')
    expect(body.models[0].supported_in_api).toBe(true)
  })

  it('injects x-request-id (middleware covers /codex)', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogCache: new CodexCatalogCache(codexFetcher),
    })
    const res = await app.request('/codex/v1/models')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns 503 when codex fetch fails', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogCache: new CodexCatalogCache(async () => {
        throw new Error('codex not installed')
      }),
    })
    const res = await app.request('/codex/v1/models')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.type).toBe('server_error')
    expect(body.error.message).toContain('codex not installed')
  })

  it('returns 503 with short reason (no ZodError JSON) on catalog schema failure', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogCache: new CodexCatalogCache(async () => JSON.stringify({ models: [{}] })),
    })
    const res = await app.request('/codex/v1/models')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.type).toBe('server_error')
    expect(body.error.message).toContain('schema validation failed')
    expect(body.error.message).not.toMatch(/"issues"|"path"|"received"/)
  })
})

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
