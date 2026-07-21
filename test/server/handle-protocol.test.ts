import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { ErrorLogger, getErrorLogFileName } from '../../src/server/error-logger.js'
import type { GenerateTextReturn, ModelGateway } from '../../src/server/types.js'
import type { Settings } from '../../src/index.js'
import { OAuthError } from '../../src/index.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import { openaiCompatibleStrategy } from '../../src/providers/openai-compatible/strategy.js'
import { openaiResponsesStrategy } from '../../src/providers/openai-responses/strategy.js'
import { anthropicStrategy } from '../../src/providers/anthropic/strategy.js'
import type { ProviderRegistry } from '../../src/providers/registry.js'
import type { PipelinePluginRegistry, ResolvedPlugin } from '../../src/plugins/registry.js'
import type { ProxyPlugin } from '../../src/plugins/types.js'
import { makeGateway } from '../helpers/gateway.js'
import { makeSettings } from '../helpers/settings.js'
import { createProviderRegistryStub, stubRegistry } from '../helpers/registry.js'
import type pino from 'pino'
import { noopLogger } from '../../src/types.js'

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
  visionArtifactStore?: NonNullable<Parameters<typeof createApp>[0]['visionArtifactStore']>
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
    logger: opts.logger ?? noopLogger,
  })
  return {
    app: createApp({
      settings,
      gateway,
      providerRegistry: opts.providerRegistry ?? stubRegistry,
      ...(opts.pluginRegistry && { pluginRegistry: opts.pluginRegistry }),
      errorLogger,
      ...(opts.logger && { logger: opts.logger }),
      ...(opts.visionArtifactStore && { visionArtifactStore: opts.visionArtifactStore }),
    }),
    tmpLogDir,
  }
}

