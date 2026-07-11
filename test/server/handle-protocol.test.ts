import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { ErrorLogger, getErrorLogFileName } from '../../src/server/error-logger.js'
import type { GenerateTextReturn } from '../../src/server/types.js'
import type { Settings } from '../../src/index.js'
import { OAuthError } from '../../src/index.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import type { ProviderRegistry } from '../../src/providers/registry.js'
import type { PipelinePluginRegistry, ResolvedPlugin } from '../../src/plugins/registry.js'
import type { ProxyPlugin } from '../../src/plugins/types.js'
import { makeGateway } from '../helpers/gateway.js'
import { makeSettings } from '../helpers/settings.js'
import { createProviderRegistryStub, stubRegistry } from '../helpers/registry.js'
import type pino from 'pino'

const tmpLogRoot = mkdtempSync(join(tmpdir(), 'hp-branches-'))
afterAll(() => {
  rmSync(tmpLogRoot, { recursive: true, force: true })
})

let dirCounter = 0

interface MakeAppOptions {
  settingsOverrides?: Partial<Omit<Settings, 'providers'>>
  providers?: Settings['providers']
  providerRegistry?: ProviderRegistry
  pluginRegistry?: PipelinePluginRegistry
  logger?: pino.Logger
}

/**
 * 每个用例独立子目录 + 独立 ErrorLogger，复用 error-logging-integration.test.ts 的模式。
 * 默认 provider 配置与任务模板一致；rate-limit 用例通过 providers 覆盖注入 vendor_sse_error 插件。
 */
function makeApp(gateway: ReturnType<typeof makeGateway>, opts: MakeAppOptions = {}) {
  const tmpLogDir = join(tmpLogRoot, `t${dirCounter++}`)
  const providers =
    opts.providers ??
    ({
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: {
          chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] },
        },
      },
    } satisfies Settings['providers'])
  const settings = makeSettings(providers, { requestTimeoutMs: 30000, ...opts.settingsOverrides })
  const errorLogger = new ErrorLogger({
    logDir: tmpLogDir,
    enabled: settings.errorLogging.enabled,
    maxBodyLength: settings.errorLogging.maxBodyLength,
  })
  return {
    app: createApp({
      settings,
      gateway,
      providerRegistry: opts.providerRegistry ?? stubRegistry,
      ...(opts.pluginRegistry && { pluginRegistry: opts.pluginRegistry }),
      errorLogger,
      ...(opts.logger && { logger: opts.logger }),
    }),
    tmpLogDir,
  }
}

function makeTestLogger() {
  const error = vi.fn()
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error,
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger & { child: ReturnType<typeof vi.fn> }
  logger.child.mockReturnValue(logger)
  return { logger, error }
}

function readErrors(tmpLogDir: string): any[] {
  try {
    const raw = readFileSync(join(tmpLogDir, getErrorLogFileName()), 'utf8').trim()
    return raw ? raw.split('\n').map((l) => JSON.parse(l)) : []
  } catch {
    return []
  }
}

function chatRequest(extra: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'openrouter/chat',
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    }),
  }
}

function makeStreamInspectRegistry(
  inspectStreamChunk: NonNullable<ProxyPlugin['inspectStreamChunk']>,
): PipelinePluginRegistry {
  const plugin: ProxyPlugin = {
    name: 'test-stream-inspector',
    inspectStreamChunk,
  }
  const resolved: ResolvedPlugin = {
    plugin,
    config: {},
    providers: [],
  }

  return {
    getPipelinePlugins() {
      return [resolved]
    },
  }
}

