import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { settingsSchema } from '../../src/config.js'
import {
  ErrorLogger,
  getErrorLogFileName,
  normalizeErrorForLog,
  type ErrorLogEntry,
} from '../../src/server/error-logger.js'
import { cleanOldLogs } from '../../src/server/logging.js'
import { noopLogger } from '../../src/types.js'

const fallbackLogger = { ...noopLogger, error: vi.fn() }

let tmpLogDir: string
beforeAll(() => {
  tmpLogDir = mkdtempSync(join(tmpdir(), 'errlog-'))
})
afterAll(() => {
  rmSync(tmpLogDir, { recursive: true, force: true })
})

function readErrorLog(logDir: string): ErrorLogEntry[] {
  const path = join(logDir, getErrorLogFileName())
  const raw = readFileSync(path, 'utf8').trim()
  if (raw === '') return []
  return raw.split('\n').map((line) => JSON.parse(line) as ErrorLogEntry)
}

describe('errorLogging config', () => {
  it('applies defaults when errorLogging omitted', () => {
    const parsed = settingsSchema.parse({ providers: {} })
    expect(parsed.errorLogging).toEqual({
      enabled: true,
      maxBodyLength: 262144,
    })
  })

  it('respects explicit errorLogging values', () => {
    const parsed = settingsSchema.parse({
      providers: {},
      errorLogging: { enabled: false, maxBodyLength: 1024 },
    })
    expect(parsed.errorLogging).toEqual({ enabled: false, maxBodyLength: 1024 })
  })
})

