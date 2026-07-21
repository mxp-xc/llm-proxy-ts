import { performance } from 'node:perf_hooks'
import type { Logger } from '../types.js'

export interface ClosableServer {
  close(callback: (err?: Error) => void): unknown
  closeAllConnections?(): void
}

export interface ShutdownControllerOptions {
  server: ClosableServer
  logger: Logger
  closeLogging: () => Promise<void>
  timeoutMs: number
  now?: () => number
  setExitCode?: (code: number) => void
  fallbackError?: (message: string, err: unknown) => void
}

export interface ShutdownController {
  shutdown(trigger: string, err?: unknown): Promise<void>
  isShuttingDown(): boolean
}

type CloseResult = 'closed' | 'failed' | 'timed_out'

export function createShutdownController({
  server,
  logger,
  closeLogging,
  timeoutMs,
  now = () => performance.now(),
  setExitCode = (code) => {
    process.exitCode = code
  },
  fallbackError = (message, err) => console.error(message, err),
}: ShutdownControllerOptions): ShutdownController {
  const startedAt = now()
  let shutdownPromise: Promise<void> | undefined
  let loggingUnavailable = false

  const forceCloseConnections = (trigger: string): void => {
    try {
      server.closeAllConnections?.()
    } catch (err) {
      logger.error({ err, trigger }, 'server.shutdown.force_close_failed')
      setExitCode(1)
    }
  }

  const recordProcessError = (trigger: string, err: unknown): void => {
    setExitCode(1)
    if (loggingUnavailable) {
      fallbackError(`FATAL: server.process_error during repeated shutdown (${trigger})`, err)
      return
    }
    logger.fatal({ err, event: trigger }, 'server.process_error')
  }

  const shutdown = (trigger: string, err?: unknown): Promise<void> => {
    if (shutdownPromise) {
      if (err !== undefined) {
        recordProcessError(trigger, err)
      }
      logger.warn({ trigger }, 'server.shutdown.repeated')
      forceCloseConnections(trigger)
      return shutdownPromise
    }

    shutdownPromise = (async () => {
      const shutdownStartedAt = now()
      const shutdownDeadline = shutdownStartedAt + timeoutMs
      if (err !== undefined) {
        recordProcessError(trigger, err)
      }

      logger.info(
        { trigger, uptimeMs: Math.round(shutdownStartedAt - startedAt), timeoutMs },
        'server.shutdown.requested',
      )

      let closeResult: CloseResult
      let closeError: unknown
      let timer: ReturnType<typeof setTimeout> | undefined

      const serverClose = new Promise<CloseResult>((resolve) => {
        try {
          server.close((serverError) => {
            if (serverError) {
              closeError = serverError
              resolve('failed')
            } else {
              resolve('closed')
            }
          })
        } catch (serverError) {
          closeError = serverError
          resolve('failed')
        }
      })
      const timeout = new Promise<CloseResult>((resolve) => {
        const remainingMs = Math.max(0, shutdownDeadline - now())
        timer = setTimeout(() => resolve('timed_out'), remainingMs)
      })

      closeResult = await Promise.race([serverClose, timeout])
      if (timer) clearTimeout(timer)

      if (closeResult === 'timed_out') {
        logger.error({ trigger, timeoutMs }, 'server.shutdown.timed_out')
        setExitCode(1)
        forceCloseConnections(trigger)
      } else if (closeResult === 'failed') {
        logger.error({ err: closeError, trigger }, 'server.shutdown.failed')
        setExitCode(1)
      }

      logger.info(
        { trigger, durationMs: Math.round(now() - shutdownStartedAt), closeResult },
        'server.shutdown.completed',
      )

      const remainingMs = Math.max(0, shutdownDeadline - now())
      let loggingTimer: ReturnType<typeof setTimeout> | undefined
      // createLoggingRuntime.close() silences its adapter before the flush completes.
      loggingUnavailable = true
      const loggingClose = Promise.resolve()
        .then(closeLogging)
        .then(
          () => ({ status: 'closed' as const }),
          (error: unknown) => ({ status: 'failed' as const, error }),
        )
      const loggingTimeout = new Promise<{ status: 'timed_out' }>((resolve) => {
        loggingTimer = setTimeout(() => resolve({ status: 'timed_out' }), remainingMs)
      })
      const loggingResult = await Promise.race([loggingClose, loggingTimeout])
      if (loggingTimer) clearTimeout(loggingTimer)

      if (loggingResult.status === 'failed') {
        setExitCode(1)
        fallbackError('FATAL: logging shutdown failed', loggingResult.error)
      } else if (loggingResult.status === 'timed_out') {
        setExitCode(1)
        fallbackError(
          'FATAL: logging shutdown timed out',
          new Error(`Logging did not close within the ${timeoutMs}ms shutdown deadline`),
        )
      }
    })()

    return shutdownPromise
  }

  return {
    shutdown,
    isShuttingDown: () => shutdownPromise !== undefined,
  }
}