describe('handleProtocolRequest branch matrix — generate path', () => {
  it('returns 400 and logs full validation errors when request validation fails', async () => {
    const { logger, error } = makeTestLogger()
    const { app } = makeApp(makeGateway(), { logger })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openrouter/chat' }),
    })

    expect(response.status).toBe(400)
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.anything(),
        phase: 'validation',
      }),
      'request validation failed',
    )
  })

  it('returns 400 for malformed Responses tool_search items', async () => {
    const { logger, error } = makeTestLogger()
    const { app } = makeApp(makeGateway(), { logger })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        input: [{ type: 'tool_search_call', arguments: { query: 'browser' } }],
      }),
    })

    expect(response.status).toBe(400)
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.anything(),
        phase: 'validation',
      }),
      'request validation failed',
    )
  })

  it('returns safe 500 and logs full context when model resolution throws an unknown error', async () => {
    const { logger, error } = makeTestLogger()
    const providerRegistry: ProviderRegistry = createProviderRegistryStub({
      languageModel() {
        throw new Error('secret registry failure')
      },
    })
    const { app } = makeApp(makeGateway(), { logger, providerRegistry })

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: {
        type: 'internal_error',
        code: 'internal_server_error',
        message: 'Internal server error',
      },
    })
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: 'secret registry failure' }),
        provider: 'openrouter',
        requestedModel: 'openrouter/chat',
        actualModel: 'openrouter/chat',
      }),
      'request failed',
    )
  })

  it('returns 200 with rendered message for a successful non-streaming generate', async () => {
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'hello',
          finishReason: 'stop',
          response: { id: 'test-1' },
        } as GenerateTextReturn
      },
    })
    const { app } = makeApp(gateway)

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.choices[0].message.content).toBe('hello')
    expect(body.id).toBe('test-1')
    expect(body.choices[0].finish_reason).toBe('stop')
  })

  it('returns 502 and logs a generate-phase error with null response when generate throws', async () => {
    const gateway = makeGateway({
      async generate() {
        throw new Error('upstream failed')
      },
    })
    const { app, tmpLogDir } = makeApp(gateway)

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(502)
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.phase).toBe('generate')
    expect(record.response).toBeNull()
    expect(record.error.message).toBe('upstream failed')
  })

  it('returns 504 and logs RequestTimeoutError when generate exceeds requestTimeoutMs', async () => {
    const gateway = makeGateway({
      async generate() {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('late')
      },
    })
    const { app, tmpLogDir } = makeApp(gateway, { settingsOverrides: { requestTimeoutMs: 5 } })

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(504)
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.error.name).toBe('RequestTimeoutError')
  })

  it('returns 503 with oauth login body when resolving the model requires login', async () => {
    const { logger, error } = makeTestLogger()
    const providerRegistry: ProviderRegistry = createProviderRegistryStub({
      languageModel() {
        throw new OAuthError('auth_required', 'OAuth login required')
      },
    })
    const { app } = makeApp(makeGateway(), { providerRegistry, logger })

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error).toMatchObject({
      type: 'auth_required',
      code: 'oauth_login_needed',
      message: 'OAuth login required',
    })
    expect(body.error.loginUrl).toContain('/oauth/login/openrouter')
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(OAuthError),
        phase: 'resolve-model',
        provider: 'openrouter',
        requestedModel: 'openrouter/chat',
        actualModel: 'openrouter/chat',
      }),
      'model resolution failed',
    )
  })

  it('returns 503 with oauth login body when upstream generate requires login', async () => {
    const gateway = makeGateway({
      async generate() {
        throw new OAuthError('auth_required', 'OAuth login required')
      },
    })
    const { app } = makeApp(gateway)

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error).toMatchObject({
      type: 'auth_required',
      code: 'oauth_login_needed',
      message: 'OAuth login required',
    })
    expect(body.error.loginUrl).toContain('/oauth/login/openrouter')
  })
})

