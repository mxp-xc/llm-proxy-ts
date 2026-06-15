import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp, type ModelGateway } from '../../src/server/app.js'
import type { Settings, ProviderRegistry } from '../../src/index.js'
import { loadEnvironmentFiles, resolveSettingsPath, inspectVendorSseError } from '../../src/index.js'
import { redact, safeProxyHost } from '../../src/server/logging.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'

// ── Shared helpers ──────────────────────────────────────────────

const stubRegistry: ProviderRegistry = {
  languageModel() {
    return { model: {} as never }
  },
  debugProviderConfig() {
    return {} as never
  },
}

const openrouterSettings: Settings = {
  service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
  requestTimeoutMs: 30000,
  proxy: null,
  routing: { enableFlatModelLookup: false },
  plugins: [],
  providers: {
    openrouter: {
      type: 'openai-compatible',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'secret',
      headers: {},
      plugins: [],
      models: { chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] } },
    },
  },
}

// ── health endpoint ─────────────────────────────────────────────

describe('health endpoint', () => {
  it('returns local service status without providers', async () => {
    const app = createApp({
      settings: {
        service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
        requestTimeoutMs: 30000,
        proxy: null,
        routing: { enableFlatModelLookup: false },
        plugins: [],
        providers: {},
      },
      providerRegistry: stubRegistry,
    })

    const response = await app.request('/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'llm-proxy',
      providersConfigured: 0,
    })
  })
})

// ── chat endpoint ───────────────────────────────────────────────

describe('chat endpoint', () => {
  it('returns safe JSON 504 when non-streaming upstream generation times out', async () => {
    const gateway: ModelGateway = {
      async generate() {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('late upstream secret')
      },
      stream() {
        throw new Error('not used')
      },
    }
    const app = createApp({
      settings: { ...openrouterSettings, requestTimeoutMs: 5 },
      gateway,
      providerRegistry: stubRegistry,
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(504)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json()
    expect(body).toEqual({
      error: {
        type: 'upstream_error',
        code: 'upstream_request_timeout',
        message: 'Upstream provider request timed out',
      },
    })
    expect(JSON.stringify(body)).not.toContain('late upstream secret')
  })

  it('returns safe JSON 504 when stream first chunk inspection times out before headers', async () => {
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('not used')
      },
      stream() {
        return delayedFirstChunk() as AsyncIterable<ProxyStreamPart>
      },
    }
    const app = createApp({
      settings: { ...openrouterSettings, requestTimeoutMs: 5 },
      gateway,
      providerRegistry: stubRegistry,
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(504)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        type: 'upstream_error',
        code: 'upstream_request_timeout',
        message: 'Upstream provider request timed out',
      },
    })
  })

  it('returns non-streaming OpenAI-compatible responses', async () => {
    const modelSelections: string[] = []
    const gateway: ModelGateway = {
      async generate() {
        return {
          text: 'hello',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }
      },
      stream() {
        throw new Error('not used')
      },
    }
    const app = createApp({
      settings: openrouterSettings,
      gateway,
      providerRegistry: {
        languageModel(providerName, upstreamModel) {
          modelSelections.push(`${providerName}/${upstreamModel}`)
          return { model: { providerName, upstreamModel } as never }
        },
        debugProviderConfig() {
          throw new Error('not used')
        },
      },
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.choices[0].message.content).toBe('hello')
    expect(modelSelections).toEqual(['openrouter/openrouter/chat'])
  })

  it('returns non-streaming OpenAI-compatible responses when result fields are non-enumerable', async () => {
    const result = {}
    Object.defineProperties(result, {
      text: { get: () => 'hello from getter' },
      finishReason: { value: 'stop' },
      usage: { value: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    })
    const gateway: ModelGateway = {
      async generate() {
        return result
      },
      stream() {
        throw new Error('not used')
      },
    }
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.choices[0].message.content).toBe('hello from getter')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
  })

  it('does not call gateway on routing errors', async () => {
    let calls = 0
    const gateway: ModelGateway = {
      async generate() {
        calls += 1
        return { text: 'wrong' }
      },
      stream() {
        calls += 1
        throw new Error('wrong')
      },
    }
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'missing/chat', messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(response.status).toBe(404)
    expect(calls).toBe(0)
  })

  it('returns a safe JSON 502 when stream creation throws synchronously', async () => {
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('not used')
      },
      stream() {
        throw new Error('upstream secret token')
      },
    }
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json()
    expect(body).toEqual({
      error: {
        type: 'upstream_error',
        code: 'upstream_request_failed',
        message: 'Upstream provider request failed',
      },
    })
    expect(JSON.stringify(body)).not.toContain('upstream secret token')
  })

  it('returns a safe JSON 502 when the first stream chunk throws', async () => {
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('not used')
      },
      stream() {
        return throwingFirstChunk() as AsyncIterable<ProxyStreamPart>
      },
    }
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json()
    expect(body).toEqual({
      error: {
        type: 'upstream_error',
        code: 'upstream_request_failed',
        message: 'Upstream provider request failed',
      },
    })
    expect(JSON.stringify(body)).not.toContain('first chunk secret')
  })
})

