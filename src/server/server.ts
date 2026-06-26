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
  PluginRegistry,
  createProviderRegistry,
} from '../index.js'
import { createTokenManagerIfNeeded } from '../oauth/index.js'
import { logger } from './logging.js'
import { generateNonce, refreshAuthStatuses } from './oauth/startup.js'
import type { ProviderAuthStatus } from './oauth/startup.js'

async function main(): Promise<void> {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

  loadEnvironmentFiles({ rootDir })

  const settingsPath = resolveSettingsPath({ rootDir })
  const settings = existsSync(settingsPath)
    ? await loadSettingsFromFile(settingsPath)
    : (logger.warn({ settingsPath }, 'Settings file not found — starting with empty defaults...'), settingsSchema.parse({}))

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
  const hasOAuthProviders = Object.values(settings.providers).some((p) => p.oauth)
  const tokenManager = await createTokenManagerIfNeeded(authFilePath, hasOAuthProviders)
  let nonce: string | undefined
  if (tokenManager) {
    nonce = generateNonce()
  }

  // 插件 beforeServerStart（可阻塞启动，如 OAuth 登录）
  await pluginRegistry.beforeServerStartAll()

  // OAuth 状态容器：后台刷新回填，/health 通过 getter 懒读取。
  // 正确性不依赖此预刷新：请求路径的 createOAuthFetch 会独立 ensureValidToken。
  let authStatuses: ProviderAuthStatus[] = []

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
    getAuthStatuses: () => authStatuses,
    ...(tokenManager && nonce ? { tokenManager, nonce } : {}),
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
      fatalAndExit(
        err,
        `Port ${settings.service.port} is already in use`,
      )
    } else {
      fatalAndExit(err, 'Server failed to start')
    }
  })

  // OAuth 状态后台刷新（非阻塞，不延迟端口监听）
  if (tokenManager) {
    refreshAuthStatuses(settings, tokenManager)
      .then((s) => {
        authStatuses = s
      })
      .catch((err) => {
        logger.error({ err }, 'oauth status refresh failed')
      })
  }

  // 插件 afterServerStart（非阻塞后台任务）。afterServerStartAll 内部用
  // Promise.allSettled 逐个记录插件失败，不会因此 reject；这里的 .catch 只兜底
  // filter/map 脚手架本身的意外同步抛错（如畸形插件对象），避免落到 unhandledRejection
  // 只走 console.error 而绕过 pino。
  pluginRegistry
    .afterServerStartAll(logger)
    .catch((err) => logger.error({ err }, 'plugin afterServerStart crashed'))
}

/**
 * 同步写入 stderr 并退出。
 *
 * pino 通过异步 stream 写入日志；process.exit() 会立即终止进程，
 * 导致 logger.fatal / logger.flush() 的输出可能丢失。
 * 对启动阶段的致命错误，用 console.error（同步写 stderr）保底输出。
 */
function fatalAndExit(err: unknown, message: string): never {
  console.error(`FATAL: ${message}`, err)
  process.exit(1)
}

async function start(): Promise<void> {
  // Global uncaught error handlers — ensure anything that escapes per-request
  // error handling still reaches pino instead of silently disappearing to stderr.
  // Installed inside start() so importing this module has no side effects.
  process.on('uncaughtException', (error) => {
    fatalAndExit(error, 'uncaught exception')
  })

  process.on('unhandledRejection', (reason) => {
    console.error('unhandled rejection', reason)
  })

  try {
    await main()
  } catch (err) {
    fatalAndExit(err, 'startup failed')
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await start()
}
