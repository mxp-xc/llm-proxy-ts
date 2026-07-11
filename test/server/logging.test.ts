import { afterEach, describe, expect, it, vi } from 'vitest'

describe('createLogger', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('node:fs')
    vi.doUnmock('pino')
  })

  it('logs full initialization errors before returning fallback logger', async () => {
    const setupError = new Error('log file unavailable')
    const errorSpy = vi.fn()
    const pinoSpy = vi.fn(() => ({ error: errorSpy }))

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return {
        ...actual,
        createWriteStream: vi.fn(() => {
          throw setupError
        }),
      }
    })

    vi.doMock('pino', () => {
      Object.assign(pinoSpy, {
        levels: { labels: {} },
        stdTimeFunctions: { isoTime: vi.fn() },
        multistream: vi.fn(),
      })
      return { default: pinoSpy }
    })

    const { createLogger } = await import('../../src/server/logging.js')

    const logger = createLogger()

    expect(logger.error).toBe(errorSpy)
    expect(errorSpy).toHaveBeenCalledWith(
      { err: setupError },
      'logger initialization failed; using stdout fallback',
    )
    expect(pinoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        redact: expect.objectContaining({
          paths: expect.arrayContaining([
            'apiKey',
            '*.apiKey',
            'x-api-key',
            '*.x-api-key',
            'proxy-authorization',
            '*.proxy-authorization',
            'api-key',
            '*.api-key',
            'api_key',
            '*.api_key',
          ]),
        }),
      }),
    )
  })
})
