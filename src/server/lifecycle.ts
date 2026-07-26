import { performance } from 'node:perf_hooks'
import type { Logger } from '../types.js'

export interface ClosableServer {
  close(callback: (err?: Error) => void): unknown
  closeAllConnections?(): void
}

export interface ShutdownControllerOptions {
  server: ClosableServer
  logger: Logger
  disposePlugins?: (signal: AbortSignal) => Promise<void>
  closeLogging: () => Promise<void>
  timeoutMs: number
  forceTimeoutMs?: number
  cleanupTimeoutMs?: number
  loggingTimeoutMs?: number
  abortActiveRequests?: (reason: unknown) => void
  waitForActiveRequests?: () => Promise<void>
  now?: () => number
  setExitCode?: (code: number) => void
  forceExit?: (code: number) => void
  fallbackError?: (message: string, err: unknown) => void
}

export interface ShutdownController {
  shutdown(trigger: string, err?: unknown): Promise<void>
  isShuttingDown(): boolean
}

export type DeadlineSettlement =
  | { status: 'completed' }
  | { status: 'failed'; error: unknown }
  | { status: 'timed_out'; error: Error }

export interface RunWithDeadlineOptions {
  timeoutMs: number
  timeoutMessage: string
  now?: () => number
  onLateFailure?: (error: unknown) => void
}

type CloseResult = 'graceful' | 'forced' | 'failed' | 'force_timed_out'

