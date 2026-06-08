import { existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import {
  loadSettingsFromFile,
  loadEnvironmentFiles,
  resolveSettingsPath,
  settingsSchema,
  TokenManager,
  PluginRegistry,
  createProviderRegistry,
} from '@llm-proxy/core'
import { logger } from './logging.js'
import { validateOAuthStatus, generateNonce } from './oauth/startup.js'
import type { ProviderAuthStatus } from './oauth/startup.js'

async function main(): Promise<void> {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const rootDir = resolve(appDir, '../..')

  loadEnvironmentFiles({ rootDir, appDir })

  const settingsPath = resolveSettingsPath({ rootDir })
  const settings = existsSync(settingsPath)
    ? await loadSettingsFromFile(settingsPath)
    : settingsSchema.parse({})

  // Auth 文件路径：与 settings.jsonc 同目录
  const authFilePath = join(dirname(settingsPath), 'auth.json')
  const settingsDir = dirname(settingsPath)

  // 加载插件
  const pluginRegistry = await PluginRegistry.fromSettings(
    settings,
    settingsDir,
    authFilePath,
    logger,
  )

  // 初始化插件
  await pluginRegistry.initAll(logger, authFilePath)

  // OAuth 初始化
  let tokenManager: TokenManager | undefined
  let nonce: string | undefined
  let authStatuses: ProviderAuthStatus[] | undefined

  const hasOAuthProviders = Object.values(settings.providers).some((p) => p.oauth)

  if (hasOAuthProviders) {
    tokenManager = new TokenManager(authFilePath)
    await tokenManager.load()
    nonce = generateNonce()
  }

  // 插件 beforeServerStart（可阻塞启动，如 OAuth 登录）
  await pluginRegistry.beforeServerStartAll()

  // 状态校验
  if (tokenManager) {
    authStatuses = await validateOAuthStatus(settings, tokenManager)
  }

  const app = createApp({
    settings,
    authFilePath,
    pluginRegistry,
    providerRegistry: await createProviderRegistry(
      settings,
      tokenManager,
      logger,
      pluginRegistry,
      authFilePath,
    ),
    ...(tokenManager && nonce
      ? { tokenManager, nonce, ...(authStatuses ? { authStatuses } : {}) }
      : {}),
  })

  const server = serve(
    {
      fetch: app.fetch,
      hostname: settings.service.host,
      port: settings.service.port,
    },
    (info) => {
      logger.info({ host: info.address, port: info.port }, `${settings.service.name} listening`)
    },
  )

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal(
        { host: settings.service.host, port: settings.service.port, err },
        `Port ${settings.service.port} is already in use`,
      )
    } else {
      logger.fatal({ err }, 'Server failed to start')
    }
    process.exit(1)
  })

  // 插件 afterServerStart（非阻塞后台任务）
  pluginRegistry.afterServerStartAll().catch((err) => {
    logger.error({ err }, 'plugin afterServerStart error')
  })
}

// Global uncaught error handlers — ensure anything that escapes per-request
// error handling still reaches pino instead of silently disappearing to stderr.
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception')
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled rejection')
})

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
