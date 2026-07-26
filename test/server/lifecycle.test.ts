import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createNetServer, type AddressInfo, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Logger } from '../../src/types.js'
import {
  createShutdownController,
  type ClosableServer,
  type ShutdownControllerOptions,
} from '../../src/server/lifecycle.js'
import { startServer } from '../../src/server/server.js'
import type { LoggingRuntime } from '../../src/server/logging.js'

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function listenOnRandomPort(): Promise<{ server: Server; port: number }> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return { server, port: address.port }
}

async function closeNetServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

async function writeOAuthServerSettings(
  rootDir: string,
  port: number,
  requestTimeoutMs = 30_000,
): Promise<void> {
  const configDir = join(rootDir, 'config')
  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, 'settings.jsonc'),
    JSON.stringify({
      service: { host: '127.0.0.1', port },
      requestTimeoutMs,
      providers: {
        oauth: {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: null,
          oauth: {
            flow: 'client_credentials',
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            tokenUrl: 'https://auth.example.com/oauth2/token',
            scopes: [],
          },
          models: { chat: { upstreamModel: 'm' } },
        },
      },
    }),
    'utf8',
  )
}

function createShutdownControllerFixture(
  options: Omit<ShutdownControllerOptions, 'setExitCode' | 'forceExit'>,
) {
  const setExitCode = vi.fn<(code: number) => void>()
  const forceExit = vi.fn<(code: number) => void>()
  const controller = createShutdownController({ ...options, setExitCode, forceExit })
  return { controller, setExitCode, forceExit }
}

