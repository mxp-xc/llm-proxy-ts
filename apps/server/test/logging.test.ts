import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import { createApp, type ModelGateway } from '../src/app.js'
import type { Settings, ProviderRegistry } from '@llm-proxy/core'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const tempRoot = resolve(projectRoot, 'temp')

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
      models: {
        chat: { upstreamModel: 'openrouter/actual-chat', aliases: [], headers: {}, plugins: [] },
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

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('logging', () => {
  it('writes plain text console logs with one newline per entry', async () => {
    const stdout = captureStdout()
    vi.resetModules()

    try {
      const { createLogger } = await import('../src/logging.js')
      const logger = createLogger()

      logger.info(
        { method: 'GET', path: '/health', status: 200, durationMs: 3 },
        'request completed',
      )
      logger.warn({ provider: 'openrouter', keyIndex: 1, keyCount: 3 }, 'provider key selected')
      await stdout.waitForWrites(2)

      const lines = stdout.output.trimEnd().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO\s+llm-proxy - request completed method=GET path=\/health status=200 durationMs=3$/,
      )
      expect(lines[1]).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} WARN\s+llm-proxy - provider key selected provider=openrouter keyIndex=1 keyCount=3$/,
      )
    } finally {
      stdout.restore()
    }
  })

  it('writes plain text file logs with one newline per entry', async () => {
    const stdout = captureStdout()
    const logDir = resolve(tempRoot, `log-file-${Date.now()}`)
    vi.stubEnv('LLM_PROXY_LOG_DIR', logDir)
    vi.resetModules()

    try {
      const { createLogger } = await import('../src/logging.js')
      const logger = createLogger()

      logger.info(
        { method: 'GET', path: '/health', status: 200, durationMs: 3 },
        'request completed',
      )
      logger.warn({ provider: 'openrouter', keyIndex: 1, keyCount: 3 }, 'provider key selected')
      await stdout.waitForWrites(2)
      await flushFileStream(logger)

      const fileContent = readFileSync(resolve(logDir, getTodayLogFileName()), 'utf8')
      const lines = fileContent.trimEnd().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} INFO\s+llm-proxy - request completed method=GET path=\/health status=200 durationMs=3$/,
      )
      expect(lines[1]).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} WARN\s+llm-proxy - provider key selected provider=openrouter keyIndex=1 keyCount=3$/,
      )
      expect(fileContent.endsWith('\n')).toBe(true)
    } finally {
      stdout.restore()
      rmSync(logDir, { recursive: true, force: true })
    }
  })

  it('logs requested model and actual upstream model on chat completion requests', async () => {
    const logs: Array<{ fields: Record<string, unknown>; message?: string }> = []
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
      logger: recordingLogger(logs),
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

    expect(response.status).toBe(200)
    const completed = logs.find((entry) => entry.message === 'request completed')
    expect(completed?.fields).toMatchObject({
      method: 'POST',
      path: '/v1/chat/completions',
      status: 200,
      provider: 'openrouter',
      requestedModel: 'openrouter/chat',
      actualModel: 'openrouter/actual-chat',
    })
  })
})

function captureStdout(): {
  output: string
  waitForWrites: (count: number) => Promise<void>
  restore: () => void
} {
  const originalWrite = process.stdout.write.bind(process.stdout)
  let output = ''
  let writes = 0
  let resolveWait: (() => void) | undefined
  let expectedWrites = 0

  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((err?: Error) => void),
    callback?: (err?: Error) => void,
  ) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    writes += 1
    if (writes >= expectedWrites) {
      resolveWait?.()
      resolveWait = undefined
    }
    const cb = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    cb?.()
    return true
  }) as typeof process.stdout.write

  return {
    get output() {
      return output
    },
    waitForWrites(count: number) {
      expectedWrites = count
      if (writes >= expectedWrites) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        resolveWait = resolve
      })
    },
    restore() {
      process.stdout.write = originalWrite
    },
  }
}

async function flushFileStream(logger: { flush?: (callback?: () => void) => void }): Promise<void> {
  await new Promise<void>((resolve) => logger.flush?.(resolve))
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function getTodayLogFileName(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `llm-proxy.${y}-${m}-${d}.log`
}

function recordingLogger(logs: Array<{ fields: Record<string, unknown>; message?: string }>) {
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const lines = chunk
        .toString()
        .split('\n')
        .filter((line: string) => line.length > 0)
      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>
        const { msg, ...fields } = parsed
        if (typeof msg === 'string') {
          logs.push({ fields, message: msg })
        } else {
          logs.push({ fields })
        }
      }
      callback()
    },
  })

  return {
    child() {
      return this
    },
    info(fields: Record<string, unknown>, message?: string) {
      stream.write(`${JSON.stringify({ ...fields, msg: message })}\n`)
    },
    error(fields: Record<string, unknown>, message?: string) {
      stream.write(`${JSON.stringify({ ...fields, msg: message })}\n`)
    },
  } as never
}