describe('handleProtocolRequest branch matrix — stream path', () => {
  it('returns 200 text/event-stream for a healthy stream', async () => {
    async function* goodStream(): AsyncIterable<unknown> {
      yield { type: 'text-delta', id: 'txt-1', text: 'hello' }
      yield {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: { inputTokens: 0, outputTokens: 1 },
      }
    }
    const gateway = makeGateway({
      stream: () => goodStream() as AsyncIterable<ProxyStreamPart>,
    })
    const { app } = makeApp(gateway)

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = await response.text()
    expect(body).toContain('"content":"hello"')
  })

  it('returns 502 and logs a stream-phase error with empty response array when acquireStream throws', async () => {
    const gateway = makeGateway({
      stream() {
        throw new Error('connection refused')
      },
    })
    const { app, tmpLogDir } = makeApp(gateway)

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))

    expect(response.status).toBe(502)
    const records = readErrors(tmpLogDir)
    const record = records.find(
      (r) => r.phase === 'stream' && r.error.message === 'connection refused',
    )
    expect(record).toBeDefined()
    expect(record!.response).toEqual([])
  })

  it('returns 502, logs, and closes upstream stream when first-chunk inspection throws', async () => {
    let streamReturned = false
    async function* inspectedStream(): AsyncIterable<unknown> {
      try {
        yield { type: 'text-delta', id: 'txt-1', text: 'first' }
      } finally {
        streamReturned = true
      }
    }
    const gateway = makeGateway({
      stream: () => inspectedStream() as AsyncIterable<ProxyStreamPart>,
    })
    const pluginRegistry = makeStreamInspectRegistry(async () => {
      throw new Error('inspect first boom')
    })
    const { app, tmpLogDir } = makeApp(gateway, { pluginRegistry })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))

    expect(response.status).toBe(502)
    expect(streamReturned).toBe(true)
    const records = readErrors(tmpLogDir)
    const record = records.find(
      (r) => r.phase === 'stream' && r.error.message === 'inspect first boom',
    )
    expect(record).toBeDefined()
    expect(record!.response).toEqual([])
  })

  it('returns 200 (headers already sent) and logs buffered chunks when the stream errors mid-flight', async () => {
    async function* breakingStream(): AsyncIterable<unknown> {
      yield { type: 'text-delta', id: 'txt-1', text: 'partial ' }
      yield { type: 'text-delta', id: 'txt-1', text: 'response' }
      throw new Error('stream broke')
    }
    const gateway = makeGateway({
      stream: () => breakingStream() as AsyncIterable<ProxyStreamPart>,
    })
    const { app, tmpLogDir } = makeApp(gateway)

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))

    expect(response.status).toBe(200)
    await response.text().catch(() => {})
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.phase).toBe('stream')
    expect(record.error.message).toBe('stream broke')
    expect(Array.isArray(record.response)).toBe(true)
    expect((record.response as unknown[]).length).toBe(2)
  })

  it('logs buffered chunks and closes upstream stream when later inspection throws', async () => {
    let streamReturned = false
    async function* inspectedStream(): AsyncIterable<unknown> {
      try {
        yield { type: 'text-delta', id: 'txt-1', text: 'first' }
        yield { type: 'text-delta', id: 'txt-1', text: 'second' }
      } finally {
        streamReturned = true
      }
    }
    const gateway = makeGateway({
      stream: () => inspectedStream() as AsyncIterable<ProxyStreamPart>,
    })
    const pluginRegistry = makeStreamInspectRegistry(async ({ chunk }) => {
      const part = chunk as ProxyStreamPart
      if (part.type === 'text-delta' && part.text === 'second') {
        throw new Error('inspect later boom')
      }
    })
    const { app, tmpLogDir } = makeApp(gateway, { pluginRegistry })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))

    expect(response.status).toBe(200)
    await response.text().catch(() => undefined)
    expect(streamReturned).toBe(true)
    const records = readErrors(tmpLogDir)
    const record = records.find(
      (r) => r.phase === 'stream' && r.error.message === 'inspect later boom',
    )
    expect(record).toBeDefined()
    expect(record!.response).toEqual([{ type: 'text-delta', id: 'txt-1', text: 'first' }])
  })

  it('bounds buffered stream error previews by maxBodyLength', async () => {
    async function* breakingStream(): AsyncIterable<unknown> {
      for (let i = 0; i < 20; i += 1) {
        yield { type: 'text-delta', id: 'txt-1', text: `chunk-${i}-${'x'.repeat(20)}` }
      }
      throw new Error('stream broke after many chunks')
    }
    const gateway = makeGateway({
      stream: () => breakingStream() as AsyncIterable<ProxyStreamPart>,
    })
    const { app, tmpLogDir } = makeApp(gateway, {
      settingsOverrides: { errorLogging: { enabled: true, maxBodyLength: 600 } },
    })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))

    expect(response.status).toBe(200)
    await response.text().catch(() => {})
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    const responsePreview = records[0]!.response as unknown[]
    expect(responsePreview.length).toBeLessThan(20)
    expect(responsePreview).toContainEqual({
      _truncated: true,
      reason: 'stream error preview exceeded maxBodyLength',
    })
  })

  it('short-circuits to 429 when a stream-inspection plugin detects a rate-limit error', async () => {
    let streamReturned = false
    async function* rateLimitStream(): AsyncIterable<unknown> {
      try {
        yield {
          type: 'raw',
          rawValue:
            'data: {"error":{"message":"slow down","code":"rate_limit","type":"rate_limit_error"}}\n\n',
        }
      } finally {
        streamReturned = true
      }
    }
    const gateway = makeGateway({
      stream() {
        return rateLimitStream() as AsyncIterable<ProxyStreamPart>
      },
    })
    const { app, tmpLogDir } = makeApp(gateway, {
      providers: {
        openrouter: {
          type: 'openai-compatible',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'secret',
          headers: {},
          plugins: [{ name: 'vendor_sse_error', config: { rateLimitCodes: ['rate_limit'] } }],
          models: {
            chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] },
          },
        },
      },
    })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))

    expect(response.status).toBe(429)
    const body = await response.json()
    expect(body.error.code).toBe('rate_limit')
    expect(streamReturned).toBe(true)
    // rate-limit 短路不是错误，不应落盘错误日志
    expect(readErrors(tmpLogDir)).toHaveLength(0)
  })

  it('collects streamOnly output and logs buffered chunks when collection fails', async () => {
    async function* breakingStream(): AsyncIterable<unknown> {
      yield { type: 'text-delta', id: 'txt-1', text: 'partial' }
      throw new Error('streamOnly broke')
    }
    const gateway = makeGateway({
      stream: () => breakingStream() as AsyncIterable<ProxyStreamPart>,
    })
    const { app, tmpLogDir } = makeApp(gateway, {
      providers: {
        openrouter: {
          type: 'openai-compatible',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'secret',
          headers: {},
          plugins: [],
          options: { streamOnly: true },
          models: {
            chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] },
          },
        },
      },
    })

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(502)
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.phase).toBe('stream-only')
    expect(records[0]!.error.message).toBe('streamOnly broke')
    expect(records[0]!.response).toEqual([{ type: 'text-delta', id: 'txt-1', text: 'partial' }])
  })
})