describe('createShutdownController', () => {
  it('closes the server and flushes logging once', async () => {
    const { logger, entries } = createLogger()
    const server: ClosableServer = { close: (callback) => callback() }
    const closeLogging = vi.fn(async () => {})
    const { controller, setExitCode } = createShutdownControllerFixture({
      server,
      logger,
      closeLogging,
      timeoutMs: 100,
      now: () => 10,
    })

    await controller.shutdown('SIGTERM')
    await controller.shutdown('SIGTERM')

    expect(closeLogging).toHaveBeenCalledTimes(1)
    expect(setExitCode).not.toHaveBeenCalled()
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'server.shutdown.requested' }),
        expect.objectContaining({ message: 'server.shutdown.completed' }),
      ]),
    )
  })

  it('disposes plugins once after closing the server and before flushing logging', async () => {
    const { logger } = createLogger()
    const calls: string[] = []
    const { controller } = createShutdownControllerFixture({
      server: {
        close(callback) {
          calls.push('server')
          callback()
        },
      },
      logger,
      disposePlugins: async () => {
        calls.push('plugins')
      },
      closeLogging: async () => {
        calls.push('logging')
      },
      timeoutMs: 100,
    })

    await controller.shutdown('SIGTERM')
    await controller.shutdown('SIGINT')

    expect(calls).toEqual(['server', 'plugins', 'logging'])
  })

  it('records plugin disposal failures and still closes logging', async () => {
    const { logger, entries } = createLogger()
    const disposeError = new Error('dispose failed')
    const closeLogging = vi.fn(async () => {})
    const { controller, setExitCode, forceExit } = createShutdownControllerFixture({
      server: { close: (callback) => callback() },
      logger,
      disposePlugins: async () => {
        throw disposeError
      },
      closeLogging,
      timeoutMs: 100,
    })

    await controller.shutdown('SIGTERM')

    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'error',
        payload: expect.objectContaining({ err: disposeError }),
        message: 'server.shutdown.plugin_dispose_failed',
      }),
    )
    expect(setExitCode).toHaveBeenCalledWith(1)
    expect(forceExit).not.toHaveBeenCalled()
    expect(closeLogging).toHaveBeenCalledOnce()
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
    const { controller } = createShutdownControllerFixture({
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
    expect(entries).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ closeResult: 'forced' }),
        message: 'server.shutdown.completed',
      }),
    )
  })

  it('records close failures, sets a failure exit code, and still flushes logging', async () => {
    const { logger, entries } = createLogger()
    const closeError = new Error('close failed')
    const server: ClosableServer = { close: (callback) => callback(closeError) }
    const closeLogging = vi.fn(async () => {})
    const { controller, setExitCode } = createShutdownControllerFixture({
      server,
      logger,
      closeLogging,
      timeoutMs: 100,
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
      let finishClose: (() => void) | undefined
      const closeAllConnections = vi.fn(() => finishClose?.())
      const server: ClosableServer = {
        close(callback) {
          finishClose = callback
        },
        closeAllConnections,
      }
      const closeLogging = vi.fn(async () => {})
      const abortActiveRequests = vi.fn()
      const { controller, setExitCode, forceExit } = createShutdownControllerFixture({
        server,
        logger,
        closeLogging,
        timeoutMs: 25,
        abortActiveRequests,
      })

      const shutdown = controller.shutdown('SIGTERM')
      await vi.advanceTimersByTimeAsync(25)
      await shutdown

      expect(closeAllConnections).toHaveBeenCalledOnce()
      expect(abortActiveRequests).toHaveBeenCalledOnce()
      expect(entries).toContainEqual(
        expect.objectContaining({ level: 'warn', message: 'server.shutdown.grace_expired' }),
      )
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          payload: expect.objectContaining({ closeResult: 'forced' }),
          message: 'server.shutdown.completed',
        }),
      )
      expect(setExitCode).not.toHaveBeenCalled()
      expect(closeLogging).toHaveBeenCalledOnce()
      expect(forceExit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks process errors fatal before shutting down', async () => {
    const { logger, entries } = createLogger()
    const processError = new Error('boom')
    const { controller } = createShutdownControllerFixture({
      server: { close: (callback) => callback() },
      logger,
      closeLogging: async () => {},
      timeoutMs: 100,
    })

    await controller.shutdown('unhandledRejection', processError)

    expect(entries[0]).toEqual({
      level: 'fatal',
      payload: { err: processError, event: 'unhandledRejection' },
      message: 'server.process_error',
    })
  })

  it('waits for active request logs before closing logging after force close', async () => {
    vi.useFakeTimers()
    try {
      let finishClose: (() => void) | undefined
      let finishDrain: (() => void) | undefined
      const closeLogging = vi.fn(async () => {})
      const controller = createShutdownController({
        server: {
          close(callback) {
            finishClose = callback
          },
          closeAllConnections() {
            finishClose?.()
          },
        },
        logger: createLogger().logger,
        closeLogging,
        timeoutMs: 25,
        forceTimeoutMs: 25,
        waitForActiveRequests: () =>
          new Promise<void>((resolve) => {
            finishDrain = resolve
          }),
      })

      const shutdown = controller.shutdown('SIGTERM')
      await vi.advanceTimersByTimeAsync(25)
      expect(closeLogging).not.toHaveBeenCalled()

      finishDrain?.()
      await shutdown
      expect(closeLogging).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forces process exit when forced shutdown cannot drain', async () => {
    vi.useFakeTimers()
    try {
      const forceExit = vi.fn()
      const { logger, entries } = createLogger()
      const controller = createShutdownController({
        server: { close() {}, closeAllConnections: vi.fn() },
        logger,
        closeLogging: async () => {},
        timeoutMs: 10,
        forceTimeoutMs: 10,
        forceExit,
      })

      const shutdown = controller.shutdown('SIGTERM')
      await vi.advanceTimersByTimeAsync(20)
      await shutdown

      expect(entries).toContainEqual(
        expect.objectContaining({ level: 'error', message: 'server.shutdown.force_timed_out' }),
      )
      expect(forceExit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still marks a repeated process error fatal during graceful shutdown', async () => {
    const { logger, entries } = createLogger()
    let finishClose: (() => void) | undefined
    const processError = new Error('shutdown crash')
    const fallbackError = vi.fn()
    const { controller, setExitCode } = createShutdownControllerFixture({
      server: {
        close(callback) {
          finishClose = callback
        },
        closeAllConnections: vi.fn(),
      },
      logger,
      closeLogging: async () => {},
      timeoutMs: 100,
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
    const { controller } = createShutdownControllerFixture({
      server: { close: (callback) => callback() },
      logger,
      closeLogging,
      timeoutMs: 100,
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
      const { controller, setExitCode } = createShutdownControllerFixture({
        server,
        logger,
        closeLogging,
        timeoutMs: 100,
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

  it('bounds logging close with an independent timeout', async () => {
    vi.useFakeTimers()
    try {
      const { logger } = createLogger()
      const fallbackError = vi.fn()
      const closeLogging = vi.fn(() => new Promise<void>(() => {}))
      let currentTime = 0
      const { controller, setExitCode, forceExit } = createShutdownControllerFixture({
        server: {
          close(callback) {
            currentTime = 20
            callback()
          },
        },
        logger,
        closeLogging,
        timeoutMs: 25,
        loggingTimeoutMs: 5,
        now: () => currentTime,
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
      expect(forceExit).toHaveBeenCalledOnce()
      expect(forceExit).toHaveBeenCalledWith(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds plugin disposal by the remaining deadline and still closes logging', async () => {
    vi.useFakeTimers()
    try {
      const { logger, entries } = createLogger()
      const closeLogging = vi.fn(async () => {})
      const fallbackError = vi.fn()
      let rejectDispose: ((reason: unknown) => void) | undefined
      let disposeSignal: AbortSignal | undefined
      const disposePlugins = vi.fn(
        (signal: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            disposeSignal = signal
            rejectDispose = reject
          }),
      )
      let currentTime = 0
      const { controller, setExitCode, forceExit } = createShutdownControllerFixture({
        server: {
          close(callback) {
            currentTime = 20
            callback()
          },
        },
        logger,
        disposePlugins,
        closeLogging,
        timeoutMs: 25,
        now: () => currentTime,
        fallbackError,
      })

      const shutdown = controller.shutdown('SIGTERM')
      await vi.advanceTimersByTimeAsync(4)
      expect(closeLogging).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await shutdown

      expect(disposePlugins).toHaveBeenCalledOnce()
      expect(closeLogging).toHaveBeenCalledOnce()
      expect(setExitCode).toHaveBeenCalledWith(1)
      expect(disposeSignal?.aborted).toBe(true)
      expect(forceExit).toHaveBeenCalledOnce()
      expect(forceExit).toHaveBeenCalledWith(1)
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: 'error',
          message: 'server.shutdown.plugin_dispose_timed_out',
        }),
      )

      const lateDisposeError = new Error('late dispose failure')
      rejectDispose?.(lateDisposeError)
      await Promise.resolve()
      expect(fallbackError).toHaveBeenCalledWith(
        'FATAL: plugin disposal failed after shutdown deadline',
        lateDisposeError,
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('startServer', () => {
  it('disposes initialized plugins in reverse order when startup fails', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-startup-cleanup-'))
    const calls: string[] = []
    const globals = globalThis as unknown as { __startupCleanupCalls?: string[] }
    globals.__startupCleanupCalls = calls
    try {
      const configDir = join(rootDir, 'config')
      await mkdir(configDir, { recursive: true })
      const firstPluginPath = join(rootDir, 'first.mjs')
      const secondPluginPath = join(rootDir, 'second.mjs')
      await writeFile(
        firstPluginPath,
        `export default {
          name: 'first',
          async init() {
            globalThis.__startupCleanupCalls.push('init:first')
          },
          async dispose() {
            globalThis.__startupCleanupCalls.push('dispose:first')
          }
        }`,
        'utf8',
      )
      await writeFile(
        secondPluginPath,
        `export default {
          name: 'second',
          async init() {
            globalThis.__startupCleanupCalls.push('init:second')
          },
          async beforeServerStart() {
            globalThis.__startupCleanupCalls.push('before:second')
            throw new Error('startup boom')
          },
          async dispose() {
            globalThis.__startupCleanupCalls.push('dispose:second')
          }
        }`,
        'utf8',
      )
      await writeFile(
        join(configDir, 'settings.jsonc'),
        JSON.stringify({
          plugins: [{ module: firstPluginPath }, { module: secondPluginPath }],
        }),
        'utf8',
      )
      const { logger } = createLogger()
      const logging: LoggingRuntime = {
        logger,
        logDir: join(rootDir, 'logs'),
        close: vi.fn(async () => {}),
      }

      await expect(startServer(rootDir, logging)).rejects.toThrow('startup boom')

      expect(calls).toEqual([
        'init:first',
        'init:second',
        'before:second',
        'dispose:second',
        'dispose:first',
      ])
      expect(logging.close).not.toHaveBeenCalled()
    } finally {
      delete globals.__startupCleanupCalls
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('bounds startup cleanup when plugin disposal hangs and rethrows the startup error', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-bounded-startup-cleanup-'))
    const startupError = new Error('startup boom')
    const disposeStarted = createDeferred<void>()
    const globals = globalThis as unknown as {
      __boundedStartupError?: Error
      __boundedStartupDisposeStarted?: () => void
      __boundedStartupDisposeSignal?: AbortSignal
    }
    globals.__boundedStartupError = startupError
    globals.__boundedStartupDisposeStarted = () => disposeStarted.resolve()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const configDir = join(rootDir, 'config')
      await mkdir(configDir, { recursive: true })
      const pluginPath = join(rootDir, 'hanging-dispose.mjs')
      await writeFile(
        pluginPath,
        `export default {
          name: 'hanging-dispose',
          async beforeServerStart() {
            throw globalThis.__boundedStartupError
          },
          async dispose(signal) {
            globalThis.__boundedStartupDisposeSignal = signal
            globalThis.__boundedStartupDisposeStarted()
            await new Promise(() => {})
          }
        }`,
        'utf8',
      )
      await writeFile(
        join(configDir, 'settings.jsonc'),
        JSON.stringify({ requestTimeoutMs: 1, plugins: [{ module: pluginPath }] }),
        'utf8',
      )
      const { logger, entries } = createLogger()
      const logging: LoggingRuntime = {
        logger,
        logDir: join(rootDir, 'logs'),
        close: vi.fn(async () => {}),
      }
      const onStartupCleanupTimeout = vi.fn()

      const startup = startServer(rootDir, logging, { onStartupCleanupTimeout })
      const startupFailure = expect(startup).rejects.toBe(startupError)
      await disposeStarted.promise
      await vi.advanceTimersByTimeAsync(5_001)

      await startupFailure
      expect(globals.__boundedStartupDisposeSignal?.aborted).toBe(true)
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: 'error',
          payload: expect.objectContaining({ err: expect.any(Error) }),
          message: 'plugin.dispose_after_startup_failure_timed_out',
        }),
      )
      expect(onStartupCleanupTimeout).toHaveBeenCalledOnce()
      expect(logging.close).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      consoleError.mockRestore()
      delete globals.__boundedStartupError
      delete globals.__boundedStartupDisposeStarted
      delete globals.__boundedStartupDisposeSignal
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('aborts and awaits the background OAuth refresh during shutdown', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-oauth-shutdown-'))
    const reservation = await listenOnRandomPort()
    const port = reservation.port
    await closeNetServer(reservation.server)
    const fetchStarted = createDeferred<void>()
    let refreshSignal: AbortSignal | undefined
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
      refreshSignal = init?.signal ?? undefined
      fetchStarted.resolve()
      return new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = (): void => reject(refreshSignal?.reason)
        refreshSignal?.addEventListener('abort', rejectOnAbort, { once: true })
        if (refreshSignal?.aborted) rejectOnAbort()
      })
    })
    vi.stubGlobal('fetch', fetchFn)
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    let started: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      await writeOAuthServerSettings(rootDir, port)
      const { logger, entries } = createLogger()
      const logging: LoggingRuntime = {
        logger,
        logDir: join(rootDir, 'logs'),
        close: vi.fn(async () => {}),
      }

      started = await startServer(rootDir, logging)
      await fetchStarted.promise
      await started.shutdownController.shutdown('SIGTERM')
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(refreshSignal?.aborted).toBe(true)
      expect(logging.close).toHaveBeenCalledOnce()
      expect(exitSpy).not.toHaveBeenCalled()
      expect(unhandledRejections).toEqual([])
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: 'info',
          payload: expect.objectContaining({ err: expect.anything() }),
          message: 'oauth.status_refresh_aborted',
        }),
      )
    } finally {
      await started?.shutdownController.shutdown('testCleanup')
      process.off('unhandledRejection', onUnhandledRejection)
      exitSpy.mockRestore()
      vi.unstubAllGlobals()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not force exit when the background OAuth refresh completes normally', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-oauth-refresh-complete-'))
    const reservation = await listenOnRandomPort()
    const port = reservation.port
    await closeNetServer(reservation.server)
    const refreshSucceeded = createDeferred<void>()
    let refreshSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
        refreshSignal = init?.signal ?? undefined
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'access-token',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }),
    )
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    let started: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      await writeOAuthServerSettings(rootDir, port)
      const base = createLogger()
      const logging: LoggingRuntime = {
        logger: {
          ...base.logger,
          info(payload, message) {
            base.logger.info(payload, message)
            if (message === 'oauth.refresh.succeeded') refreshSucceeded.resolve()
          },
        },
        logDir: join(rootDir, 'logs'),
        close: vi.fn(async () => {}),
      }

      started = await startServer(rootDir, logging)
      await refreshSucceeded.promise
      await started.shutdownController.shutdown('SIGTERM')
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(refreshSignal).toBeDefined()
      expect(logging.close).toHaveBeenCalledOnce()
      expect(exitSpy).not.toHaveBeenCalled()
      expect(unhandledRejections).toEqual([])
      expect(base.entries).not.toContainEqual(
        expect.objectContaining({ message: 'oauth.status_refresh_failed' }),
      )
    } finally {
      await started?.shutdownController.shutdown('testCleanup')
      process.off('unhandledRejection', onUnhandledRejection)
      exitSpy.mockRestore()
      vi.unstubAllGlobals()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('forces exit when an aborted background OAuth refresh ignores its signal', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-oauth-refresh-timeout-'))
    const originalExitCode = process.exitCode
    const reservation = await listenOnRandomPort()
    const port = reservation.port
    await closeNetServer(reservation.server)
    const fetchStarted = createDeferred<void>()
    let refreshSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
        refreshSignal = init?.signal ?? undefined
        fetchStarted.resolve()
        return new Promise<Response>(() => {})
      }),
    )
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let started: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      await writeOAuthServerSettings(rootDir, port, 1)
      const { logger } = createLogger()
      const logging: LoggingRuntime = {
        logger,
        logDir: join(rootDir, 'logs'),
        close: vi.fn(async () => {}),
      }

      started = await startServer(rootDir, logging)
      await fetchStarted.promise

      vi.useFakeTimers()
      const shutdown = started.shutdownController.shutdown('SIGTERM')
      await vi.advanceTimersByTimeAsync(5_001)
      await shutdown
      await Promise.resolve()

      expect(refreshSignal?.aborted).toBe(true)
      expect(logging.close).toHaveBeenCalledOnce()
      expect(exitSpy).toHaveBeenCalledOnce()
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(unhandledRejections).toEqual([])
    } finally {
      vi.useRealTimers()
      await started?.shutdownController.shutdown('testCleanup')
      process.exitCode = originalExitCode
      process.off('unhandledRejection', onUnhandledRejection)
      exitSpy.mockRestore()
      consoleError.mockRestore()
      vi.unstubAllGlobals()
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('runs afterServerStart only after listening and waits for it before dispose', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-listening-lifecycle-'))
    const reservation = await listenOnRandomPort()
    const port = reservation.port
    await closeNetServer(reservation.server)
    const calls: string[] = []
    const globals = globalThis as unknown as {
      __listeningLifecycleCalls?: string[]
      __finishAfterServerStart?: () => void
    }
    globals.__listeningLifecycleCalls = calls
    let started: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      const configDir = join(rootDir, 'config')
      await mkdir(configDir, { recursive: true })
      const pluginPath = join(rootDir, 'lifecycle.mjs')
      await writeFile(
        pluginPath,
        `export default {
          name: 'listening-lifecycle',
          async afterServerStart() {
            globalThis.__listeningLifecycleCalls.push('after:start')
            await new Promise((resolve) => {
              globalThis.__finishAfterServerStart = resolve
            })
            globalThis.__listeningLifecycleCalls.push('after:end')
          },
          async dispose() {
            globalThis.__listeningLifecycleCalls.push('dispose')
          }
        }`,
        'utf8',
      )
      await writeFile(
        join(configDir, 'settings.jsonc'),
        JSON.stringify({
          service: { host: '127.0.0.1', port },
          plugins: [{ module: pluginPath }],
        }),
        'utf8',
      )
      const base = createLogger()
      const logging: LoggingRuntime = {
        logger: {
          ...base.logger,
          info(payload, message) {
            if (message === 'server.listening') calls.push('listening')
            base.logger.info(payload, message)
          },
        },
        logDir: join(rootDir, 'logs'),
        close: vi.fn(async () => {
          calls.push('logging')
        }),
      }

      started = await startServer(rootDir, logging)

      expect(calls).toEqual(['listening', 'after:start'])
      const shutdown = started.shutdownController.shutdown('SIGTERM')
      await Promise.resolve()
      expect(calls).not.toContain('dispose')

      globals.__finishAfterServerStart?.()
      await shutdown

      expect(calls).toEqual(['listening', 'after:start', 'after:end', 'dispose', 'logging'])
    } finally {
      globals.__finishAfterServerStart?.()
      await started?.shutdownController.shutdown('testCleanup')
      delete globals.__listeningLifecycleCalls
      delete globals.__finishAfterServerStart
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('forces exit after a hanging afterServerStart without running dispose concurrently', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-hanging-after-start-'))
    const originalExitCode = process.exitCode
    const reservation = await listenOnRandomPort()
    const port = reservation.port
    await closeNetServer(reservation.server)
    const calls: string[] = []
    const globals = globalThis as unknown as {
      __hangingAfterCalls?: string[]
      __finishHangingAfter?: () => void
    }
    globals.__hangingAfterCalls = calls
    let started: Awaited<ReturnType<typeof startServer>> | undefined
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      calls.push(`exit:${String(code)}`)
      return undefined as never
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const configDir = join(rootDir, 'config')
      await mkdir(configDir, { recursive: true })
      const pluginPath = join(rootDir, 'hanging-after.mjs')
      await writeFile(
        pluginPath,
        `export default {
          name: 'hanging-after',
          async afterServerStart() {
            globalThis.__hangingAfterCalls.push('after:start')
            await new Promise((resolve) => {
              globalThis.__finishHangingAfter = resolve
            })
            globalThis.__hangingAfterCalls.push('after:end')
          },
          async dispose() {
            globalThis.__hangingAfterCalls.push('dispose')
          }
        }`,
        'utf8',
      )
      await writeFile(
        join(configDir, 'settings.jsonc'),
        JSON.stringify({
          service: { host: '127.0.0.1', port },
          requestTimeoutMs: 1,
          plugins: [{ module: pluginPath }],
        }),
        'utf8',
      )
      const base = createLogger()
      const logging: LoggingRuntime = {
        logger: base.logger,
        logDir: join(rootDir, 'logs'),
        close: vi.fn(async () => {
          calls.push('logging')
        }),
      }

      started = await startServer(rootDir, logging)
      expect(calls).toEqual(['after:start'])

      vi.useFakeTimers()
      const shutdown = started.shutdownController.shutdown('SIGTERM')
      await vi.advanceTimersByTimeAsync(5_001)
      await shutdown

      expect(logging.close).toHaveBeenCalledOnce()
      expect(exitSpy).toHaveBeenCalledOnce()
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(calls).toEqual(['after:start', 'logging', 'exit:1'])

      globals.__finishHangingAfter?.()
      await Promise.resolve()
      await Promise.resolve()
      expect(calls).toEqual(['after:start', 'logging', 'exit:1', 'after:end'])
      expect(calls).not.toContain('dispose')
    } finally {
      vi.useRealTimers()
      globals.__finishHangingAfter?.()
      await started?.shutdownController.shutdown('testCleanup')
      process.exitCode = originalExitCode
      exitSpy.mockRestore()
      consoleError.mockRestore()
      delete globals.__hangingAfterCalls
      delete globals.__finishHangingAfter
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  it('does not run afterServerStart when the server fails to bind', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'llm-proxy-bind-failure-'))
    const occupied = await listenOnRandomPort()
    const calls: string[] = []
    const globals = globalThis as unknown as { __bindFailureCalls?: string[] }
    globals.__bindFailureCalls = calls
    try {
      const configDir = join(rootDir, 'config')
      await mkdir(configDir, { recursive: true })
      const pluginPath = join(rootDir, 'bind-failure.mjs')
      await writeFile(
        pluginPath,
        `export default {
          name: 'bind-failure',
          async init() {
            globalThis.__bindFailureCalls.push('init')
          },
          async afterServerStart() {
            globalThis.__bindFailureCalls.push('after')
          },
          async dispose() {
            globalThis.__bindFailureCalls.push('dispose')
          }
        }`,
        'utf8',
      )
      await writeFile(
        join(configDir, 'settings.jsonc'),
        JSON.stringify({
          service: { host: '127.0.0.1', port: occupied.port },
          plugins: [{ module: pluginPath }],
        }),
        'utf8',
      )
      const { logger } = createLogger()
      const logging: LoggingRuntime = {
        logger,
        logDir: join(rootDir, 'logs'),
        close: vi.fn(async () => {}),
      }

      await expect(startServer(rootDir, logging)).rejects.toMatchObject({ code: 'EADDRINUSE' })

      expect(calls).toEqual(['init', 'dispose'])
      expect(logging.close).not.toHaveBeenCalled()
    } finally {
      delete globals.__bindFailureCalls
      await closeNetServer(occupied.server)
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
