import { describe, expect, it } from 'vitest'
import { createApp, type ModelGateway } from '../src/app.js'
import type { Settings, ProviderRegistry } from '@llm-proxy/core'

const settings: Settings = {
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

const stubRegistry: ProviderRegistry = {
  languageModel() {
    return {} as never
  },
  debugProviderConfig() {
    return {} as never
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
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })

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
        return textDeltaStream('Hello world')
      },
    }
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })

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
    const app = createApp({ settings, providerRegistry: stubRegistry })

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
      ...settings,
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
    const app = createApp({ settings, providerRegistry: stubRegistry })

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
      settings: { ...settings, requestTimeoutMs: 5 },
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
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })

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

// ─── Test Helpers ──────────────────────────────────────────────

async function* textDeltaStream(text: string): AsyncIterable<unknown> {
  const words = text.split(' ')
  for (const word of words) {
    yield { type: 'text-delta', text: word + ' ' }
  }
  yield { type: 'finish', finishReason: 'stop', outputTokens: 5 }
}
