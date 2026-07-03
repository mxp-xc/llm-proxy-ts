import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { ErrorLogger, getErrorLogFileName } from '../../src/server/error-logger.js'
import type { GenerateTextReturn } from '../../src/server/types.js'
import type { Settings } from '../../src/index.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import { makeGateway } from '../helpers/gateway.js'
import { makeSettings } from '../helpers/settings.js'
import { stubRegistry } from '../helpers/registry.js'

const tmpLogRoot = mkdtempSync(join(tmpdir(), 'hp-branches-'))
afterAll(() => {
  rmSync(tmpLogRoot, { recursive: true, force: true })
})

let dirCounter = 0

interface MakeAppOptions {
  settingsOverrides?: Partial<Omit<Settings, 'providers'>>
  providers?: Settings['providers']
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
    app: createApp({ settings, gateway, providerRegistry: stubRegistry, errorLogger }),
    tmpLogDir,
  }
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

describe('handleProtocolRequest branch matrix — generate path', () => {
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

  it('short-circuits to 429 when a stream-inspection plugin detects a rate-limit error', async () => {
    async function* rateLimitStream(): AsyncIterable<unknown> {
      yield {
        type: 'raw',
        rawValue:
          'data: {"error":{"message":"slow down","code":"rate_limit","type":"rate_limit_error"}}\n\n',
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
          plugins: [
            { name: 'vendor_sse_error', config: { rateLimitCodes: ['rate_limit'] }, providers: [] },
          ],
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
    // rate-limit 短路不是错误，不应落盘错误日志
    expect(readErrors(tmpLogDir)).toHaveLength(0)
  })
})
