import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createAdaptorServer, type ServerType } from '@hono/node-server'
import { createApp } from './app.js'
import {
  loadSettingsFromFile,
  loadEnvironmentFiles,
  resolveSettingsPath,
  settingsSchema,
  PluginRegistry,
  createProviderRegistry,
} from '../index.js'
import type { Settings } from '../index.js'
import { createTokenManagerIfNeeded } from '../oauth/index.js'
import { createLoggingRuntime, type LoggingRuntime } from './logging.js'
import { createShutdownController, runWithDeadline, type ShutdownController } from './lifecycle.js'
import { refreshAuthStatuses } from './oauth/startup.js'
import type { ProviderAuthStatus } from './oauth/startup.js'
import { createActiveRequestRegistry } from './active-requests.js'

interface StartedServer {
  shutdownController: ShutdownController
}

interface StartServerOptions {
  onStartupCleanupTimeout?: () => void
}

const STARTUP_CLEANUP_GRACE_MS = 5000
const STARTUP_LOGGING_CLOSE_TIMEOUT_MS = 1000

function waitForSettlementOrAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
    void promise.then(finish, finish)
    if (signal.aborted) finish()
  })
}

export function resolveServerPort(configuredPort: number, portOverride?: string): number {
  if (portOverride === undefined) return configuredPort
  const port = Number(portOverride)
  if (!/^\d+$/.test(portOverride) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('LLM_PROXY_PORT must be an integer between 1 and 65535')
  }
  return port
}

export function listenForStartup(
  server: ServerType,
  host: string,
  port: number,
): Promise<{ address: string; port: number }> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Server started without a network address'))
        return
      }
      resolve({ address: address.address, port: address.port })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function countConfiguredPlugins(settings: Settings): number {
  return Object.values(settings.providers).reduce(
    (total, provider) =>
      total +
      provider.plugins.length +
      Object.values(provider.models).reduce(
        (modelTotal, model) => modelTotal + model.plugins.length,
        0,
      ),
    settings.plugins.length,
  )
}

