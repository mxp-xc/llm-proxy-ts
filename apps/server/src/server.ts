import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadSettingsFromFile, loadEnvironmentFiles, resolveSettingsPath, settingsSchema, TokenManager, loadAuthPlugin } from '@llm-proxy/core';
import type { ResolvedAuthPlugin } from '@llm-proxy/core';
import { logger } from './logging.js';
import { validateOAuthStatus, generateNonce } from './oauth/startup.js';
import type { ProviderAuthStatus } from './oauth/startup.js';

async function main(): Promise<void> {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rootDir = resolve(appDir, '../..');

  loadEnvironmentFiles({ rootDir, appDir });

  const settingsPath = resolveSettingsPath({ rootDir });
  const settings = existsSync(settingsPath) ? await loadSettingsFromFile(settingsPath) : settingsSchema.parse({});

  // Auth 文件路径：与 settings.jsonc 同目录
  const authFilePath = join(dirname(settingsPath), 'auth.json');

  // 加载 Auth 插件
  let authPlugins: Map<string, ResolvedAuthPlugin> | undefined;
  const providersWithAuth = Object.entries(settings.providers).filter(([, p]) => p.auth);

  if (providersWithAuth.length > 0) {
    authPlugins = new Map();
    const baseDir = dirname(settingsPath);

    for (const [providerName, provider] of providersWithAuth) {
      if (!provider.auth) continue;

      const resolved = await loadAuthPlugin(provider.auth.module, baseDir);

      // 启动时校验插件配置
      if (resolved.plugin.validateConfig) {
        resolved.plugin.validateConfig(provider.auth.config);
      }

      authPlugins.set(providerName, resolved);
      logger.info(
        { provider: providerName, plugin: resolved.plugin.name, module: provider.auth.module },
        'auth plugin loaded',
      );
    }
  }

  // OAuth 初始化
  let tokenManager: TokenManager | undefined;
  let nonce: string | undefined;
  let authStatuses: ProviderAuthStatus[] | undefined;

  const hasOAuthProviders = Object.values(settings.providers).some((p) => p.oauth);
  const hasAuthProviders = Object.values(settings.providers).some((p) => p.auth);

  if (hasOAuthProviders) {
    tokenManager = new TokenManager(authFilePath);
    await tokenManager.load();
    nonce = generateNonce();
  }

  // 状态校验（覆盖 OAuth 和 auth 插件 provider）
  if (tokenManager) {
    authStatuses = await validateOAuthStatus(settings, tokenManager, authPlugins);
  } else if (hasAuthProviders && authPlugins) {
    // 无 OAuth provider 但有 auth 插件 provider — 仍需收集状态
    authStatuses = [];
    for (const [providerName, provider] of Object.entries(settings.providers)) {
      if (!provider.auth || !authPlugins.has(providerName)) continue;
      const resolved = authPlugins.get(providerName)!;
      logger.info(
        { provider: providerName, plugin: resolved.plugin.name },
        'auth plugin ready',
      );
      authStatuses.push({ provider: providerName, status: 'valid' });
    }
  }

  const app = createApp({
    settings,
    authFilePath,
    ...(authPlugins ? { authPlugins } : {}),
    ...(tokenManager && nonce ? { tokenManager, nonce, ...(authStatuses ? { authStatuses } : {}) } : {}),
  });

  const server = serve(
    {
      fetch: app.fetch,
      hostname: settings.service.host,
      port: settings.service.port,
    },
    (info) => {
      logger.info(
        { host: info.address, port: info.port },
        `${settings.service.name} listening`,
      );
    },
  );

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal(
        { host: settings.service.host, port: settings.service.port, err },
        `Port ${settings.service.port} is already in use`,
      );
    } else {
      logger.fatal({ err }, 'Server failed to start');
    }
    process.exit(1);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
