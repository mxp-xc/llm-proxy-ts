import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanOldLogs,
  createLoggingRuntime,
  formatCNDate,
  formatCNTimestamp,
  redact,
} from '../../src/server/logging.js'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'llm-proxy-logging-'))
  tempDirectories.push(directory)
  return directory
}

function capture(stream: PassThrough): () => string {
  let output = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    output += chunk
  })
  return () => output
}

describe('logging configuration', () => {
  it('reads environment values when the runtime is created', async () => {
    const root = tempDirectory()
    const stdout = new PassThrough()
    const runtime = createLoggingRuntime({
      cwd: root,
      env: {
        LLM_PROXY_LOG_DIR: 'late-env-logs',
        LLM_PROXY_LOG_LEVEL: 'warn',
        LLM_PROXY_LOG_FORMAT: 'json',
      },
      stdout,
    })

    expect(runtime.logDir).toBe(resolve(root, 'late-env-logs'))
    await runtime.close()
  })

  it.each([
    ['LLM_PROXY_LOG_LEVEL', 'verbose', /Invalid LLM_PROXY_LOG_LEVEL/],
    ['LLM_PROXY_LOG_FORMAT', 'text', /Invalid LLM_PROXY_LOG_FORMAT/],
  ] as const)('rejects invalid %s values', (key, value, expected) => {
    expect(() => createLoggingRuntime({ cwd: tempDirectory(), env: { [key]: value } })).toThrow(
      expected,
    )
  })
})