function makeTestLogger() {
  const info = vi.fn()
  const error = vi.fn()
  const warn = vi.fn()
  const logger = {
    info,
    warn,
    error,
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as pino.Logger & { child: ReturnType<typeof vi.fn> }
  logger.child.mockReturnValue(logger)
  return { logger, info, error, warn }
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

function streamOnlyProviders(): Settings['providers'] {
  return {
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
  }
}

function aiSdkApiCallError(statusCode: number, message: string): Error {
  const errorBody =
    statusCode === 429
      ? { type: 'rate_limit_error', code: 'rate_limit_exceeded', message }
      : { type: 'upstream_error', code: 'upstream_request_failed', message }
  return Object.assign(new Error(message), {
    name: 'AI_APICallError',
    statusCode,
    responseBody: JSON.stringify({ error: errorBody }),
    responseHeaders: { 'retry-after': '1', 'x-sensitive-header': 'do-not-log' },
    isRetryable: true,
  })
}

function aiSdkRetryError(lastError: Error): Error {
  return Object.assign(new Error('Failed after 3 attempts'), {
    name: 'AI_RetryError',
    lastError,
  })
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
    const { logger, warn } = makeTestLogger()
    const { app } = makeApp(makeGateway(), { logger })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openrouter/chat' }),
    })

    expect(response.status).toBe(400)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.anything(),
        phase: 'validation',
      }),
      'request validation failed',
    )
  })

  it('does not include malformed JSON request content in validation logs', async () => {
    const { logger, warn } = makeTestLogger()
    const { app } = makeApp(makeGateway(), { logger })
    const secret = 'prompt-and-token-must-not-be-logged'

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"model":"openrouter/chat","accessToken":"${secret}"`,
    })

    expect(response.status).toBe(400)
    const validationLog = warn.mock.calls.find(
      ([, message]) => message === 'request validation failed',
    )
    expect(validationLog?.[0]).toMatchObject({
      err: {
        name: 'SyntaxError',
        message: 'Request body is not valid JSON',
        stack: expect.any(String),
      },
      phase: 'validation',
    })
    expect(JSON.stringify(validationLog?.[0])).not.toContain(secret)
  })

  it('returns 400 for malformed Responses tool_search items', async () => {
    const { logger, warn } = makeTestLogger()
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
    expect(warn).toHaveBeenCalledWith(
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

  it('does not leak AI SDK response details from app.onError logs', async () => {
    const sensitiveError = Object.assign(new Error('registry unavailable'), {
      responseBody: '{"token":"response-body-secret"}',
      responseHeaders: { authorization: 'Bearer response-header-secret' },
      headers: { cookie: 'session=header-secret' },
      secret: 'custom-property-secret',
    })
    const providerRegistry: ProviderRegistry = createProviderRegistryStub({
      languageModel() {
        throw sensitiveError
      },
    })
    const { logger, error } = makeTestLogger()
    const { app } = makeApp(makeGateway(), { logger, providerRegistry })

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(500)
    const failedLog = error.mock.calls.find(([, message]) => message === 'request failed')
    expect(failedLog).toBeDefined()
    expect(failedLog?.[0]).toMatchObject({
      err: expect.objectContaining({ name: 'Error', message: 'registry unavailable' }),
    })
    const loggedError = (failedLog?.[0] as { err: Record<string, unknown> }).err
    expect(loggedError).toHaveProperty('responseBodyBytes')
    expect(loggedError).not.toHaveProperty('responseBody')
    expect(loggedError).not.toHaveProperty('responseHeaders')
    expect(loggedError).not.toHaveProperty('headers')
    expect(loggedError).not.toHaveProperty('secret')
    const serializedLog = JSON.stringify(failedLog?.[0])
    expect(serializedLog).not.toContain('response-body-secret')
    expect(serializedLog).not.toContain('header-secret')
    expect(serializedLog).not.toContain('custom-property-secret')
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
    const providerRegistry = createProviderRegistryStub({
      languageModel() {
        return { model: {} as never, keySelection: { index: 1, count: 2 } }
      },
    })
    const { app, tmpLogDir } = makeApp(gateway, { providerRegistry })

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(502)
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.phase).toBe('generate')
    expect(record.response).toBeNull()
    expect(record.error.message).toBe('upstream failed')
    expect(record.keySelection).toEqual({ index: 1, count: 2 })
  })

  it('classifies an AI SDK generate 429 as rate_limited without writing NDJSON', async () => {
    const gateway = makeGateway({
      async generate() {
        throw aiSdkRetryError(aiSdkApiCallError(429, 'generate rate limited'))
      },
    })
    const { logger, info } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest())
    await response.text()

    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({ outcome: 'rate_limited' })
    expect(readErrors(tmpLogDir)).toHaveLength(0)
  })

  it('classifies renderResult failures as internal_error without writing NDJSON', async () => {
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'hello',
          finishReason: 'stop',
          response: {
            timestamp: {
              getTime() {
                throw new Error('renderResult failed')
              },
            },
          },
        } as unknown as GenerateTextReturn
      },
    })
    const { logger, info } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: { type: 'internal_error', code: 'internal_server_error' },
    })
    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({ outcome: 'internal_error' })
    expect(readErrors(tmpLogDir)).toHaveLength(0)
  })

  it('classifies responseHeaders callback failures as internal_error without writing NDJSON', async () => {
    const gateway = makeGateway({
      async generate() {
        return {
          text: '',
          finishReason: 'stop',
          response: {
            id: 'resp_headers_failure',
            body: { id: 'resp_headers_failure', object: 'response', output: [] },
            get headers() {
              throw new Error('responseHeaders failed')
            },
          },
        } as unknown as GenerateTextReturn
      },
    })
    const { logger, info } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, {
      logger,
      providers: {
        openai: {
          type: 'openai',
          baseURL: 'https://api.openai.com/v1',
          apiKey: 'secret',
          headers: {},
          plugins: [],
          models: {
            chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] },
          },
        },
      },
    })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi' }),
    })

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      error: { type: 'internal_error', code: 'internal_server_error' },
    })
    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({ outcome: 'internal_error' })
    expect(readErrors(tmpLogDir)).toHaveLength(0)
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
    expect(records[0]!.error.timeoutMs).toBe(5)
  })

  it('returns 503 with oauth login body when resolving the model requires login', async () => {
    const { logger, warn } = makeTestLogger()
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
    expect(warn).toHaveBeenCalledWith(
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

  it('classifies an AI SDK retry error wrapping OAuth auth_required', async () => {
    const gateway = makeGateway({
      async generate() {
        throw aiSdkRetryError(new OAuthError('auth_required', 'OAuth login required'))
      },
    })
    const { logger, info } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(503)
    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({ outcome: 'auth_required' })
    expect(readErrors(tmpLogDir)).toHaveLength(0)
  })
})

describe('handleProtocolRequest branch matrix — stream path', () => {
  it('does not log a transient AI SDK onError when the stream reaches finish', async () => {
    async function* goodStream(): AsyncIterable<unknown> {
      yield {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: { inputTokens: 0, outputTokens: 0 },
      }
    }
    const lastError = Object.assign(new Error('Upstream request failed'), {
      statusCode: 502,
      responseBody: '{"error":{"type":"upstream_error"}}',
      isRetryable: true,
      requestBodyValues: { input: 'x'.repeat(1_000_000) },
    })
    const retryError = Object.assign(new Error('Failed after 3 attempts'), { lastError })
    const gateway = makeGateway({
      stream(input) {
        input.onError?.(retryError)
        return goodStream() as AsyncIterable<ProxyStreamPart>
      },
    })
    const { logger, error } = makeTestLogger()
    const { app } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))
    await response.text()

    expect(error).not.toHaveBeenCalled()
  })

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

  it('does not write NDJSON when an upstream stream requires OAuth login', async () => {
    const gateway = makeGateway({
      stream() {
        throw new OAuthError('auth_required', 'OAuth login required')
      },
    })
    const { logger, info } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { type: 'auth_required', code: 'oauth_login_needed' },
    })
    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({ outcome: 'auth_required' })
    expect(readErrors(tmpLogDir)).toHaveLength(0)
  })

  it('classifies an AI SDK stream 429 as rate_limited without writing NDJSON', async () => {
    const apiCallError = aiSdkApiCallError(429, 'stream rate limited')
    const retryError = aiSdkRetryError(apiCallError)
    const gateway = makeGateway({
      stream(input) {
        input.onError?.(retryError)
        return (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'error', error: retryError }
        })()
      },
    })
    const { logger, info } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))
    await response.text()

    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({ outcome: 'rate_limited' })
    expect(readErrors(tmpLogDir)).toHaveLength(0)
  })

  it('classifies an AI SDK retry error wrapping AbortError as upstream_aborted', async () => {
    const abortError = Object.assign(new Error('upstream aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    })
    const retryError = aiSdkRetryError(abortError)
    const gateway = makeGateway({
      stream() {
        return (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'error', error: retryError }
        })()
      },
    })
    const { logger, info } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))
    await response.text()

    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({
      outcome: 'upstream_aborted',
      terminalPart: 'abort',
    })
    expect(readErrors(tmpLogDir)).toHaveLength(0)
  })

  it('keeps client cancellation quiet when upstream cleanup rejects with AbortError', async () => {
    let markSecondPullStarted: (() => void) | undefined
    const secondPullStarted = new Promise<void>((resolve) => {
      markSecondPullStarted = resolve
    })
    const abortError = Object.assign(new Error('cleanup aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    })
    const gateway = makeGateway({
      stream(input) {
        const abortSignal = input.abortSignal
        if (!abortSignal) throw new Error('expected request abort signal')
        return (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'text-delta', id: 'txt-1', text: 'partial' }
          markSecondPullStarted?.()
          await new Promise<never>((_resolve, reject) => {
            const rejectOnAbort = () => reject(abortError)
            if (abortSignal.aborted) rejectOnAbort()
            else abortSignal.addEventListener('abort', rejectOnAbort, { once: true })
          })
        })()
      },
    })
    const { logger, info, warn, error } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))
    await secondPullStarted
    await response.body!.cancel('client disconnected')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({ outcome: 'client_cancelled' })
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(readErrors(tmpLogDir)).toHaveLength(0)
  })

  it('lets a real upstream failure override cancellation without duplicate consumption errors', async () => {
    let markSecondPullStarted: (() => void) | undefined
    const secondPullStarted = new Promise<void>((resolve) => {
      markSecondPullStarted = resolve
    })
    const upstreamError = new Error('upstream failed during cancellation')
    const gateway = makeGateway({
      stream(input) {
        const abortSignal = input.abortSignal
        if (!abortSignal) throw new Error('expected request abort signal')
        return (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'text-delta', id: 'txt-1', text: 'partial' }
          markSecondPullStarted?.()
          await new Promise<never>((_resolve, reject) => {
            const rejectOnAbort = () => reject(upstreamError)
            if (abortSignal.aborted) rejectOnAbort()
            else abortSignal.addEventListener('abort', rejectOnAbort, { once: true })
          })
        })()
      },
    })
    const { logger, info, warn, error } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))
    await secondPullStarted
    await response.body!.cancel('client disconnected')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({
      outcome: 'upstream_error',
      terminalPart: 'error',
    })
    expect(warn).not.toHaveBeenCalled()
    expect(
      error.mock.calls.filter(([, message]) => message === 'upstream stream failed'),
    ).toHaveLength(1)
    expect(
      error.mock.calls.filter(([, message]) => message === 'stream response consumption failed'),
    ).toHaveLength(0)
    expect(readErrors(tmpLogDir)).toHaveLength(1)
  })

  it('keeps cancellation quiet when the pending upstream pull ends normally', async () => {
    let markSecondPullStarted: (() => void) | undefined
    const secondPullStarted = new Promise<void>((resolve) => {
      markSecondPullStarted = resolve
    })
    const gateway = makeGateway({
      stream(input) {
        const abortSignal = input.abortSignal
        if (!abortSignal) throw new Error('expected request abort signal')
        return (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'text-delta', id: 'txt-1', text: 'partial' }
          markSecondPullStarted?.()
          await new Promise<void>((resolve) => {
            const resolveOnAbort = () => resolve()
            if (abortSignal.aborted) resolveOnAbort()
            else abortSignal.addEventListener('abort', resolveOnAbort, { once: true })
          })
        })()
      },
    })
    const { logger, info, warn, error } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))
    await secondPullStarted
    await response.body!.cancel('client disconnected')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({ outcome: 'client_cancelled' })
    expect((completed[0]?.[0] as { terminalPart?: unknown }).terminalPart).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(readErrors(tmpLogDir)).toHaveLength(0)
  })

  it('keeps a pending AI SDK stream error as upstream_error when the stream ends at EOF', async () => {
    const retryError = aiSdkRetryError(aiSdkApiCallError(502, 'upstream unavailable'))
    const gateway = makeGateway({
      stream(input) {
        input.onError?.(retryError)
        return (async function* (): AsyncIterable<ProxyStreamPart> {})()
      },
    })
    const { logger, info, error } = makeTestLogger()
    const { app } = makeApp(gateway, { logger })

    const response = await app.request('/v1/chat/completions', chatRequest({ stream: true }))
    await response.text()

    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({ outcome: 'upstream_error' })
    const failedLog = error.mock.calls.find(([, message]) => message === 'upstream stream failed')
    expect(failedLog?.[0]).toMatchObject({
      err: expect.objectContaining({
        name: 'AI_RetryError',
        message: 'Failed after 3 attempts',
        statusCode: 502,
      }),
    })
    const loggedError = (failedLog?.[0] as { err: Record<string, unknown> }).err
    expect(loggedError).toHaveProperty('responseBodyBytes')
    expect(loggedError).toHaveProperty('stack')
    expect(loggedError).not.toHaveProperty('responseBody')
    expect(loggedError).not.toHaveProperty('responseHeaders')
    expect(JSON.stringify(failedLog?.[0])).not.toContain('upstream unavailable')
    expect(JSON.stringify(failedLog?.[0])).not.toContain('do-not-log')
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
    const record = records.find((r) => r.phase === 'stream' && r.error.name === 'PluginHookError')
    expect(record).toBeDefined()
    expect(record!.error.message).toContain("Plugin 'test-stream-inspector' hook")
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
    const { logger, info } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(gateway, { logger })

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
    const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.[0]).toMatchObject({ outcome: 'upstream_error' })
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
    const record = records.find((r) => r.phase === 'stream' && r.error.name === 'PluginHookError')
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
    const { app, tmpLogDir } = makeApp(gateway, { providers: streamOnlyProviders() })

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(502)
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.phase).toBe('stream-only')
    expect(records[0]!.error.message).toBe('streamOnly broke')
    expect(records[0]!.response).toEqual([{ type: 'text-delta', id: 'txt-1', text: 'partial' }])
  })

  it.each([
    {
      terminal: 'error',
      stream: () =>
        (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'error', error: new Error('in-band failure') }
        })(),
      status: 502,
      outcome: 'upstream_error',
      terminalPart: 'error',
      warnCount: 0,
      errorCount: 1,
      ndjsonCount: 1,
    },
    {
      terminal: 'openai-error',
      stream: () =>
        (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'openai-error', body: {}, status: 429 }
        })(),
      status: 429,
      outcome: 'rate_limited',
      terminalPart: 'error',
      warnCount: 1,
      errorCount: 0,
      ndjsonCount: 0,
    },
    {
      terminal: 'abort',
      stream: () =>
        (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'abort', reason: 'upstream closed' }
        })(),
      status: 502,
      outcome: 'upstream_aborted',
      terminalPart: 'abort',
      warnCount: 1,
      errorCount: 0,
      ndjsonCount: 0,
    },
    {
      terminal: 'EOF',
      stream: () =>
        (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'text-delta', id: 'txt-1', text: 'partial' }
        })(),
      status: 502,
      outcome: 'incomplete_stream',
      terminalPart: 'eof',
      warnCount: 1,
      errorCount: 0,
      ndjsonCount: 1,
    },
  ])(
    'does not render a successful streamOnly response after $terminal',
    async ({ stream, status, outcome, terminalPart, warnCount, errorCount, ndjsonCount }) => {
      const gateway = makeGateway({ stream })
      const { logger, info, warn, error } = makeTestLogger()
      const { app, tmpLogDir } = makeApp(gateway, {
        logger,
        providers: streamOnlyProviders(),
      })

      const response = await app.request('/v1/chat/completions', chatRequest())

      expect(response.status).toBe(status)
      const completed = info.mock.calls.filter(([, message]) => message === 'request.completed')
      expect(completed).toHaveLength(1)
      expect(completed[0]?.[0]).toMatchObject({ outcome, terminalPart })
      expect(warn).toHaveBeenCalledTimes(warnCount)
      expect(error).toHaveBeenCalledTimes(errorCount)
      expect(readErrors(tmpLogDir)).toHaveLength(ndjsonCount)
    },
  )
})

function visionDisabledProviders(): Settings['providers'] {
  return {
    openrouter: {
      type: 'openai-compatible',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'secret',
      headers: {},
      plugins: [],
      options: { supports_vision: false },
      models: {
        chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] },
      },
    },
  }
}

function successfulGenerateResult(): GenerateTextReturn {
  return {
    text: 'ok',
    finishReason: 'stop',
    response: { id: 'vision-test' },
  } as GenerateTextReturn
}

function visionLogPayloads(info: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return info.mock.calls
    .map(([payload]) => payload)
    .filter(
      (payload): payload is Record<string, unknown> =>
        typeof payload === 'object' &&
        payload !== null &&
        payload.event === 'vision_input_filtered',
    )
}

describe('handleProtocolRequest vision input filtering', () => {
  it('forwards filtered Chat input and emits one safe summary log', async () => {
    const sensitiveImage = 'data:image/png;base64,vision-secret-base64'
    const sensitivePath = '<image path="C:\\secret\\capture.png">'
    const accidentalChangeField = 'must-not-leak-from-transform-change'
    const originalApply = openaiCompatibleStrategy.applyUnsupportedVisionInput
    const filter = vi
      .spyOn(openaiCompatibleStrategy, 'applyUnsupportedVisionInput')
      .mockImplementation((plan, replacements) => {
        const result = originalApply(plan, replacements)
        return {
          ...result,
          changes: result.changes.map((change) => ({
            ...change,
            accidentalSensitiveField: accidentalChangeField,
          })),
        }
      })
    const generate = vi.fn(async (_input: Parameters<ModelGateway['generate']>[0]) =>
      successfulGenerateResult(),
    )
    const languageModel = vi.fn(() => ({ model: {} as never }))
    const { logger, info } = makeTestLogger()
    const { app } = makeApp(makeGateway({ generate }), {
      providers: visionDisabledProviders(),
      providerRegistry: createProviderRegistryStub({ languageModel }),
      logger,
    })

    try {
      const response = await app.request(
        '/v1/chat/completions',
        chatRequest({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: sensitivePath },
                { type: 'image_url', image_url: { url: sensitiveImage } },
                { type: 'text', text: '</image>' },
              ],
            },
          ],
        }),
      )

      expect(response.status).toBe(200)
      expect(languageModel).toHaveBeenCalledOnce()
      expect(generate).toHaveBeenCalledOnce()
      expect(generate.mock.calls[0]?.[0].callInput.messages[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: sensitivePath },
          { type: 'text', text: '</image>' },
        ],
      })

      const logs = visionLogPayloads(info)
      expect(logs).toEqual([
        expect.objectContaining({
          protocol: 'openai-chat-completions',
          provider: 'openrouter',
          requestedModel: 'openrouter/chat',
          actualModel: 'openrouter/chat',
          supportsVision: false,
          outcome: 'forwarded',
          removedImageCount: 1,
          affectedMessageCount: 1,
          fallbackNoticeCount: 0,
          storedArtifactCount: 0,
          unavailableArtifactCount: 0,
          changes: [
            {
              action: 'remove_image',
              path: '/messages/0/content/1',
              role: 'user',
              blockType: 'image_url',
            },
          ],
        }),
      ])
      const serializedLog = JSON.stringify(logs)
      expect(serializedLog).not.toContain(sensitiveImage)
      expect(serializedLog).not.toContain(sensitivePath)
      expect(serializedLog).not.toContain(accidentalChangeField)
    } finally {
      filter.mockRestore()
    }
  })

  it('uses the selected alias model vision override', async () => {
    const generate = vi.fn(async () => successfulGenerateResult())
    const languageModel = vi.fn(() => ({ model: {} as never }))
    const providers: Settings['providers'] = {
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        options: { supports_vision: true },
        models: {
          chat: {
            upstreamModel: 'openrouter/chat',
            aliases: [{ name: 'text-only', flat: false }],
            supports_vision: false,
            headers: {},
            plugins: [],
          },
        },
      },
    }
    const { app } = makeApp(makeGateway({ generate }), {
      providers,
      providerRegistry: createProviderRegistryStub({ languageModel }),
    })

    const response = await app.request(
      '/v1/chat/completions',
      chatRequest({
        model: 'openrouter/text-only',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }],
          },
        ],
      }),
    )

    expect(response.status).toBe(400)
    expect(languageModel).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'Chat Completions',
      path: '/v1/chat/completions',
      candidatePath: '/messages/0/content/0',
      body: {
        model: 'openrouter/chat',
        messages: [
          {
            role: 'tool',
            tool_call_id: 'call-chat',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,tool-secret-chat' },
              },
            ],
          },
        ],
      },
    },
    {
      name: 'OpenAI Responses',
      path: '/v1/responses',
      candidatePath: '/input/0/output/0',
      body: {
        model: 'openrouter/chat',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call-responses',
            output: [
              {
                type: 'input_image',
                image_url: 'data:image/png;base64,tool-secret-responses',
              },
            ],
          },
        ],
      },
    },
    {
      name: 'Anthropic Messages',
      path: '/v1/messages',
      candidatePath: '/messages/0/content/0/content/0',
      body: {
        model: 'openrouter/chat',
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-anthropic',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: 'tool-secret-anthropic',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  ])(
    'replaces image-only $name tool results with a stored-artifact notice',
    async ({ path, body, candidatePath }) => {
      const generate = vi.fn(async (_input: Parameters<ModelGateway['generate']>[0]) =>
        successfulGenerateResult(),
      )
      const languageModel = vi.fn(() => ({ model: {} as never }))
      const persistBatch = vi.fn(async (candidates: readonly { path: string }[]) => ({
        results: new Map(
          candidates.map((candidate) => [
            candidate.path,
            {
              path: candidate.path,
              status: 'stored' as const,
              artifactId: 'artifact-sensitive-id',
              agentVisiblePath: '/shared/vision-safe.png',
            },
          ]),
        ),
        errors: [],
      }))
      const { logger, info } = makeTestLogger()
      const { app } = makeApp(makeGateway({ generate }), {
        providers: visionDisabledProviders(),
        providerRegistry: createProviderRegistryStub({ languageModel }),
        visionArtifactStore: { persistBatch },
        logger,
      })

      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

      expect(response.status).toBe(200)
      expect(persistBatch).toHaveBeenCalledOnce()
      expect(persistBatch.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ path: candidatePath }),
      ])
      expect(generate).toHaveBeenCalledOnce()
      const forwarded = JSON.stringify(generate.mock.calls[0]?.[0].callInput)
      expect(forwarded).toContain('[llm-proxy-ts vision fallback]')
      expect(forwarded).toContain('/shared/vision-safe.png')
      expect(forwarded).not.toContain('tool-secret-')

      const logs = visionLogPayloads(info)
      expect(logs).toEqual([
        expect.objectContaining({
          outcome: 'forwarded',
          removedImageCount: 0,
          fallbackNoticeCount: 1,
          storedArtifactCount: 1,
          unavailableArtifactCount: 0,
          changes: [
            expect.objectContaining({
              action: 'replace_tool_result_image',
              path: candidatePath,
              artifactStatus: 'stored',
            }),
          ],
        }),
      ])
      const serializedLogs = JSON.stringify(logs)
      expect(serializedLogs).not.toContain('artifact-sensitive-id')
      expect(serializedLogs).not.toContain('/shared/vision-safe.png')
      expect(serializedLogs).not.toContain('[llm-proxy-ts vision fallback]')
    },
  )

  it('continues with an unavailable notice and logs the full artifact write error', async () => {
    const writeError = Object.assign(new Error('artifact disk failed'), { code: 'EACCES' })
    const persistBatch = vi.fn(async (candidates: readonly { path: string }[]) => ({
      results: new Map(
        candidates.map((candidate) => [
          candidate.path,
          {
            path: candidate.path,
            status: 'unavailable' as const,
            reason: 'storage_error' as const,
          },
        ]),
      ),
      errors: [{ phase: 'vision_artifact_persist' as const, err: writeError }],
    }))
    const generate = vi.fn(async (_input: Parameters<ModelGateway['generate']>[0]) =>
      successfulGenerateResult(),
    )
    const { logger, info, error } = makeTestLogger()
    const { app } = makeApp(makeGateway({ generate }), {
      providers: visionDisabledProviders(),
      visionArtifactStore: { persistBatch },
      logger,
    })

    const response = await app.request(
      '/v1/chat/completions',
      chatRequest({
        messages: [
          {
            role: 'tool',
            tool_call_id: 'call-write-failure',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,write-failure-secret' },
              },
            ],
          },
        ],
      }),
    )

    expect(response.status).toBe(200)
    const forwarded = JSON.stringify(generate.mock.calls[0]?.[0].callInput)
    expect(forwarded).toContain('No artifact path is available')
    expect(forwarded).not.toContain('write-failure-secret')
    expect(visionLogPayloads(info)).toEqual([
      expect.objectContaining({
        fallbackNoticeCount: 1,
        storedArtifactCount: 0,
        unavailableArtifactCount: 1,
        unavailableReasonCounts: { storage_error: 1 },
      }),
    ])
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'vision_artifact_persistence_failed',
        phase: 'vision_artifact_persist',
        err: writeError,
      }),
      'vision artifact persistence failed',
    )
  })

  it.each([
    {
      name: 'Chat Completions',
      path: '/v1/chat/completions',
      body: {
        model: 'openrouter/chat',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,rejected-chat-secret' },
              },
            ],
          },
        ],
      },
      expectedBody: {
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_vision_input',
          message: 'Vision input is not supported by the selected model',
        },
      },
    },
    {
      name: 'OpenAI Responses',
      path: '/v1/responses',
      body: {
        model: 'openrouter/chat',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_image',
                image_url: 'data:image/png;base64,rejected-responses-secret',
              },
            ],
          },
        ],
      },
      expectedBody: {
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_vision_input',
          message: 'Vision input is not supported by the selected model',
        },
      },
    },
    {
      name: 'Anthropic Messages',
      path: '/v1/messages',
      body: {
        model: 'openrouter/chat',
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'rejected-anthropic-secret',
                },
              },
            ],
          },
        ],
      },
      expectedBody: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_vision_input',
          message: 'Vision input is not supported by the selected model',
        },
      },
    },
  ])(
    'rejects image-only $name input before resolving a provider model',
    async ({ path, body, expectedBody }) => {
      const generate = vi.fn(async () => successfulGenerateResult())
      const stream = vi.fn()
      const languageModel = vi.fn(() => ({ model: {} as never }))
      const persistBatch = vi.fn()
      const { logger, info } = makeTestLogger()
      const { app } = makeApp(makeGateway({ generate, stream }), {
        providers: visionDisabledProviders(),
        providerRegistry: createProviderRegistryStub({ languageModel }),
        visionArtifactStore: { persistBatch },
        logger,
      })

      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual(expectedBody)
      expect(languageModel).not.toHaveBeenCalled()
      expect(generate).not.toHaveBeenCalled()
      expect(stream).not.toHaveBeenCalled()
      expect(persistBatch).not.toHaveBeenCalled()
      expect(visionLogPayloads(info)).toEqual([
        expect.objectContaining({ outcome: 'rejected', removedImageCount: 1 }),
      ])
    },
  )

  it('does not emit a vision mutation log when no image is present', async () => {
    const generate = vi.fn(async () => successfulGenerateResult())
    const { logger, info } = makeTestLogger()
    const { app } = makeApp(makeGateway({ generate }), {
      providers: visionDisabledProviders(),
      logger,
    })

    const response = await app.request('/v1/chat/completions', chatRequest())

    expect(response.status).toBe(200)
    expect(generate).toHaveBeenCalledOnce()
    expect(visionLogPayloads(info)).toEqual([])
  })

  it('returns a protocol-safe 500 when filtered Chat input fails revalidation', async () => {
    const originalValidate = openaiCompatibleStrategy.validate
    const validationError = Object.assign(new Error('filtered Chat request is invalid'), {
      issues: [{ path: ['messages', 0, 'content'], message: 'synthetic test failure' }],
    })
    const validate = vi
      .spyOn(openaiCompatibleStrategy, 'validate')
      .mockImplementationOnce((body) => originalValidate(body))
      .mockImplementationOnce(() => {
        throw validationError
      })
    const generate = vi.fn(async () => successfulGenerateResult())
    const languageModel = vi.fn(() => ({ model: {} as never }))
    const { logger, info, error } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(makeGateway({ generate }), {
      providers: visionDisabledProviders(),
      providerRegistry: createProviderRegistryStub({ languageModel }),
      settingsOverrides: { errorLogging: { enabled: true, maxBodyLength: 1024 } },
      logger,
    })

    try {
      const response = await app.request(
        '/v1/chat/completions',
        chatRequest({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'keep me' },
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/png;base64,internal-secret' },
                },
              ],
            },
          ],
        }),
      )

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: {
          type: 'internal_error',
          code: 'internal_server_error',
          message: 'Internal server error',
        },
      })
      expect(languageModel).not.toHaveBeenCalled()
      expect(generate).not.toHaveBeenCalled()
      expect(readErrors(tmpLogDir)).toEqual([])
      expect(visionLogPayloads(info)).toEqual([
        expect.objectContaining({ outcome: 'internal_error' }),
      ])
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'vision_transform_validation_failed',
          phase: 'vision-transform-validation',
          err: validationError,
          issues: validationError.issues,
          protocol: 'openai-chat-completions',
        }),
        'vision-transformed request validation failed',
      )
    } finally {
      validate.mockRestore()
    }
  })

  it('returns an OpenAI 500 before Responses prepareExecution when revalidation fails', async () => {
    const originalValidate = openaiResponsesStrategy.validate
    const validationError = Object.assign(new Error('filtered Responses request is invalid'), {
      issues: [{ path: ['input', 0, 'content'], message: 'synthetic test failure' }],
    })
    const validate = vi
      .spyOn(openaiResponsesStrategy, 'validate')
      .mockImplementationOnce((body) => originalValidate(body))
      .mockImplementationOnce(() => {
        throw validationError
      })
    const prepareExecution = vi.spyOn(openaiResponsesStrategy, 'prepareExecution')
    const generate = vi.fn(async () => successfulGenerateResult())
    const languageModel = vi.fn(() => ({ model: {} as never }))
    const { logger, info, error } = makeTestLogger()
    const { app, tmpLogDir } = makeApp(makeGateway({ generate }), {
      providers: visionDisabledProviders(),
      providerRegistry: createProviderRegistryStub({ languageModel }),
      settingsOverrides: { errorLogging: { enabled: true, maxBodyLength: 1024 } },
      logger,
    })

    try {
      const response = await app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/chat',
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'keep me' },
                { type: 'input_image', image_url: 'data:image/png;base64,internal-secret' },
              ],
            },
          ],
        }),
      })

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: {
          type: 'internal_error',
          code: 'internal_server_error',
          message: 'Internal server error',
        },
      })
      expect(prepareExecution).not.toHaveBeenCalled()
      expect(languageModel).not.toHaveBeenCalled()
      expect(generate).not.toHaveBeenCalled()
      expect(readErrors(tmpLogDir)).toEqual([])
      expect(visionLogPayloads(info)).toEqual([
        expect.objectContaining({ outcome: 'internal_error' }),
      ])
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'vision_transform_validation_failed',
          err: validationError,
          protocol: 'openai-responses',
        }),
        'vision-transformed request validation failed',
      )
    } finally {
      validate.mockRestore()
      prepareExecution.mockRestore()
    }
  })

  it('returns an Anthropic 500 when filtered Messages input fails revalidation', async () => {
    const originalValidate = anthropicStrategy.validate
    const validationError = Object.assign(new Error('filtered Anthropic request is invalid'), {
      issues: [{ path: ['messages', 0, 'content'], message: 'synthetic test failure' }],
    })
    const validate = vi
      .spyOn(anthropicStrategy, 'validate')
      .mockImplementationOnce((body) => originalValidate(body))
      .mockImplementationOnce(() => {
        throw validationError
      })
    const generate = vi.fn(async () => successfulGenerateResult())
    const languageModel = vi.fn(() => ({ model: {} as never }))
    const { logger, info, error } = makeTestLogger()
    const { app } = makeApp(makeGateway({ generate }), {
      providers: visionDisabledProviders(),
      providerRegistry: createProviderRegistryStub({ languageModel }),
      logger,
    })

    try {
      const response = await app.request('/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'openrouter/chat',
          max_tokens: 16,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'keep me' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'internal-secret' },
                },
              ],
            },
          ],
        }),
      })

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        type: 'error',
        error: { type: 'api_error', message: 'Internal server error' },
      })
      expect(languageModel).not.toHaveBeenCalled()
      expect(generate).not.toHaveBeenCalled()
      expect(visionLogPayloads(info)).toEqual([
        expect.objectContaining({ outcome: 'internal_error' }),
      ])
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'vision_transform_validation_failed',
          err: validationError,
          protocol: 'anthropic-messages',
        }),
        'vision-transformed request validation failed',
      )
    } finally {
      validate.mockRestore()
    }
  })
})