describe('streamOnly provider', () => {
  const streamOnlySettings: Settings = {
    ...openrouterSettings,
    providers: {
      openrouter: {
        ...openrouterSettings.providers.openrouter!,
        options: { streamOnly: true },
      },
    },
  }

  it('returns non-stream JSON when streamOnly and client sends stream: false', async () => {
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('generate should not be called for streamOnly provider')
      },
      stream() {
        return (async function* () {
          yield { type: 'text-delta', text: 'Hello' }
          yield { type: 'text-delta', text: ' world' }
          yield {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            response: { id: 'chatcmpl-streamonly' },
          }
        })() as AsyncIterable<ProxyStreamPart>
      },
    }

    const app = createApp({ settings: streamOnlySettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json()
    expect(body.object).toBe('chat.completion')
    expect(body.choices[0].message.content).toBe('Hello world')
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.prompt_tokens).toBe(10)
    expect(body.usage.completion_tokens).toBe(5)
  })

  it('still returns SSE when streamOnly and client sends stream: true', async () => {
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('should not be called')
      },
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
    }

    const app = createApp({ settings: streamOnlySettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
  })

  it('does not affect non-streamOnly providers', async () => {
    const gateway: ModelGateway = {
      async generate() {
        return {
          text: 'from generate',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }
      },
      stream() {
        throw new Error('stream should not be called')
      },
    }

    // 使用原始 settings（无 streamOnly）
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.choices[0].message.content).toBe('from generate')
  })

  it('returns 429 when streamOnly provider returns rate-limit error in first chunk', async () => {
    const streamOnlyWithPlugin: Settings = {
      ...openrouterSettings,
      providers: {
        openrouter: {
          ...openrouterSettings.providers.openrouter!,
          options: { streamOnly: true },
          plugins: [{ name: 'vendor_sse_error', config: { rateLimitCodes: ['rate_limit'] }, providers: [] }],
        },
      },
    }

    const gateway: ModelGateway = {
      async generate() {
        throw new Error('generate should not be called for streamOnly provider')
      },
      stream() {
        return (async function* () {
          yield {
            type: 'raw',
            rawValue:
              'data: {"error":{"message":"secret text","code":"rate_limit","type":"rate_limit_error"}}\n\n',
          }
        })() as AsyncIterable<ProxyStreamPart>
      },
    }

    const app = createApp({ settings: streamOnlyWithPlugin, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    })

    expect(response.status).toBe(429)
    const body = await response.json()
    expect(body.error.code).toBe('rate_limit')
    expect(JSON.stringify(body)).not.toContain('secret text')
  })
})

// ── messages endpoint ───────────────────────────────────────────

const anthropicSettings: Settings = {
  service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
  requestTimeoutMs: 30000,
  proxy: null,
  routing: { enableFlatModelLookup: false },
  plugins: [],
  providers: {
    claude: {
      type: 'anthropic',
      apiKey: 'sk-ant-secret',
      headers: {},
      plugins: [],
      models: {
        sonnet: { upstreamModel: 'claude-sonnet-4-5', aliases: [], headers: {}, plugins: [] },
      },
    },
  },
}