describe('logging redaction', () => {
  it('redacts nested case-insensitive keys while preserving Error details', () => {
    const cause = Object.assign(new Error('upstream failed'), { APIKEY: 'cause-secret' })
    const error = Object.assign(new Error('request failed', { cause }), {
      Authorization: 'Bearer secret',
      details: [
        {
          Api_Key: 'nested-secret',
          accessToken: 'access-secret',
          REFRESH_TOKEN: 'refresh-secret',
          ClientSecret: 'client-secret',
          cookie: 'session-secret',
          ok: true,
        },
      ],
    })

    expect(redact({ error, 'X-API-KEY': 'top-secret' })).toEqual({
      error: {
        name: 'Error',
        message: 'request failed',
        stack: error.stack,
        cause: {
          name: 'Error',
          message: 'upstream failed',
          stack: cause.stack,
          APIKEY: '[REDACTED]',
        },
        Authorization: '[REDACTED]',
        details: [
          {
            Api_Key: '[REDACTED]',
            accessToken: '[REDACTED]',
            REFRESH_TOKEN: '[REDACTED]',
            ClientSecret: '[REDACTED]',
            cookie: '[REDACTED]',
            ok: true,
          },
        ],
      },
      'X-API-KEY': '[REDACTED]',
    })
  })

  it('redacts upstream response fields attached to Error objects', () => {
    const error = Object.assign(
      new Error('upstream failed', {
        cause: { responseBody: 'cause-body-secret', headers: { cookie: 'cause-cookie' } },
      }),
      {
        responseBody: '{"token":"response-body-secret"}',
        responseHeaders: { 'set-cookie': 'response-header-secret' },
        headers: { authorization: 'request-header-secret' },
        statusCode: 502,
      },
    )

    const redacted = redact({
      error,
      responseBody: 'top-level-body-secret',
      nested: [{ responseHeaders: 'nested-header-secret' }],
    })

    expect(redacted).toEqual({
      error: {
        name: 'Error',
        message: 'upstream failed',
        stack: error.stack,
        cause: { responseBody: '[REDACTED]', headers: '[REDACTED]' },
        responseBody: '[REDACTED]',
        responseHeaders: '[REDACTED]',
        headers: '[REDACTED]',
        statusCode: 502,
      },
      responseBody: '[REDACTED]',
      nested: [{ responseHeaders: '[REDACTED]' }],
    })
    const serialized = JSON.stringify(redacted)
    for (const secret of [
      'cause-body-secret',
      'cause-cookie',
      'response-body-secret',
      'response-header-secret',
      'request-header-secret',
      'top-level-body-secret',
      'nested-header-secret',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('redacts child bindings and payloads before serialization', async () => {
    const root = tempDirectory()
    const stdout = new PassThrough()
    const output = capture(stdout)
    const runtime = createLoggingRuntime({
      cwd: root,
      env: { LLM_PROXY_LOG_FORMAT: 'json' },
      stdout,
    })

    runtime.logger
      .child({ Authorization: 'binding-secret', component: 'test' })
      .error({ nested: { apiKey: 'payload-secret' } }, 'failed')
    await runtime.close()

    const record = JSON.parse(output().trim()) as Record<string, unknown>
    expect(record).toMatchObject({
      Authorization: '[REDACTED]',
      component: 'test',
      nested: { apiKey: '[REDACTED]' },
      msg: 'failed',
    })
    expect(output()).not.toContain('binding-secret')
    expect(output()).not.toContain('payload-secret')
  })
})

describe('China time formatting and rotation', () => {
  it('formats timestamps with a fixed +08:00 offset', () => {
    const date = new Date('2026-07-20T16:00:01.000Z')
    expect(formatCNDate(date)).toBe('2026-07-21')
    expect(formatCNTimestamp(date)).toBe('2026-07-21 00:00:01')
  })

  it('rotates files at the write boundary across China midnight', async () => {
    const root = tempDirectory()
    let current = new Date('2026-07-20T15:59:59.000Z')
    const runtime = createLoggingRuntime({
      cwd: root,
      env: {},
      stdout: new PassThrough(),
      now: () => current,
    })

    runtime.logger.info({ sequence: 1 }, 'before midnight')
    current = new Date('2026-07-20T16:00:00.000Z')
    runtime.logger.info({ sequence: 2 }, 'after midnight')
    const firstClose = runtime.close()
    expect(runtime.close()).toBe(firstClose)
    await firstClose

    const logDir = join(root, 'logs')
    expect(readFileSync(join(logDir, 'llm-proxy.2026-07-20.log'), 'utf8')).toContain(
      'before midnight',
    )
    expect(readFileSync(join(logDir, 'llm-proxy.2026-07-21.log'), 'utf8')).toContain(
      'after midnight',
    )
  })

  it('cleans expired ordinary and error logs on the first rotation of a new China date', async () => {
    const root = tempDirectory()
    let current = new Date('2026-07-20T15:59:59.000Z')
    const runtime = createLoggingRuntime({
      cwd: root,
      env: {},
      stdout: new PassThrough(),
      now: () => current,
    })
    runtime.logger.info({}, 'before midnight')

    const logDir = join(root, 'logs')
    const oldLog = join(logDir, 'llm-proxy.2026-06-01.log')
    const oldErrorLog = join(logDir, 'errors-2026-06-01.ndjson')
    writeFileSync(oldLog, 'old')
    writeFileSync(oldErrorLog, 'old')
    const oldTime = new Date('2026-06-01T00:00:00.000Z')
    utimesSync(oldLog, oldTime, oldTime)
    utimesSync(oldErrorLog, oldTime, oldTime)

    current = new Date('2026-07-20T16:00:00.000Z')
    runtime.logger.info({}, 'after midnight')
    await runtime.close()

    expect(existsSync(oldLog)).toBe(false)
    expect(existsSync(oldErrorLog)).toBe(false)
  })

  it('reports rotation cleanup failures through structured logging', async () => {
    const root = tempDirectory()
    const stdout = new PassThrough()
    const output = capture(stdout)
    const cleanupError = new Error('rotation stat failed')
    let current = new Date('2026-07-20T15:59:59.000Z')
    let cleanupCount = 0
    const runtime = createLoggingRuntime({
      cwd: root,
      env: { LLM_PROXY_LOG_FORMAT: 'json' },
      stdout,
      now: () => current,
      cleanupFileSystem: {
        readdirSync: () => {
          cleanupCount += 1
          return cleanupCount === 1 ? [] : ['llm-proxy.2026-06-01.log']
        },
        statSync: () => {
          throw cleanupError
        },
        unlinkSync: vi.fn(),
      },
    })

    runtime.logger.info({}, 'before midnight')
    current = new Date('2026-07-20T16:00:00.000Z')
    runtime.logger.info({}, 'after midnight')
    await runtime.close()

    const records = output()
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records).toContainEqual(
      expect.objectContaining({
        msg: 'logging.cleanup_failed',
        operation: 'stat',
        err: expect.objectContaining({ message: 'rotation stat failed' }),
      }),
    )
  })
})

describe('log cleanup', () => {
  it('deletes ordinary logs older than seven days and keeps unrelated files', () => {
    const directory = tempDirectory()
    const oldLog = join(directory, 'llm-proxy.2026-06-01.log')
    const recentLog = join(directory, 'llm-proxy.2026-07-20.log')
    const unrelated = join(directory, 'notes.txt')
    writeFileSync(oldLog, 'old')
    writeFileSync(recentLog, 'recent')
    writeFileSync(unrelated, 'keep')
    const now = new Date('2026-07-21T00:00:00.000Z')
    utimesSync(oldLog, new Date('2026-06-01T00:00:00.000Z'), new Date('2026-06-01T00:00:00.000Z'))
    utimesSync(
      recentLog,
      new Date('2026-07-20T00:00:00.000Z'),
      new Date('2026-07-20T00:00:00.000Z'),
    )

    cleanOldLogs(directory, 7, { now })

    expect(existsSync(oldLog)).toBe(false)
    expect(existsSync(recentLog)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('reports cleanup failures with the error and operation context', () => {
    const cleanupError = new Error('stat unavailable')
    const onError = vi.fn()
    cleanOldLogs('logs', 7, {
      now: new Date('2026-07-21T00:00:00.000Z'),
      onError,
      fileSystem: {
        readdirSync: () => ['llm-proxy.2026-06-01.log'],
        statSync: () => {
          throw cleanupError
        },
        unlinkSync: vi.fn(),
      },
    })

    expect(onError).toHaveBeenCalledWith(cleanupError, {
      operation: 'stat',
      path: resolve('logs', 'llm-proxy.2026-06-01.log'),
    })
  })

  it('ignores ENOENT races while inspecting and deleting old logs', () => {
    const onError = vi.fn()
    const missing = Object.assign(new Error('gone'), { code: 'ENOENT' })
    cleanOldLogs('logs', 7, {
      now: new Date('2026-07-21T00:00:00.000Z'),
      onError,
      fileSystem: {
        readdirSync: () => ['llm-proxy.2026-06-01.log'],
        statSync: () => {
          throw missing
        },
        unlinkSync: vi.fn(),
      },
    })

    expect(onError).not.toHaveBeenCalled()
  })
})

describe('file destination failures', () => {
  it('does not advance downstream writes until both stdout and file writes complete', async () => {
    const root = tempDirectory()
    const stdoutWrites: string[] = []
    const fileWrites: string[] = []
    const stdoutCallbacks: Array<() => void> = []
    const fileCallbacks: Array<() => void> = []
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutWrites.push(chunk.toString())
        stdoutCallbacks.push(callback)
      },
    })
    const runtime = createLoggingRuntime({
      cwd: root,
      env: {},
      stdout,
      createFileStream: () =>
        new Writable({
          write(chunk, _encoding, callback) {
            fileWrites.push(chunk.toString())
            fileCallbacks.push(callback)
          },
        }),
    })

    runtime.logger.info({ sequence: 1 }, 'first')
    runtime.logger.info({ sequence: 2 }, 'second')
    await new Promise((resolvePromise) => setImmediate(resolvePromise))

    expect(stdoutWrites).toHaveLength(1)
    expect(fileWrites).toHaveLength(1)
    stdoutCallbacks.shift()?.()
    fileCallbacks.shift()?.()
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    expect(stdoutWrites).toHaveLength(2)
    expect(fileWrites).toHaveLength(2)

    const closePromise = runtime.close()
    stdoutCallbacks.shift()?.()
    fileCallbacks.shift()?.()
    await closePromise
  })

  it('keeps stdout logging available when the log directory cannot be created', async () => {
    const root = tempDirectory()
    const blockingFile = join(root, 'not-a-directory')
    writeFileSync(blockingFile, 'blocking file')
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const output = capture(stdout)
    const errors = capture(stderr)
    const createFileStream = vi.fn()
    const runtime = createLoggingRuntime({
      cwd: root,
      env: { LLM_PROXY_LOG_DIR: join(blockingFile, 'logs') },
      stdout,
      stderr,
      createFileStream,
    })

    runtime.logger.info({}, 'stdout remains available')
    await runtime.close()

    expect(output()).toContain('stdout remains available')
    expect(output()).toContain('logging.file_output_disabled')
    expect(output()).toContain('Error:')
    expect(errors()).toBe('')
    expect(createFileStream).not.toHaveBeenCalled()
  })

  it('reports an asynchronous stream failure once and disables file output', async () => {
    const root = tempDirectory()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const errors = capture(stderr)
    const streams: Writable[] = []
    const runtime = createLoggingRuntime({
      cwd: root,
      env: {},
      stdout,
      stderr,
      createFileStream: () => {
        const stream = new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error('disk unavailable'))
          },
        })
        streams.push(stream)
        return stream
      },
    })

    runtime.logger.info({}, 'first')
    await new Promise((resolvePromise) => setImmediate(resolvePromise))
    runtime.logger.info({}, 'second')
    await runtime.close()

    expect(streams).toHaveLength(1)
    expect(errors().match(/file logging disabled/g)).toHaveLength(1)
    expect(errors()).toContain('Error: disk unavailable')
  })

  it('flushes pending file writes and closes idempotently', async () => {
    const root = tempDirectory()
    let fileOutput = ''
    const runtime = createLoggingRuntime({
      cwd: root,
      env: {},
      stdout: new PassThrough(),
      createFileStream: () =>
        new Writable({
          write(chunk, _encoding, callback) {
            setImmediate(() => {
              fileOutput += chunk.toString()
              callback()
            })
          },
        }),
    })

    runtime.logger.info({}, 'pending line')
    const firstClose = runtime.close()
    expect(runtime.close()).toBe(firstClose)
    await firstClose

    expect(fileOutput).toContain('pending line')
  })
})
