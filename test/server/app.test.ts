import { describe, expect, it } from 'vitest'
import pino from 'pino'
import { createApp } from '../../src/server/app.js'
import type { Settings, TokenManager } from '../../src/index.js'
import type { ProviderRegistry } from '../../src/providers/registry.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import { makeGateway } from '../helpers/gateway.js'
import { makeSettings } from '../helpers/settings.js'
import { createProviderRegistryStub, stubRegistry } from '../helpers/registry.js'
import type { GenerateTextReturn } from '../../src/server/types.js'

/** 构造一个 pino logger，将 JSON 日志行收集到 logs 数组，便于断言 phase 字段。 */
function capturingPino(): { logger: pino.Logger; logs: Array<Record<string, unknown>> } {
  const logs: Array<Record<string, unknown>> = []
  const stream = {
    write(chunk: string) {
      try {
        logs.push(JSON.parse(chunk) as Record<string, unknown>)
      } catch {
        // 忽略非 JSON 行
      }
      return true
    },
  }
  const logger = pino({ level: 'info' }, stream)
  return { logger, logs }
}

/** 仅捕获 error 级别日志的 pino（用于断言上游错误 phase）。 */
function errorCapturingPino(): { logger: pino.Logger; logs: Array<Record<string, unknown>> } {
  const logs: Array<Record<string, unknown>> = []
  const stream = {
    write(chunk: string) {
      try {
        logs.push(JSON.parse(chunk) as Record<string, unknown>)
      } catch {
        // 忽略非 JSON 行
      }
      return true
    },
  }
  const logger = pino({ level: 'error' }, stream)
  return { logger, logs }
}