describe('messages endpoint', () => {
  it('returns Anthropic-format non-streaming response', async () => {
    const gateway: ModelGateway = {
      async generate() {
        return {
          text: 'Hello!',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
          response: { id: 'msg_test123', timestamp: new Date() },
        }
      },
      stream() {
        throw new Error('not used')
      },
    }
    const app = createApp({ settings: anthropicSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude/sonnet',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe('message')
    expect(body.role).toBe('assistant')
    expect(body.model).toBe('claude/sonnet')
    expect(body.stop_reason).toBe('end_turn')
    expect(body.stop_sequence).toBeNull()
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 5 })

    const content = body.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toBe('Hello!')
  })

  it('returns Anthropic-format streaming response', async () => {
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('not used')
      },
      stream() {
        return textDeltaStream('Hello world') as AsyncIterable<ProxyStreamPart>
      },
    }
    const app = createApp({ settings: anthropicSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude/sonnet',
        max_tokens: 1024,
        stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')

    const text = await response.text()
    // Anthropic SSE uses named events
    expect(text).toContain('event: message_start')
    expect(text).toContain('event: content_block_start')
    expect(text).toContain('event: content_block_delta')
    expect(text).toContain('event: content_block_stop')
    expect(text).toContain('event: message_delta')
    expect(text).toContain('event: message_stop')
    // Should contain the text delta
    expect(text).toContain('text_delta')
  })

  it('returns 400 for invalid request body', async () => {
    const app = createApp({ settings: anthropicSettings, providerRegistry: stubRegistry })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude/sonnet' }), // missing max_tokens and messages
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe('error')
  })

  it('routes openai-compatible provider through /v1/messages with Anthropic format', async () => {
    const mixedSettings: Settings = {
      ...anthropicSettings,
      providers: {
        openrouter: {
          type: 'openai-compatible',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'secret',
          headers: {},
          plugins: [],
          models: { chat: { upstreamModel: 'chat', aliases: [], headers: {}, plugins: [] } },
        },
      },
    }
    const gateway: ModelGateway = {
      async generate() {
        return {
          text: 'Hi from OpenRouter!',
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 3 },
          response: { id: 'chatcmpl-test', timestamp: new Date() },
        }
      },
      stream() {
        throw new Error('not used')
      },
    }
    const app = createApp({ settings: mixedSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe('message')
    expect(body.role).toBe('assistant')
    expect(body.stop_reason).toBe('end_turn')
    const content = body.content as Array<Record<string, unknown>>
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toBe('Hi from OpenRouter!')
  })

  it('returns 404 for unknown model', async () => {
    const app = createApp({ settings: anthropicSettings, providerRegistry: stubRegistry })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude/nonexistent',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    })

    expect(response.status).toBe(404)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe('error')
  })

  it('returns Anthropic-format 504 on upstream timeout', async () => {
    const gateway: ModelGateway = {
      async generate() {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('late upstream secret')
      },
      stream() {
        throw new Error('not used')
      },
    }
    const app = createApp({
      settings: { ...anthropicSettings, requestTimeoutMs: 5 },
      gateway,
      providerRegistry: stubRegistry,
    })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude/sonnet',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    })

    expect(response.status).toBe(504)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe('error')
    const error = body.error as Record<string, unknown>
    expect(error.type).toBe('timeout_error')
    expect(JSON.stringify(body)).not.toContain('late upstream secret')
  })

  it('returns Anthropic-format 502 on upstream error', async () => {
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('upstream secret token')
      },
      stream() {
        throw new Error('not used')
      },
    }
    const app = createApp({ settings: anthropicSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude/sonnet',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    })

    expect(response.status).toBe(502)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.type).toBe('error')
    const error = body.error as Record<string, unknown>
    expect(error.type).toBe('api_error')
    expect(JSON.stringify(body)).not.toContain('upstream secret token')
  })
})

// ── models endpoint ─────────────────────────────────────────────

function makeModelsSettings(
  providers: Settings['providers'] = {},
  enableFlatModelLookup = false,
): Settings {
  return {
    service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
    requestTimeoutMs: 30000,
    proxy: null,
    routing: { enableFlatModelLookup },
    plugins: [],
    providers,
  }
}

const singleProvider: Settings['providers'] = {
  openrouter: {
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'secret',
    headers: {},
    plugins: [],
    models: {
      chat: {
        upstreamModel: 'openrouter/auto',
        aliases: ['default'],
        headers: {},
        plugins: [],
      },
    },
  },
}

const multiProvider: Settings['providers'] = {
  openrouter: {
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'secret',
    headers: {},
    plugins: [],
    models: {
      chat: { upstreamModel: 'openrouter/auto', aliases: [], headers: {}, plugins: [] },
      code: { upstreamModel: 'openrouter/code', aliases: [], headers: {}, plugins: [] },
    },
  },
  deepseek: {
    type: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'secret',
    headers: {},
    plugins: [],
    models: {
      reasoner: { upstreamModel: 'deepseek-reasoner', aliases: [], headers: {}, plugins: [] },
    },
  },
}

