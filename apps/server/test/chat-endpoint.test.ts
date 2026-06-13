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

const stubRegistry: ProviderRegistry = {
  languageModel() {
    return { model: {} as never }
  },
  debugProviderConfig() {
    return {} as never
  },
}

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
      settings: { ...settings, requestTimeoutMs: 5 },
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
        return delayedFirstChunk()
      },
    }
    const app = createApp({
      settings: { ...settings, requestTimeoutMs: 5 },
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
      settings,
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
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })

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
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })

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
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })

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
        return throwingFirstChunk()
      },
    }
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })

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

async function* throwingFirstChunk(): AsyncIterable<unknown> {
  throw new Error('first chunk secret')
}

async function* delayedFirstChunk(): AsyncIterable<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 50))
  yield { type: 'text-delta', text: 'late' }
}

describe('streamOnly provider', () => {
  const streamOnlySettings: Settings = {
    ...settings,
    providers: {
      openrouter: {
        ...settings.providers.openrouter!,
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
          yield { type: 'text-delta', textDelta: 'Hello' }
          yield { type: 'text-delta', textDelta: ' world' }
          yield {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            response: { id: 'chatcmpl-streamonly' },
          }
        })()
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
          yield { type: 'text-delta', textDelta: 'Hello' }
          yield { type: 'text-delta', textDelta: ' world' }
          yield {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })()
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
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })

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
})
