import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import type { Settings } from '../../src/index.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import { makeGateway } from '../helpers/gateway.js'
import { makeSettings } from '../helpers/settings.js'
import { stubRegistry } from '../helpers/registry.js'
import type { generateText } from 'ai'

/** generateText 的返回类型 */
type GenerateTextReturn = Awaited<ReturnType<typeof generateText>>

// ── Shared helpers ──────────────────────────────────────────────

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

// ── health endpoint ─────────────────────────────────────────────

describe('health endpoint', () => {
  it('returns local service status without providers', async () => {
    const app = createApp({
      settings: makeSettings(),
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
    const gateway = makeGateway({
      async generate() {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('late upstream secret')
      },
    })
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
    const gateway = makeGateway({
      stream() {
        return delayedFirstChunk() as AsyncIterable<ProxyStreamPart>
      },
    })
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
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'hello',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as GenerateTextReturn
      },
    })
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
    const gateway = makeGateway({
      async generate() {
        return result as GenerateTextReturn
      },
    })
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
    const gateway = makeGateway({
      async generate() {
        calls += 1
        return { text: 'wrong' } as GenerateTextReturn
      },
      stream() {
        calls += 1
        throw new Error('wrong')
      },
    })
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
    const gateway = makeGateway({
      stream() {
        throw new Error('upstream secret token')
      },
    })
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
    const gateway = makeGateway({
      stream() {
        return throwingFirstChunk() as AsyncIterable<ProxyStreamPart>
      },
    })
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
    const gateway = makeGateway({
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
    })

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
    const gateway = makeGateway({
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
    })

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
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'from generate',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as GenerateTextReturn
      },
    })

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

    const gateway = makeGateway({
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
    })

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

const anthropicSettings = makeSettings({
  claude: {
    type: 'anthropic',
    apiKey: 'sk-ant-secret',
    headers: {},
    plugins: [],
    models: {
      sonnet: { upstreamModel: 'claude-sonnet-4-5', aliases: [], headers: {}, plugins: [] },
    },
  },
})

describe('messages endpoint', () => {
  it('returns Anthropic-format non-streaming response', async () => {
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'Hello!',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
          response: { id: 'msg_test123', timestamp: new Date() },
        } as GenerateTextReturn
      },
    })
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
    const gateway = makeGateway({
      stream() {
        return textDeltaStream('Hello world') as AsyncIterable<ProxyStreamPart>
      },
    })
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
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'Hi from OpenRouter!',
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 3 },
          response: { id: 'chatcmpl-test', timestamp: new Date() },
        } as GenerateTextReturn
      },
    })
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
    const gateway = makeGateway({
      async generate() {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('late upstream secret')
      },
    })
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
    const gateway = makeGateway({
      async generate() {
        throw new Error('upstream secret token')
      },
    })
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