describe('ErrorLogger', () => {
  const baseEntry: ErrorLogEntry = {
    timestamp: '',
    requestId: 'req-1',
    phase: 'generate',
    provider: 'test-provider',
    requestedModel: 'test-model',
    actualModel: 'upstream-model',
    error: { name: 'Error', message: 'boom', stack: 'Error: boom\n  at test' },
    request: { model: 'test-model', messages: [] },
    response: null,
  }

  it('writes a valid NDJSON line with CN timestamp', () => {
    const logger = new ErrorLogger({
      logDir: tmpLogDir,
      enabled: true,
      maxBodyLength: 262144,
      logger: fallbackLogger,
    })
    logger.log({ ...baseEntry })
    const records = readErrorLog(tmpLogDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.requestId).toBe('req-1')
    // YYYY-MM-DD HH:MM:SS 格式
    expect(records[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('redacts authorization field in request', () => {
    const logger = new ErrorLogger({
      logDir: tmpLogDir,
      enabled: true,
      maxBodyLength: 262144,
      logger: fallbackLogger,
    })
    logger.log({
      ...baseEntry,
      requestId: 'req-redact',
      request: { authorization: 'Bearer secret-key', model: 'x' },
    })
    const records = readErrorLog(tmpLogDir)
    const target = records.find((r) => r.requestId === 'req-redact')!
    expect((target.request as Record<string, unknown>).authorization).toBe('[REDACTED]')
  })

  it('truncates oversized request body', () => {
    const logger = new ErrorLogger({
      logDir: tmpLogDir,
      enabled: true,
      maxBodyLength: 100,
      logger: fallbackLogger,
    })
    const bigText = 'x'.repeat(500)
    logger.log({
      ...baseEntry,
      requestId: 'req-trunc',
      request: { big: bigText },
    })
    const records = readErrorLog(tmpLogDir)
    const target = records.find((r) => r.requestId === 'req-trunc')!
    const req = target.request as Record<string, unknown>
    expect(req._truncated).toBe(true)
    expect(typeof req.originalLength).toBe('number')
    expect(typeof req.preview).toBe('string')
    expect((req.preview as string).length).toBeLessThanOrEqual(1024)
  })

  it('does nothing when enabled is false', () => {
    const logger = new ErrorLogger({
      logDir: tmpLogDir,
      enabled: false,
      maxBodyLength: 262144,
      logger: fallbackLogger,
    })
    logger.log({ ...baseEntry, requestId: 'req-skip' })
    const records = readErrorLog(tmpLogDir)
    expect(records.find((r) => r.requestId === 'req-skip')).toBeUndefined()
  })

  it('does not throw when file write fails (logs fallback)', () => {
    const errorSpy = vi.spyOn(fallbackLogger, 'error').mockImplementation(() => undefined)
    const blockingFile = join(tmpLogDir, 'not-a-directory')
    writeFileSync(blockingFile, 'blocks mkdirSync')
    const logger = new ErrorLogger({
      logDir: blockingFile,
      enabled: true,
      maxBodyLength: 262144,
      logger: fallbackLogger,
    })
    expect(() => logger.log({ ...baseEntry, requestId: 'req-fallback' })).not.toThrow()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.anything(),
        requestId: 'req-fallback',
        phase: 'generate',
        provider: 'test-provider',
        requestedModel: 'test-model',
        actualModel: 'upstream-model',
      }),
      'error log write failed',
    )
    errorSpy.mockRestore()
  })
})

describe('normalizeErrorForLog', () => {
  it.each([
    {
      name: 'AI_APICallError',
      createError: (sensitiveMessage: string, responseBody: string) =>
        Object.assign(new Error(sensitiveMessage), {
          name: 'AI_APICallError',
          statusCode: 502,
          responseBody,
          isRetryable: true,
        }),
    },
    {
      name: 'AI_RetryError',
      createError: (sensitiveMessage: string, responseBody: string) => {
        const lastError = Object.assign(new Error(sensitiveMessage), {
          name: 'AI_APICallError',
          statusCode: 502,
          responseBody,
          isRetryable: true,
        })
        return Object.assign(
          new Error(`Failed after 3 attempts. Last error: ${sensitiveMessage}`),
          {
            name: 'AI_RetryError',
            lastError,
            reason: 'maxRetriesExceeded',
            errors: [lastError, lastError, lastError],
          },
        )
      },
    },
  ])('removes response-body-derived text from $name message and stack', ({ createError }) => {
    const sensitiveMessage = 'account private-response-detail is unavailable'
    const responseBody = JSON.stringify({
      error: { type: 'upstream_error', message: sensitiveMessage },
    })

    const normalized = normalizeErrorForLog(createError(sensitiveMessage, responseBody))
    const serialized = JSON.stringify(normalized)

    expect(normalized.message).toBe('Upstream provider request failed')
    expect(normalized).not.toHaveProperty('stack')
    expect(normalized).toMatchObject({
      statusCode: 502,
      responseBodyBytes: Buffer.byteLength(responseBody, 'utf8'),
      upstreamErrorType: 'upstream_error',
      isRetryable: true,
    })
    expect(serialized).not.toContain(sensitiveMessage)
    expect(serialized).not.toContain(responseBody)
  })

  it.each([
    {
      name: 'AI_APICallError',
      createError: (message: string, responseBody: string) =>
        Object.assign(new Error(message), {
          name: 'AI_APICallError',
          statusCode: 502,
          responseBody,
        }),
    },
    {
      name: 'AI_RetryError',
      createError: (message: string, responseBody: string) => {
        const lastError = Object.assign(new Error(message), {
          name: 'AI_APICallError',
          statusCode: 502,
          responseBody,
        })
        return Object.assign(new Error(`Failed after 3 attempts. Last error: ${message}`), {
          name: 'AI_RetryError',
          lastError,
          errors: [lastError, lastError, lastError],
        })
      },
    },
  ])('preserves $name text when it is not derived from the response body', ({ createError }) => {
    const responseBody = JSON.stringify({
      error: { type: 'upstream_error', message: 'private response detail' },
    })
    const error = createError('Invalid JSON response', responseBody)

    const normalized = normalizeErrorForLog(error)

    expect(normalized.message).toBe(error.message)
    expect(normalized.stack).toBe(error.stack)
  })

  it('preserves useful details for ordinary errors', () => {
    const cause = new Error('root cause')
    const error = new TypeError('ordinary failure', { cause })

    expect(normalizeErrorForLog(error)).toEqual({
      name: 'TypeError',
      message: 'ordinary failure',
      stack: error.stack,
      cause: {
        name: 'Error',
        message: 'root cause',
        stack: cause.stack,
      },
    })
  })

  it('keeps useful upstream fields without serializing request bodies', () => {
    const lastError = Object.assign(new Error('Upstream request failed'), {
      statusCode: 502,
      responseBody: '{"error":{"type":"upstream_error"}}',
      isRetryable: true,
      requestBodyValues: { model: 'gpt-5.4', input: 'x'.repeat(1_000_000) },
    })
    const error = Object.assign(new Error('Failed after 3 attempts'), {
      lastError,
      reason: 'maxRetriesExceeded',
      errors: [new Error('one'), new Error('two'), lastError],
    })

    const normalized = normalizeErrorForLog(error)

    expect(normalized).toMatchObject({
      name: 'Error',
      message: 'Failed after 3 attempts',
      statusCode: 502,
      responseBodyBytes: 35,
      upstreamErrorType: 'upstream_error',
      isRetryable: true,
      retryReason: 'maxRetriesExceeded',
      attempts: 3,
    })
    expect(normalized).not.toHaveProperty('responseBody')
    expect(JSON.stringify(normalized)).not.toContain('requestBodyValues')
    expect(JSON.stringify(normalized)).not.toContain('gpt-5.4')
  })
})

describe('cleanOldLogs error file rotation', () => {
  it('deletes error log files older than 30 days but keeps recent ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rotation-'))
    const now = Date.now()
    const oldMs = now - 31 * 24 * 60 * 60 * 1000
    const recentMs = now - 5 * 24 * 60 * 60 * 1000

    const oldFile = join(dir, 'errors-2025-05-01.ndjson')
    writeFileSync(oldFile, '{"test":1}')
    const recentFile = join(dir, 'errors-2026-06-25.ndjson')
    writeFileSync(recentFile, '{"test":2}')

    utimesSync(oldFile, oldMs / 1000, oldMs / 1000)
    utimesSync(recentFile, recentMs / 1000, recentMs / 1000)

    cleanOldLogs(dir, 7)

    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(recentFile)).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })
})
