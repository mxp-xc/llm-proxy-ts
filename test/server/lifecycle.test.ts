import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../../src/types.js'
import { createShutdownController, type ClosableServer } from '../../src/server/lifecycle.js'

function createLogger(isClosed: () => boolean = () => false) {
  const entries: Array<{ level: string; payload: unknown; message?: string }> = []
  const record = (level: string, payload: unknown, message?: string): void => {
    if (isClosed()) return
    entries.push({ level, payload, ...(message === undefined ? {} : { message }) })
  }
  const logger: Logger = {
    info(payload, message) {
      record('info', payload, message)
    },
    warn(payload, message) {
      record('warn', payload, message)
    },
    error(payload, message) {
      record('error', payload, message)
    },
    fatal(payload, message) {
      record('fatal', payload, message)
    },
    child() {
      return logger
    },
  }
  return { logger, entries }
}

describe('createShutdownController', () => {
  it('closes the server and flushes logging once', async () => {
    const { logger, entries } = createLogger()
    const server: ClosableServer = { close: (callback) => callback() }
    const closeLogging = vi.fn(async () => {})
    const exitCodes: number[] = []
    const controller = createShutdownController({
      server,
      logger,
      closeLogging,
      timeoutMs: 100,
      now: () => 10,
      setExitCode: (code) => exitCodes.push(code),
    })

    await controller.shutdown('SIGTERM')
    await controller.shutdown('SIGTERM')

    expect(closeLogging).toHaveBeenCalledTimes(1)
    expect(exitCodes).toEqual([])
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'server.shutdown.requested' }),
        expect.objectContaining({ message: 'server.shutdown.completed' }),
      ]),
    )
  })

  it('forces connections closed when shutdown is requested again', async () => {
    const { logger, entries } = createLogger()
    let finishClose: (() => void) | undefined
    const server: ClosableServer = {
      close(callback) {
        finishClose = callback
      },
      closeAllConnections: vi.fn(),
    }
    const controller = createShutdownController({
      server,
      logger,
      closeLogging: async () => {},
      timeoutMs: 100,
    })

    const first = controller.shutdown('SIGINT')
    const second = controller.shutdown('SIGTERM')
    finishClose?.()
    await Promise.all([first, second])

    expect(server.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(entries).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'server.shutdown.repeated' }),
    )
  })

  it('records close failures, sets a failure exit code, and still flushes logging', async () => {
    const { logger, entries } = createLogger()
    const closeError = new Error('close failed')
    const server: ClosableServer = { close: (callback) => callback(closeError) }
    const closeLogging = vi.fn(async () => {})
    const setExitCode = vi.fn()
    const controller = createShutdownController({
      server,
      logger,
      closeLogging,
      timeoutMs: 100,
      setExitCode,
    })

    await controller.shutdown('SIGTERM')

    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        payload: expect.objectContaining({ err: closeError }),
        message: 'server.shutdown.failed',
      }),
    )
    expect(setExitCode).toHaveBeenCalledWith(1)
    expect(closeLogging).toHaveBeenCalledOnce()
  })

  it('forces open connections closed after the shutdown timeout', async () => {
    vi.useFakeTimers()
    try {
      const { logger, entries } = createLogger()
      const server: ClosableServer = {
        close() {},
        closeAllConnections: vi.fn(),
      }
      const closeLogging = vi.fn(async () => {})
      const setExitCode = vi.fn()
      const controller = createShutdownController({
        server,
        logger,
        closeLogging,
        timeoutMs: 25,
        setExitCode,
      })

      const shutdown = controller.shutdown('SIGTERM')
      await vi.advanceTimersByTimeAsync(25)
      await shutdown

      expect(server.closeAllConnections).toHaveBeenCalledOnce()
      expect(entries).toContainEqual(
        expect.objectContaining({ level: 'error', message: 'server.shutdown.timed_out' }),
      )
      expect(setExitCode).toHaveBeenCalledWith(1)
      expect(closeLogging).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks process errors fatal before shutting down', async () => {
    const { logger, entries } = createLogger()
    const processError = new Error('boom')
    const controller = createShutdownController({
      server: { close: (callback) => callback() },
      logger,
      closeLogging: async () => {},
      timeoutMs: 100,
      setExitCode: vi.fn(),
    })

    await controller.shutdown('unhandledRejection', processError)

    expect(entries[0]).toEqual({
      level: 'fatal',
      payload: { err: processError, event: 'unhandledRejection' },
      message: 'server.process_error',
    })
  })

  it('still marks a repeated process error fatal during graceful shutdown', async () => {
    const { logger, entries } = createLogger()
    let finishClose: (() => void) | undefined
    const processError = new Error('shutdown crash')
    const setExitCode = vi.fn()
    const fallbackError = vi.fn()
    const controller = createShutdownController({
      server: {
        close(callback) {
          finishClose = callback
        },
        closeAllConnections: vi.fn(),
      },
      logger,
      closeLogging: async () => {},
      timeoutMs: 100,
      setExitCode,
      fallbackError,
    })

    const shutdown = controller.shutdown('SIGTERM')
    controller.shutdown('uncaughtException', processError)
    finishClose?.()
    await shutdown

    expect(entries).toContainEqual({
      level: 'fatal',
      payload: { err: processError, event: 'uncaughtException' },
      message: 'server.process_error',
    })
    expect(setExitCode).toHaveBeenCalledWith(1)
    expect(fallbackError).not.toHaveBeenCalled()
  })

  it('falls back while logging is closing and its logger is already silent', async () => {
    let loggingClosed = false
    const { logger, entries } = createLogger(() => loggingClosed)
    const processError = new Error('crash during log flush')
    const fallbackError = vi.fn()
    let markCloseStarted: (() => void) | undefined
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve
    })
    let finishLogging: (() => void) | undefined
    const closeLogging = vi.fn(() => {
      loggingClosed = true
      markCloseStarted?.()
      return new Promise<void>((resolve) => {
        finishLogging = resolve
      })
    })
    const controller = createShutdownController({
      server: { close: (callback) => callback() },
      logger,
      closeLogging,
      timeoutMs: 100,
      setExitCode: vi.fn(),
      fallbackError,
    })

    const shutdown = controller.shutdown('SIGTERM')
    await closeStarted
    void controller.shutdown('uncaughtException', processError)

    expect(entries).not.toContainEqual(expect.objectContaining({ message: 'server.process_error' }))
    expect(fallbackError).toHaveBeenCalledWith(
      'FATAL: server.process_error during repeated shutdown (uncaughtException)',
      processError,
    )

    finishLogging?.()
    await shutdown
  })

  it.each(['uncaughtException', 'unhandledRejection'])(
    'falls back to stderr for %s after logging has closed',
    async (trigger) => {
      let loggingClosed = false
      const { logger, entries } = createLogger(() => loggingClosed)
      const processError = new Error('post-shutdown crash')
      const fallbackError = vi.fn()
      const server: ClosableServer = {
        close: vi.fn((callback) => callback()),
        closeAllConnections: vi.fn(),
      }
      const closeLogging = vi.fn(async () => {
        loggingClosed = true
      })
      const setExitCode = vi.fn()
      const controller = createShutdownController({
        server,
        logger,
        closeLogging,
        timeoutMs: 100,
        setExitCode,
        fallbackError,
      })

      await controller.shutdown('SIGTERM')
      await controller.shutdown(trigger, processError)

      expect(entries).not.toContainEqual(
        expect.objectContaining({ message: 'server.process_error' }),
      )
      expect(fallbackError).toHaveBeenCalledWith(
        `FATAL: server.process_error during repeated shutdown (${trigger})`,
        processError,
      )
      expect(setExitCode).toHaveBeenCalledWith(1)
      expect(server.close).toHaveBeenCalledOnce()
      expect(server.closeAllConnections).toHaveBeenCalledOnce()
      expect(closeLogging).toHaveBeenCalledOnce()
    },
  )

  it('bounds logging close by the shutdown deadline', async () => {
    vi.useFakeTimers()
    try {
      const { logger } = createLogger()
      const setExitCode = vi.fn()
      const fallbackError = vi.fn()
      const closeLogging = vi.fn(() => new Promise<void>(() => {}))
      let currentTime = 0
      const controller = createShutdownController({
        server: {
          close(callback) {
            currentTime = 20
            callback()
          },
        },
        logger,
        closeLogging,
        timeoutMs: 25,
        now: () => currentTime,
        setExitCode,
        fallbackError,
      })

      const shutdown = controller.shutdown('SIGTERM')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(4)
      expect(fallbackError).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await shutdown

      expect(closeLogging).toHaveBeenCalledOnce()
      expect(setExitCode).toHaveBeenCalledWith(1)
      expect(fallbackError).toHaveBeenCalledWith(
        'FATAL: logging shutdown timed out',
        expect.any(Error),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
