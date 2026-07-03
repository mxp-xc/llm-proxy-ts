import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { ErrorLogger, getErrorLogFileName } from '../../src/server/error-logger.js'
import type { Settings } from '../../src/index.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import { makeGateway } from '../helpers/gateway.js'
import { makeSettings } from '../helpers/settings.js'
import { stubRegistry } from '../helpers/registry.js'

const tmpLogRoot = mkdtempSync(join(tmpdir(), 'errint-'))
afterAll(() => {
  rmSync(tmpLogRoot, { recursive: true, force: true })
})

let dirCounter = 0
function makeAppWithErrors(
  gateway: ReturnType<typeof makeGateway>,
  settingsOverrides?: Partial<Settings>,
) {
  // 每次调用用独立子目录，避免测试间共享错误日志文件导致计数断言失败
  const tmpLogDir = join(tmpLogRoot, `t${dirCounter++}`)
  const settings = makeSettings(
    {
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
    },
    { requestTimeoutMs: 30000, ...settingsOverrides },
  )
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

describe('error logging integration', () => {
  it('logs request + null response when non-streaming generate fails', async () => {
    const gateway = makeGateway({
      async generate() {
        throw new Error('upstream generate failed')
      },
    })
    const { app, tmpLogDir } = makeAppWithErrors(gateway)

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(502)
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.phase).toBe('generate')
    expect(record.error.message).toBe('upstream generate failed')
    expect(record.error.stack).toContain('upstream generate failed')
    expect(record.response).toBeNull()
    expect((record.request as any).model).toBe('openrouter/chat')
  })
})

describe('error logging integration — streaming', () => {
  it('logs buffered chunks when stream errors mid-flight', async () => {
    const emittedChunks: ProxyStreamPart[] = [
      { type: 'text-delta', id: 'txt-1', text: 'partial ' },
      { type: 'text-delta', id: 'txt-1', text: 'response' },
    ]
    async function* errorStream(): AsyncIterable<ProxyStreamPart> {
      yield emittedChunks[0]!
      yield emittedChunks[1]!
      throw new Error('stream broke')
    }
    const gateway = makeGateway({ stream: () => errorStream() })
    const { app, tmpLogDir } = makeAppWithErrors(gateway)

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
    await response.text().catch(() => {})
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.phase).toBe('stream')
    expect(record.error.message).toBe('stream broke')
    expect(Array.isArray(record.response)).toBe(true)
    expect((record.response as any[]).length).toBe(2)
    expect((record.response as any[])[0]!.text).toBe('partial ')
  })

  it('logs empty response array when acquireStream fails before first chunk', async () => {
    const gateway = makeGateway({
      stream() {
        throw new Error('connection refused')
      },
    })
    const { app, tmpLogDir } = makeAppWithErrors(gateway)

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
    const records = readErrors(tmpLogDir)
    const record = records.find(
      (r) => r.phase === 'stream' && r.error.message === 'connection refused',
    )
    expect(record).toBeDefined()
    expect(record!.response).toEqual([])
  })
})

describe('error logging integration — timeout', () => {
  it('logs timeout error with correct phase', async () => {
    const gateway = makeGateway({
      async generate() {
        await new Promise((resolve) => setTimeout(resolve, 50))
        throw new Error('late')
      },
    })
    const { app, tmpLogDir } = makeAppWithErrors(gateway, { requestTimeoutMs: 5 })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(504)
    const records = readErrors(tmpLogDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.phase).toBe('generate')
    expect(records[0]!.error.name).toBe('RequestTimeoutError')
  })
})

describe('error logging integration — disabled', () => {
  it('writes nothing when errorLogging.enabled is false', async () => {
    const gateway = makeGateway({
      async generate() {
        throw new Error('should not be logged')
      },
    })
    const { app, tmpLogDir } = makeAppWithErrors(gateway, {
      errorLogging: { enabled: false, maxBodyLength: 262144 },
    })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(502)
    const records = readErrors(tmpLogDir)
    expect(records.find((r) => r.error.message === 'should not be logged')).toBeUndefined()
  })
})

describe('error logging integration — redaction', () => {
  it('redacts authorization field from logged request body', async () => {
    const gateway = makeGateway({
      async generate() {
        throw new Error('redact test')
      },
    })
    const { app, tmpLogDir } = makeAppWithErrors(gateway)

    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
        authorization: 'Bearer super-secret',
      }),
    })

    const records = readErrors(tmpLogDir)
    const record = records.find((r) => r.error.message === 'redact test')!
    expect((record.request as any).authorization).toBe('[REDACTED]')
  })
})
