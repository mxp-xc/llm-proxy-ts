import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { settingsSchema } from '../../src/config.js'
import {
  ErrorLogger,
  getErrorLogFileName,
  type ErrorLogEntry,
} from '../../src/server/error-logger.js'
import { cleanOldLogs, logger as fallbackLogger } from '../../src/server/logging.js'

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
    const logger = new ErrorLogger({ logDir: tmpLogDir, enabled: true, maxBodyLength: 262144 })
    logger.log({ ...baseEntry })
    const records = readErrorLog(tmpLogDir)
    expect(records).toHaveLength(1)
    expect(records[0]!.requestId).toBe('req-1')
    // YYYY-MM-DD HH:MM:SS 格式
    expect(records[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('redacts authorization field in request', () => {
    const logger = new ErrorLogger({ logDir: tmpLogDir, enabled: true, maxBodyLength: 262144 })
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
    const logger = new ErrorLogger({ logDir: tmpLogDir, enabled: true, maxBodyLength: 100 })
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
    const logger = new ErrorLogger({ logDir: tmpLogDir, enabled: false, maxBodyLength: 262144 })
    logger.log({ ...baseEntry, requestId: 'req-skip' })
    const records = readErrorLog(tmpLogDir)
    expect(records.find((r) => r.requestId === 'req-skip')).toBeUndefined()
  })

  it('does not throw when file write fails (logs fallback)', () => {
    const errorSpy = vi.spyOn(fallbackLogger, 'error').mockImplementation(() => undefined)
    const logger = new ErrorLogger({
      logDir: '/nonexistent/path/that/cannot/be/created',
      enabled: true,
      maxBodyLength: 262144,
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