export async function startServer(
  rootDir: string,
  logging: LoggingRuntime,
  options: StartServerOptions = {},
): Promise<StartedServer> {
  const { logger, logDir } = logging
  const settingsPath = resolveSettingsPath({ rootDir })
  const hasSettingsFile = existsSync(settingsPath)
  const settings = hasSettingsFile
    ? await loadSettingsFromFile(settingsPath)
    : (logger.warn({ settingsPath }, 'server.settings_missing'), settingsSchema.parse({}))
  const port = resolveServerPort(settings.service.port, process.env.LLM_PROXY_PORT)
  const providers = Object.values(settings.providers)
  logger.info(
    {
      settingsPath,
      settingsSource: hasSettingsFile ? 'file' : 'defaults',
      host: settings.service.host,
      port,
      providerCount: providers.length,
      modelCount: providers.reduce(
        (total, provider) => total + Object.keys(provider.models).length,
        0,
      ),
      pluginCount: countConfiguredPlugins(settings),
      oauthProviderCount: providers.filter((provider) => provider.oauth !== undefined).length,
      proxyEnabled: settings.proxy !== null,
      requestTimeoutMs: settings.requestTimeoutMs,
      errorLoggingEnabled: settings.errorLogging.enabled,
      logDir,
      logLevel: process.env.LLM_PROXY_LOG_LEVEL ?? 'info',
      logFormat: process.env.LLM_PROXY_LOG_FORMAT ?? 'pretty',
    },
    'server.configuration_loaded',
  )

  const authFilePath = join(dirname(settingsPath), 'auth.json')
  const settingsDir = dirname(settingsPath)
  let pluginRegistry: PluginRegistry | undefined
  try {
    const registry = await PluginRegistry.fromSettings(settings, settingsDir, logger)
    pluginRegistry = registry
    await registry.initAll(logger, authFilePath)
    const hasOAuthProviders = providers.some((provider) => provider.oauth !== undefined)
    const tokenManager = await createTokenManagerIfNeeded(authFilePath, hasOAuthProviders, logger)
    await registry.beforeServerStartAll(logger)

    let authStatuses: ProviderAuthStatus[] = []
    const providerRegistry = await createProviderRegistry(
      settings,
      tokenManager,
      logger,
      registry,
      authFilePath,
    )
    const activeRequestRegistry = createActiveRequestRegistry()
    const app = createApp({
      settings,
      logger,
      errorLogDir: logDir,
      pluginRegistry: registry,
      providerRegistry,
      getAuthStatuses: () => authStatuses,
      activeRequestRegistry,
      ...(tokenManager ? { tokenManager } : {}),
    })

    const server = createAdaptorServer({ fetch: app.fetch, hostname: settings.service.host })
    const info = await listenForStartup(server, settings.service.host, port)
    logger.info(
      { service: settings.service.name, url: `http://${info.address}:${info.port}` },
      'server.listening',
    )

    let afterServerStartPromise = Promise.resolve()
    const authRefreshController = tokenManager ? new AbortController() : undefined
    let authRefreshPromise = Promise.resolve()
    const shutdownController = createShutdownController({
      server,
      logger,
      abortActiveRequests: (reason) => activeRequestRegistry.abortAll(reason),
      waitForActiveRequests: () => activeRequestRegistry.drain(),
      disposePlugins: async (signal) => {
        if (authRefreshController && !authRefreshController.signal.aborted) {
          const abortError = new Error('OAuth status refresh aborted during server shutdown')
          abortError.name = 'AbortError'
          authRefreshController.abort(abortError)
        }
        await authRefreshPromise
        await tokenManager?.waitForPendingRefreshes()
        if (!signal.aborted) await waitForSettlementOrAbort(afterServerStartPromise, signal)
        await registry.disposeAll(logger, signal)
      },
      closeLogging: logging.close,
      timeoutMs: settings.requestTimeoutMs + 5000,
      cleanupTimeoutMs: settings.requestTimeoutMs + 5000,
      forceExit: (code) => process.exit(code),
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      void shutdownController.shutdown('serverError', err).catch((shutdownError) => {
        process.exitCode = 1
        console.error('FATAL: server shutdown crashed', shutdownError)
      })
    })

    if (tokenManager) {
      authRefreshPromise = refreshAuthStatuses(
        settings,
        tokenManager,
        logger,
        authRefreshController?.signal,
      )
        .then((statuses) => {
          authStatuses = statuses
        })
        .catch((err) => {
          if (authRefreshController?.signal.aborted) {
            logger.info({ err }, 'oauth.status_refresh_aborted')
          } else {
            logger.error({ err }, 'oauth.status_refresh_failed')
          }
        })
    }
    if (!shutdownController.isShuttingDown()) {
      afterServerStartPromise = registry
        .afterServerStartAll(logger)
        .catch((err) => logger.error({ err }, 'plugin.after_server_start_crashed'))
    }
    return { shutdownController }
  } catch (err) {
    if (pluginRegistry) {
      const timeoutMs = settings.requestTimeoutMs + STARTUP_CLEANUP_GRACE_MS
      const disposeResult = await runWithDeadline(
        (signal) => pluginRegistry!.disposeAll(logger, signal),
        {
          timeoutMs,
          timeoutMessage: `Plugins did not dispose within the ${timeoutMs}ms startup cleanup deadline`,
          onLateFailure: (disposeError) =>
            logger.error(
              { err: disposeError },
              'plugin.dispose_after_startup_failure_late_failure',
            ),
        },
      )
      if (disposeResult.status === 'failed') {
        logger.error({ err: disposeResult.error }, 'plugin.dispose_after_startup_failure_failed')
      } else if (disposeResult.status === 'timed_out') {
        logger.error(
          { err: disposeResult.error, timeoutMs },
          'plugin.dispose_after_startup_failure_timed_out',
        )
        options.onStartupCleanupTimeout?.()
      }
    }
    throw err
  }
}

function installProcessHandlers(shutdownController: ShutdownController): void {
  const shutdown = (trigger: string, err?: unknown): void => {
    void shutdownController.shutdown(trigger, err).catch((shutdownError) => {
      process.exitCode = 1
      console.error('FATAL: server shutdown crashed', shutdownError)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => shutdown('uncaughtException', err))
  process.on('unhandledRejection', (reason) => shutdown('unhandledRejection', reason))
}

async function start(): Promise<void> {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  let logging: LoggingRuntime
  try {
    loadEnvironmentFiles({ rootDir })
    logging = createLoggingRuntime()
  } catch (err) {
    process.exitCode = 1
    console.error('FATAL: logging startup failed', err)
    return
  }

  let startupCleanupTimedOut = false
  try {
    const { shutdownController } = await startServer(rootDir, logging, {
      onStartupCleanupTimeout: () => {
        startupCleanupTimedOut = true
      },
    })
    installProcessHandlers(shutdownController)
  } catch (err) {
    process.exitCode = 1
    logging.logger.fatal({ err }, 'server.startup_failed')
    if (!startupCleanupTimedOut) {
      try {
        await logging.close()
      } catch (closeError) {
        console.error('FATAL: logging shutdown failed', closeError)
      }
      return
    }
    const loggingResult = await runWithDeadline(() => logging.close(), {
      timeoutMs: STARTUP_LOGGING_CLOSE_TIMEOUT_MS,
      timeoutMessage: `Logging did not close within ${STARTUP_LOGGING_CLOSE_TIMEOUT_MS}ms after startup cleanup timed out`,
      onLateFailure: (closeError) =>
        console.error('FATAL: logging shutdown failed after startup cleanup timeout', closeError),
    })
    if (loggingResult.status === 'failed') {
      console.error('FATAL: logging shutdown failed', loggingResult.error)
    } else if (loggingResult.status === 'timed_out') {
      console.error('FATAL: logging shutdown timed out', loggingResult.error)
    }
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await start()
}
