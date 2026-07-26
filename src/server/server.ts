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
import { createShutdownController, type ShutdownController } from './lifecycle.js'
import { generateNonce, refreshAuthStatuses } from './oauth/startup.js'
import type { ProviderAuthStatus } from './oauth/startup.js'
import { createActiveRequestRegistry } from './active-requests.js'

interface StartedServer {
  shutdownController: ShutdownController
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

async function startServer(rootDir: string, logging: LoggingRuntime): Promise<StartedServer> {
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
  const pluginRegistry = await PluginRegistry.fromSettings(settings, settingsDir, logger)
  await pluginRegistry.initAll(logger, authFilePath)

  const hasOAuthProviders = providers.some((provider) => provider.oauth !== undefined)
  const tokenManager = await createTokenManagerIfNeeded(authFilePath, hasOAuthProviders, logger)
  const nonce = tokenManager ? generateNonce() : undefined

  await pluginRegistry.beforeServerStartAll(logger)

  let authStatuses: ProviderAuthStatus[] = []
  const providerRegistry = await createProviderRegistry(
    settings,
    tokenManager,
    logger,
    pluginRegistry,
    authFilePath,
  )
  const activeRequestRegistry = createActiveRequestRegistry()
  const app = createApp({
    settings,
    logger,
    errorLogDir: logDir,
    pluginRegistry,
    providerRegistry,
    getAuthStatuses: () => authStatuses,
    activeRequestRegistry,
    ...(tokenManager && nonce ? { tokenManager, nonce } : {}),
  })

  const server = createAdaptorServer({
    fetch: app.fetch,
    hostname: settings.service.host,
  })
  const info = await listenForStartup(server, settings.service.host, port)
  logger.info(
    { service: settings.service.name, url: `http://${info.address}:${info.port}` },
    'server.listening',
  )
  const shutdownController = createShutdownController({
    server,
    logger,
    closeLogging: logging.close,
    timeoutMs: settings.requestTimeoutMs + 5000,
    abortActiveRequests: (reason) => activeRequestRegistry.abortAll(reason),
    waitForActiveRequests: () => activeRequestRegistry.drain(),
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    void shutdownController.shutdown('serverError', err)
  })

  if (tokenManager) {
    refreshAuthStatuses(settings, tokenManager, logger)
      .then((statuses) => {
        authStatuses = statuses
      })
      .catch((err) => {
        logger.error({ err }, 'oauth.status_refresh_failed')
      })
  }

  pluginRegistry
    .afterServerStartAll(logger)
    .catch((err) => logger.error({ err }, 'plugin.after_server_start_crashed'))

  return { shutdownController }
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

  try {
    const { shutdownController } = await startServer(rootDir, logging)
    installProcessHandlers(shutdownController)
  } catch (err) {
    process.exitCode = 1
    logging.logger.fatal({ err }, 'server.startup_failed')
    try {
      await logging.close()
    } catch (closeError) {
      console.error('FATAL: logging shutdown failed', closeError)
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await start()
}