/** 逐词 yield 后延迟结束的流，用于测试流式 completed 日志时序。 */
async function* delayedTextStream(): AsyncIterable<unknown> {
  yield { type: 'text-delta', text: 'hello' }
  await new Promise((resolve) => setTimeout(resolve, 60))
  yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 0, outputTokens: 1 } }
}

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
      providerRegistry: createProviderRegistryStub({
        languageModel(providerName, upstreamModel) {
          modelSelections.push(`${providerName}/${upstreamModel}`)
          return { model: { providerName, upstreamModel } as never }
        },
      }),
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
          plugins: [{ name: 'vendor_sse_error', config: { rateLimitCodes: ['rate_limit'] } }],
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

    const app = createApp({
      settings: streamOnlyWithPlugin,
      gateway,
      providerRegistry: stubRegistry,
    })

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

  it('returns safe JSON 504 when streamOnly collectStreamResult times out after first chunk', async () => {
    const gateway = makeGateway({
      async generate() {
        throw new Error('generate should not be called for streamOnly provider')
      },
      stream() {
        return delayedSecondChunk() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({
      settings: { ...streamOnlySettings, requestTimeoutMs: 5 },
      gateway,
      providerRegistry: stubRegistry,
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
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
  })

  it('returns safe JSON 502 when streamOnly first chunk throws upstream error', async () => {
    const gateway = makeGateway({
      async generate() {
        throw new Error('generate should not be called for streamOnly provider')
      },
      stream() {
        return throwingFirstChunk() as AsyncIterable<ProxyStreamPart>
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

  it('logs phase "stream-only" when streamOnly upstream request fails', async () => {
    const { logger, logs } = errorCapturingPino()
    const gateway = makeGateway({
      async generate() {
        throw new Error('generate should not be called for streamOnly provider')
      },
      stream() {
        return throwingFirstChunk() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({
      settings: streamOnlySettings,
      gateway,
      providerRegistry: stubRegistry,
      logger,
    })

    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }),
    })

    const upstreamErrorLog = logs.find(
      (entry) => typeof entry.msg === 'string' && entry.msg === 'upstream request failed',
    )
    expect(upstreamErrorLog).toBeDefined()
    expect(upstreamErrorLog?.phase).toBe('stream-only')
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

// ── logging ─────────────────────────────────────────────────────

describe('request logging', () => {
  it('covers OAuth routes with request id and terminal logging', async () => {
    const { logger, logs } = capturingPino()
    const settings = makeSettings({
      oauth: {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: null,
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'model-x', aliases: [], headers: {}, plugins: [] } },
        oauth: {
          flow: 'authorization_code',
          clientId: 'client-id',
          clientSecret: 'client-secret',
          tokenUrl: 'https://auth.example.com/token',
          authorizationUrl: 'https://auth.example.com/authorize',
          scopes: [],
        },
      },
    })
    const app = createApp({
      settings,
      providerRegistry: stubRegistry,
      logger,
      tokenManager: {} as TokenManager,
      nonce: 'nonce',
    })

    const response = await app.request('/oauth/login/oauth')

    expect(response.status).toBe(302)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ msg: 'request received', path: '/oauth/login/oauth' }),
        expect.objectContaining({ msg: 'request completed', path: '/oauth/login/oauth' }),
      ]),
    )
  })

  it('logs "request received" (not "request started")', async () => {
    const { logger, logs } = capturingPino()
    const gateway = makeGateway({
      async generate() {
        return { text: 'hi', finishReason: 'stop' } as GenerateTextReturn
      },
    })
    const app = createApp({
      settings: openrouterSettings,
      gateway,
      providerRegistry: stubRegistry,
      logger,
    })

    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    const received = logs.find((e) => e.msg === 'request received')
    expect(received).toBeDefined()
    expect(logs.some((e) => e.msg === 'request started')).toBe(false)
  })

  it('logs "route resolved" with requestModel, upstreamModel and provider', async () => {
    const { logger, logs } = capturingPino()
    const gateway = makeGateway({
      async generate() {
        return { text: 'hi', finishReason: 'stop' } as GenerateTextReturn
      },
    })
    const app = createApp({
      settings: openrouterSettings,
      gateway,
      providerRegistry: stubRegistry,
      logger,
    })

    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    const resolved = logs.find((e) => e.msg === 'route resolved')
    expect(resolved).toBeDefined()
    expect(resolved?.requestModel).toBe('openrouter/chat')
    expect(resolved?.upstreamModel).toBe('openrouter/chat')
    expect(resolved?.provider).toBe('openrouter')
  })

  it('logs "request completed" immediately for non-streaming responses', async () => {
    const { logger, logs } = capturingPino()
    const gateway = makeGateway({
      async generate() {
        return { text: 'hi', finishReason: 'stop' } as GenerateTextReturn
      },
    })
    const app = createApp({
      settings: openrouterSettings,
      gateway,
      providerRegistry: stubRegistry,
      logger,
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    // 非 SSE 响应在 await next() 返回时就应已记 completed，无需消费 body
    const completed = logs.find((e) => e.msg === 'request completed')
    expect(completed).toBeDefined()
    expect(completed?.status).toBe(200)
  })

  it('defers "request completed" until stream body is consumed', async () => {
    const { logger, logs } = capturingPino()
    const gateway = makeGateway({
      stream() {
        return delayedTextStream() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({
      settings: openrouterSettings,
      gateway,
      providerRegistry: stubRegistry,
      logger,
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

    // Response object is created but stream not yet consumed → completed not logged
    expect(logs.some((e) => e.msg === 'request completed')).toBe(false)

    // Consume the stream
    await response.text()

    const completed = logs.find((e) => e.msg === 'request completed')
    expect(completed).toBeDefined()
    expect(completed?.status).toBe(200)
    // Stream has a 60ms delay, durationMs should reflect real consumption time
    expect(completed?.durationMs).toBeGreaterThanOrEqual(50)
  })

  it('logs "request completed" when an SSE stream errors during consumption', async () => {
    const { logger, logs } = capturingPino()
    const gateway = makeGateway({
      stream() {
        return breakingAfterFirstChunk() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({
      settings: openrouterSettings,
      gateway,
      providerRegistry: stubRegistry,
      logger,
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

    await expect(response.text()).rejects.toThrow('stream broke after first chunk')

    const completed = logs.filter((e) => e.msg === 'request completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      status: 200,
      provider: 'openrouter',
      requestedModel: 'openrouter/chat',
      actualModel: 'openrouter/chat',
    })
  })

  it('logs keySelection for generated responses', async () => {
    const { logger, logs } = capturingPino()
    const gateway = makeGateway({
      async generate() {
        return { text: 'hi', finishReason: 'stop' } as GenerateTextReturn
      },
    })
    const providerRegistry: ProviderRegistry = createProviderRegistryStub({
      languageModel() {
        return { model: {} as never, keySelection: { index: 1, count: 2 } }
      },
    })
    const app = createApp({
      settings: openrouterSettings,
      gateway,
      providerRegistry,
      logger,
    })

    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    const completed = logs.find((e) => e.msg === 'request completed')
    expect(completed?.keySelection).toEqual({ index: 1, count: 2 })
  })

  it('logs keySelection for openai responses AI SDK path', async () => {
    const { logger, logs } = capturingPino()
    const settings = makeSettings({
      openai: {
        type: 'openai',
        baseURL: 'http://mock-upstream/v1',
        apiKey: 'sk-test',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
      },
    })
    const providerRegistry: ProviderRegistry = {
      languageModel() {
        return {
          model: { provider: 'test:openai', modelId: 'gpt-5' } as never,
          keySelection: { index: 0, count: 1 },
        }
      },
    }
    const gateway = makeGateway({
      async generate() {
        return {
          text: '',
          finishReason: 'stop',
          response: { body: { id: 'resp_1', output: [] } },
        } as GenerateTextReturn
      },
    })
    const app = createApp({ settings, providerRegistry, gateway, logger })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi' }),
    })

    expect(response.status).toBe(200)
    const completed = logs.find((e) => e.msg === 'request completed')
    expect(completed?.keySelection).toEqual({ index: 0, count: 1 })
  })
})

async function* throwingFirstChunk(): AsyncIterable<unknown> {
  throw new Error('first chunk secret')
}

async function* delayedFirstChunk(): AsyncIterable<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 50))
  yield { type: 'text-delta', text: 'late' }
}

/** 首 chunk 立即到达（通过首包检查），第二个 chunk 长时间延迟——用于 streamOnly 收集阶段超时。 */
async function* delayedSecondChunk(): AsyncIterable<unknown> {
  yield { type: 'text-delta', text: 'first' }
  await new Promise((resolve) => setTimeout(resolve, 50))
  yield { type: 'finish', finishReason: 'stop' }
}

async function* breakingAfterFirstChunk(): AsyncIterable<unknown> {
  yield { type: 'text-delta', text: 'first' }
  throw new Error('stream broke after first chunk')
}

async function* textDeltaStream(text: string): AsyncIterable<unknown> {
  const words = text.split(' ')
  for (const word of words) {
    yield { type: 'text-delta', text: word + ' ' }
  }
  yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 0, outputTokens: 5 } }
}