function settleWithin(
  operation: () => Promise<void>,
  timeoutMs: number,
  timeoutMessage: string,
  onTimeout: (error: Error) => void,
  onLateFailure: (error: unknown) => void,
): Promise<DeadlineSettlement> {
  let operationPromise: Promise<void>
  try {
    operationPromise = Promise.resolve(operation())
  } catch (error) {
    return Promise.resolve({ status: 'failed', error })
  }

  let timedOut = false
  const observed = operationPromise.then<DeadlineSettlement, DeadlineSettlement>(
    () => ({ status: 'completed' }),
    (error: unknown) => {
      if (timedOut) onLateFailure(error)
      return { status: 'failed', error }
    },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<DeadlineSettlement>((resolve) => {
    timer = setTimeout(
      () => {
        timedOut = true
        const error = new Error(timeoutMessage)
        onTimeout(error)
        resolve({ status: 'timed_out', error })
      },
      Math.max(0, timeoutMs),
    )
  })

  return Promise.race([observed, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function runWithDeadline(
  operation: (signal: AbortSignal) => Promise<void>,
  { timeoutMs, timeoutMessage, onLateFailure = () => {} }: RunWithDeadlineOptions,
): Promise<DeadlineSettlement> {
  const controller = new AbortController()
  return settleWithin(
    () => operation(controller.signal),
    timeoutMs,
    timeoutMessage,
    (error) => controller.abort(error),
    onLateFailure,
  )
}

export function createShutdownController({
  server,
  logger,
  disposePlugins,
  closeLogging,
  timeoutMs,
  forceTimeoutMs = 5000,
  cleanupTimeoutMs,
  loggingTimeoutMs = 5000,
  abortActiveRequests,
  waitForActiveRequests = () => Promise.resolve(),
  now = () => performance.now(),
  setExitCode = (code) => {
    process.exitCode = code
  },
  forceExit = () => {},
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
    const abortReason = new DOMException(`Server shutdown forced by ${trigger}`, 'AbortError')
    try {
      abortActiveRequests?.(abortReason)
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
      if (err !== undefined) recordProcessError(trigger, err)
      logger.warn({ trigger }, 'server.shutdown.repeated')
      forceCloseConnections(trigger)
      return shutdownPromise
    }

    shutdownPromise = (async () => {
      const shutdownStartedAt = now()
      const shutdownDeadline = shutdownStartedAt + timeoutMs
      let mustForceExit = false
      if (err !== undefined) recordProcessError(trigger, err)
      logger.info(
        { trigger, uptimeMs: Math.round(shutdownStartedAt - startedAt), timeoutMs },
        'server.shutdown.requested',
      )

      let closeFailure: unknown
      const serverClose = new Promise<void>((resolve, reject) => {
        try {
          server.close((serverError) => (serverError ? reject(serverError) : resolve()))
        } catch (error) {
          reject(error)
        }
      })
      const closeAndDrain = serverClose.then(waitForActiveRequests)
      const graceResult = await settleWithin(
        () => closeAndDrain,
        timeoutMs,
        `Server did not drain within ${timeoutMs}ms`,
        () => {},
        (error) => fallbackError('FATAL: server close failed after grace period', error),
      )

      let closeResult: CloseResult
      if (graceResult.status === 'completed') {
        closeResult = forceFailed ? 'failed' : forceRequested ? 'forced' : 'graceful'
      } else if (graceResult.status === 'failed') {
        closeFailure = graceResult.error
        closeResult = 'failed'
        logger.error({ err: closeFailure, trigger }, 'server.shutdown.failed')
        setExitCode(1)
      } else {
        logger.warn({ trigger, timeoutMs }, 'server.shutdown.grace_expired')
        const forceSucceeded = forceCloseConnections(trigger)
        const forcedResult = await settleWithin(
          () => closeAndDrain,
          forceTimeoutMs,
          `Active requests did not drain within ${forceTimeoutMs}ms after force close`,
          () => {},
          (error) => fallbackError('FATAL: server close failed after force timeout', error),
        )
        if (forcedResult.status === 'completed') {
          closeResult = forceSucceeded ? 'forced' : 'failed'
        } else if (forcedResult.status === 'failed') {
          closeResult = 'failed'
          logger.error({ err: forcedResult.error, trigger }, 'server.shutdown.failed')
          setExitCode(1)
        } else {
          closeResult = 'force_timed_out'
          logger.error({ trigger, forceTimeoutMs }, 'server.shutdown.force_timed_out')
          setExitCode(1)
          mustForceExit = true
        }
      }

      logger.info(
        { trigger, durationMs: Math.round(now() - shutdownStartedAt), closeResult },
        'server.shutdown.completed',
      )

      if (disposePlugins) {
        const disposeTimeoutMs = cleanupTimeoutMs ?? Math.max(0, shutdownDeadline - now())
        const disposeResult = await runWithDeadline(disposePlugins, {
          timeoutMs: disposeTimeoutMs,
          timeoutMessage: `Plugins did not dispose within ${disposeTimeoutMs}ms`,
          onLateFailure: (error) =>
            fallbackError('FATAL: plugin disposal failed after shutdown deadline', error),
        })
        if (disposeResult.status === 'failed') {
          logger.error(
            { err: disposeResult.error, trigger },
            'server.shutdown.plugin_dispose_failed',
          )
          setExitCode(1)
        } else if (disposeResult.status === 'timed_out') {
          logger.error(
            { err: disposeResult.error, trigger },
            'server.shutdown.plugin_dispose_timed_out',
          )
          setExitCode(1)
          mustForceExit = true
        }
      }

      loggingUnavailable = true
      const loggingResult = await runWithDeadline(() => closeLogging(), {
        timeoutMs: loggingTimeoutMs,
        timeoutMessage: `Logging did not close within ${loggingTimeoutMs}ms`,
        onLateFailure: (error) =>
          fallbackError('FATAL: logging shutdown failed after shutdown deadline', error),
      })
      if (loggingResult.status === 'failed') {
        setExitCode(1)
        fallbackError('FATAL: logging shutdown failed', loggingResult.error)
      } else if (loggingResult.status === 'timed_out') {
        setExitCode(1)
        fallbackError('FATAL: logging shutdown timed out', loggingResult.error)
        mustForceExit = true
      }

      if (mustForceExit) forceExit(1)
    })()

    return shutdownPromise
  }

  return {
    shutdown,
    isShuttingDown: () => shutdownPromise !== undefined,
  }
}
