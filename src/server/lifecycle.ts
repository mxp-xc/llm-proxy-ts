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
  forceTimeoutMs?: number
  loggingTimeoutMs?: number
  abortActiveRequests?: (reason: unknown) => void
  waitForActiveRequests?: () => Promise<void>
  forceExit?: (code: number) => void
  now?: () => number
  setExitCode?: (code: number) => void
  fallbackError?: (message: string, err: unknown) => void
}

export interface ShutdownController {
  shutdown(trigger: string, err?: unknown): Promise<void>
  isShuttingDown(): boolean
}

type CloseResult = 'graceful' | 'forced' | 'failed' | 'force_timed_out'
type ServerCloseResult = 'closed' | 'failed'

export function createShutdownController({
  server,
  logger,
  closeLogging,
  timeoutMs,
  forceTimeoutMs = 5000,
  loggingTimeoutMs = 5000,
  abortActiveRequests,
  waitForActiveRequests = () => Promise.resolve(),
  forceExit = (code) => process.exit(code),
  now = () => performance.now(),
  setExitCode = (code) => {
    process.exitCode = code
  },
  fallbackError = (message, err) => console.error(message, err),
}: ShutdownControllerOptions): ShutdownController {
  const startedAt = now()
  let shutdownPromise: Promise<void> | undefined
  let loggingUnavailable = false
  let forceRequested = false
  let forceFailed = false

  const forceCloseConnections = (trigger: string): boolean => {
    forceRequested = true
    let succeeded = true
    try {
      abortActiveRequests?.(new DOMException(`Server shutdown forced by ${trigger}`, 'AbortError'))
    } catch (err) {
      logger.error({ err, trigger }, 'server.shutdown.abort_requests_failed')
      setExitCode(1)
      succeeded = false
      forceFailed = true
    }
    try {
      server.closeAllConnections?.()
    } catch (err) {
      logger.error({ err, trigger }, 'server.shutdown.force_close_failed')
      setExitCode(1)
      succeeded = false
      forceFailed = true
    }
    return succeeded
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

      const serverClose = new Promise<ServerCloseResult>((resolve) => {
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
      const requestsDrained = serverClose.then(async (result) => {
        if (result === 'closed') await waitForActiveRequests()
        return result
      })
      const timeout = new Promise<'grace_expired'>((resolve) => {
        timer = setTimeout(() => resolve('grace_expired'), timeoutMs)
      })

      const gracefulResult = await Promise.race([requestsDrained, timeout])
      if (timer) clearTimeout(timer)

      if (gracefulResult === 'closed') {
        closeResult = forceFailed ? 'failed' : forceRequested ? 'forced' : 'graceful'
      } else if (gracefulResult === 'failed') {
        closeResult = 'failed'
        logger.error({ err: closeError, trigger }, 'server.shutdown.failed')
        setExitCode(1)
      } else {
        logger.warn({ trigger, timeoutMs }, 'server.shutdown.grace_expired')
        const forceSucceeded = forceCloseConnections(trigger)
        let forceTimer: ReturnType<typeof setTimeout> | undefined
        const forceTimeout = new Promise<'force_timed_out'>((resolve) => {
          forceTimer = setTimeout(() => resolve('force_timed_out'), forceTimeoutMs)
        })
        const forcedResult = await Promise.race([requestsDrained, forceTimeout])
        if (forceTimer) clearTimeout(forceTimer)
        if (forcedResult === 'closed') {
          closeResult = forceSucceeded ? 'forced' : 'failed'
        } else if (forcedResult === 'failed') {
          closeResult = 'failed'
          logger.error({ err: closeError, trigger }, 'server.shutdown.failed')
          setExitCode(1)
        } else {
          closeResult = 'force_timed_out'
          logger.error({ trigger, forceTimeoutMs }, 'server.shutdown.force_timed_out')
          setExitCode(1)
        }
      }

      logger.info(
        { trigger, durationMs: Math.round(now() - shutdownStartedAt), closeResult },
        'server.shutdown.completed',
      )

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
        loggingTimer = setTimeout(() => resolve({ status: 'timed_out' }), loggingTimeoutMs)
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
          new Error(`Logging did not close within ${loggingTimeoutMs}ms`),
        )
      }
      if (closeResult === 'force_timed_out') forceExit(1)
    })()

    return shutdownPromise
  }

  return {
    shutdown,
    isShuttingDown: () => shutdownPromise !== undefined,
  }
}