describe('GET /v1/models', () => {
  it('returns empty list when no providers configured', async () => {
    const app = createApp({ settings: makeModelsSettings(), providerRegistry: stubRegistry })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      object: 'list',
      data: [],
    })
  })

  it('returns models from a single provider', async () => {
    const app = createApp({
      settings: makeModelsSettings(singleProvider),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.object).toBe('list')
    expect(body.data).toEqual([
      { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter' },
    ])
  })

  it('returns models from multiple providers', async () => {
    const app = createApp({ settings: makeModelsSettings(multiProvider), providerRegistry: stubRegistry })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.object).toBe('list')
    expect(body.data).toHaveLength(3)
    expect(body.data).toEqual(
      expect.arrayContaining([
        { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter' },
        { id: 'openrouter/code', object: 'model', created: 0, owned_by: 'openrouter' },
        { id: 'deepseek/reasoner', object: 'model', created: 0, owned_by: 'deepseek' },
      ]),
    )
  })

  it('includes flat model names and aliases when enableFlatModelLookup is on', async () => {
    const app = createApp({
      settings: makeModelsSettings(singleProvider, true),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toEqual([
      { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter' },
      { id: 'chat', object: 'model', created: 0, owned_by: 'openrouter' },
      { id: 'default', object: 'model', created: 0, owned_by: 'openrouter' },
    ])
  })

  it('excludes flat names when enableFlatModelLookup is off', async () => {
    const app = createApp({
      settings: makeModelsSettings(singleProvider, false),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toEqual([
      { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter' },
    ])
  })
})

describe('GET /v1/models/:id', () => {
  it('returns a single model by id', async () => {
    const app = createApp({
      settings: makeModelsSettings(singleProvider),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/openrouter/chat')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: 'openrouter/chat',
      object: 'model',
      created: 0,
      owned_by: 'openrouter',
    })
  })

  it('returns 404 for unknown model', async () => {
    const app = createApp({
      settings: makeModelsSettings(singleProvider),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/openrouter/nonexistent')

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('returns 404 for unknown provider', async () => {
    const app = createApp({
      settings: makeModelsSettings(singleProvider),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/unknown/model')

    expect(response.status).toBe(404)
  })

  it('returns 400 when model id is empty', async () => {
    const app = createApp({
      settings: makeModelsSettings(singleProvider),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/')

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('resolves flat model name when enableFlatModelLookup is on', async () => {
    const app = createApp({
      settings: makeModelsSettings(singleProvider, true),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/chat')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: 'chat',
      object: 'model',
      created: 0,
      owned_by: 'openrouter',
    })
  })

  it('resolves alias when enableFlatModelLookup is on', async () => {
    const app = createApp({
      settings: makeModelsSettings(singleProvider, true),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/default')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: 'default',
      object: 'model',
      created: 0,
      owned_by: 'openrouter',
    })
  })

  it('returns 404 for flat name when enableFlatModelLookup is off', async () => {
    const app = createApp({
      settings: makeModelsSettings(singleProvider, false),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/chat')

    expect(response.status).toBe(404)
  })

  it('includes flat names only for providers with flat lookup enabled', async () => {
    const providers: Settings['providers'] = {
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        options: { enableFlatModelLookup: true },
        models: {
          chat: {
            upstreamModel: 'openrouter/auto',
            aliases: ['default'],
            headers: {},
            plugins: [],
          },
        },
      },
      deepseek: {
        type: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: {
          reasoner: { upstreamModel: 'deepseek-reasoner', aliases: [], headers: {}, plugins: [] },
        },
      },
    }
    const app = createApp({
      settings: makeModelsSettings(providers, false),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    const body = await response.json()
    // openrouter gets flat names (chat + default alias), deepseek does not
    expect(body.data).toEqual([
      { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter' },
      { id: 'chat', object: 'model', created: 0, owned_by: 'openrouter' },
      { id: 'default', object: 'model', created: 0, owned_by: 'openrouter' },
      { id: 'deepseek/reasoner', object: 'model', created: 0, owned_by: 'deepseek' },
    ])
  })

  it('resolves flat name only for provider with flat lookup enabled', async () => {
    const providers: Settings['providers'] = {
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        options: { enableFlatModelLookup: true },
        models: {
          chat: { upstreamModel: 'openrouter/auto', aliases: [], headers: {}, plugins: [] },
        },
      },
      deepseek: {
        type: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: {
          reasoner: { upstreamModel: 'deepseek-reasoner', aliases: [], headers: {}, plugins: [] },
        },
      },
    }
    const app = createApp({
      settings: makeModelsSettings(providers, false),
      providerRegistry: stubRegistry,
    })

    // 'chat' resolves via openrouter's flat lookup
    const chatResponse = await app.request('/v1/models/chat')
    expect(chatResponse.status).toBe(200)

    // 'reasoner' does NOT resolve because deepseek has flat lookup disabled
    const reasonerResponse = await app.request('/v1/models/reasoner')
    expect(reasonerResponse.status).toBe(404)
  })
})

// ── security and plugins ────────────────────────────────────────

const securityTestSettings: Settings = {
  service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
  requestTimeoutMs: 30000,
  proxy: null,
  routing: { enableFlatModelLookup: false },
  plugins: [],
  providers: {
    openrouter: {
      type: 'openai-compatible',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'secret',
      headers: {},
      plugins: [
        { name: 'vendor_sse_error', config: { rateLimitCodes: ['rate_limit'] }, providers: [] },
      ],
      models: { chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] } },
    },
  },
}

describe('logging redaction', () => {
  it('redacts known secret fields recursively', () => {
    expect(
      redact({ apiKey: 'secret', nested: { authorization: 'Bearer token' }, ok: 'value' }),
    ).toEqual({
      apiKey: '[REDACTED]',
      nested: { authorization: '[REDACTED]' },
      ok: 'value',
    })
  })

  it('logs only proxy host', () => {
    expect(safeProxyHost('http://user:pass@127.0.0.1:7890')).toBe('127.0.0.1:7890')
  })
})

describe('request id', () => {
  it('adds x-request-id to responses', async () => {
    const app = createApp({ settings: securityTestSettings, providerRegistry: stubRegistry })

    const response = await app.request('/health')

    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('vendor_sse_error', () => {
  it('converts provider stream rate-limit errors to a safe 429 response', () => {
    const result = inspectVendorSseError(
      { maxPreviewEvents: 3, maxPreviewBytes: 65536, rateLimitCodes: ['rate_limit'] },
      {
        type: 'raw',
        rawValue:
          'data: {"error":{"message":"secret text","code":"rate_limit","type":"rate_limit_error"}}\n\n',
      },
    )

    expect(result).toEqual({
      status: 429,
      body: {
        error: {
          message: 'Rate limited by upstream provider',
          code: 'rate_limit',
          type: 'rate_limit_error',
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('secret text')
  })

  it('does not call the gateway when a stream error is detected before sending headers', async () => {
    let calls = 0
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('not used')
      },
      stream() {
        calls += 1
        return streamError() as AsyncIterable<ProxyStreamPart>
      },
    }
    const app = createApp({ settings: securityTestSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(calls).toBe(1)
    expect(response.status).toBe(429)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    await expect(response.json()).resolves.toEqual({
      error: {
        message: 'Rate limited by upstream provider',
        code: 'rate_limit',
        type: 'rate_limit_error',
      },
    })
  })

  it('emits a safe SSE error chunk when a later stream chunk contains a vendor error', async () => {
    const gateway: ModelGateway = {
      async generate() {
        throw new Error('not used')
      },
      stream() {
        return streamLateError() as AsyncIterable<ProxyStreamPart>
      },
    }
    const app = createApp({ settings: securityTestSettings, gateway, providerRegistry: stubRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('"content":"hello"')
    expect(body).toContain(
      '"error":{"message":"Rate limited by upstream provider","code":"rate_limit","type":"rate_limit_error"}',
    )
    expect(body).not.toContain('secret text')
  })
})

describe('server settings path', () => {
  it('resolves the default settings file from the rootDir', () => {
    const rootDir = join(tmpdir(), 'test-app')
    const result = resolveSettingsPath({ rootDir })

    expect(result).toBe(resolve(rootDir, 'config/settings.jsonc'))
  })

  it('uses LLM_PROXY_SETTINGS_FILE before the default path', () => {
    const rootDir = join(tmpdir(), 'test-app')
    const cwd = join(tmpdir(), 'cwd')
    const result = resolveSettingsPath({
      cwd,
      rootDir,
      envSettingsFile: 'custom/settings.jsonc',
    })

    expect(result).toBe(resolve(cwd, 'custom/settings.jsonc'))
  })
})

describe('environment file loading', () => {
  it('loads root env files with .local overriding .env', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-env-'))
    const keys = ['ROOT_ONLY', 'SHARED_VALUE', 'LOCAL_VALUE']

    await writeFile(
      join(rootDir, '.env'),
      'ROOT_ONLY=root\nSHARED_VALUE=root\nLOCAL_VALUE=root-env\n',
    )
    await writeFile(
      join(rootDir, '.env.local'),
      'SHARED_VALUE=root-local\nLOCAL_VALUE=root-local\n',
    )

    try {
      for (const key of keys) {
        delete process.env[key]
      }

      loadEnvironmentFiles({ rootDir })

      expect(process.env.ROOT_ONLY).toBe('root')
      expect(process.env.LOCAL_VALUE).toBe('root-local')
      expect(process.env.SHARED_VALUE).toBe('root-local')
    } finally {
      for (const key of keys) {
        delete process.env[key]
      }
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})

// ── smoke test ──────────────────────────────────────────────────

import { createProviderRegistry } from '../../src/index.js'

const BASE_URL = process.env.LLM_PROXY_TEST_BASE_URL
const API_KEY = process.env.LLM_PROXY_TEST_API_KEY
const MODEL = process.env.LLM_PROXY_TEST_MODEL
const shouldRunSmoke = Boolean(BASE_URL) && Boolean(API_KEY) && Boolean(MODEL)

describe('smoke test (streaming)', () => {
  it.skipIf(!shouldRunSmoke)(
    'proxies a streaming chat completion to the configured external model',
    { timeout: 30_000 },
    async () => {
      const settings: Settings = {
        service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
        requestTimeoutMs: 30000,
        proxy: null,
        routing: { enableFlatModelLookup: false },
        plugins: [],
        providers: {
          smoke: {
            type: 'openai-compatible',
            baseURL: BASE_URL!,
            apiKey: API_KEY!,
            headers: {},
            plugins: [],
            models: {
              chat: {
                upstreamModel: MODEL!,
                aliases: [],
                headers: {},
                plugins: [],
              },
            },
          },
        },
      }
      const providerRegistry = await createProviderRegistry(settings)
      const app = createApp({ settings, providerRegistry })

      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'smoke/chat',
          stream: true,
          messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
        }),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')

      const body = await response.text()
      // SSE body should contain data: lines
      const dataLines = body.split('\n').filter((l) => l.startsWith('data: '))
      expect(dataLines.length).toBeGreaterThan(0)

      // Last non-[DONE] chunk should be a valid chat completion chunk
      const chunks = dataLines
        .map((l) => l.slice(6)) // strip "data: "
        .filter((d) => d !== '[DONE]')
        .map((d) => JSON.parse(d))

      // Should have at least one content chunk
      const contentChunks = chunks.filter((c: any) => c.choices?.[0]?.delta?.content)
      expect(contentChunks.length).toBeGreaterThan(0)

      // Full assembled content should be non-empty
      const fullContent = contentChunks.map((c: any) => c.choices[0].delta.content).join('')
      expect(fullContent.length).toBeGreaterThan(0)

      // Should end with [DONE]
      expect(body).toContain('data: [DONE]')
    },
  )
})

// ── Shared test helpers ─────────────────────────────────────────

async function* throwingFirstChunk(): AsyncIterable<unknown> {
  throw new Error('first chunk secret')
}

async function* delayedFirstChunk(): AsyncIterable<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 50))
  yield { type: 'text-delta', text: 'late' }
}

async function* textDeltaStream(text: string): AsyncIterable<unknown> {
  const words = text.split(' ')
  for (const word of words) {
    yield { type: 'text-delta', text: word + ' ' }
  }
  yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 0, outputTokens: 5 } }
}

async function* streamError(): AsyncIterable<unknown> {
  yield {
    type: 'raw',
    rawValue:
      'data: {"error":{"message":"secret text","code":"rate_limit","type":"rate_limit_error"}}\n\n',
  }
}

async function* streamLateError(): AsyncIterable<unknown> {
  yield { type: 'text-delta', text: 'hello' }
  yield {
    type: 'raw',
    rawValue:
      'data: {"error":{"message":"secret text","code":"rate_limit","type":"rate_limit_error"}}\n\n',
  }
}
