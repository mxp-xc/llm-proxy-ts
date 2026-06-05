import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadSettingsFromFile, loadEnvironmentFiles, resolveSettingsPath, settingsSchema, TokenManager } from '@llm-proxy/core';
import { logger } from './logging.js';
import { validateOAuthStatus, generateNonce } from './oauth/startup.js';

async function main(): Promise<void> {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rootDir = resolve(appDir, '../..');

  loadEnvironmentFiles({ rootDir, appDir });

  const settingsPath = resolveSettingsPath({ rootDir });
  const settings = existsSync(settingsPath) ? await loadSettingsFromFile(settingsPath) : settingsSchema.parse({});

  // OAuth 初始化
  let tokenManager: TokenManager | undefined;
  let nonce: string | undefined;
  let authStatuses: import('./oauth/startup.js').ProviderAuthStatus[] | undefined;

  const hasOAuthProviders = Object.values(settings.providers).some((p) => p.oauth);
  if (hasOAuthProviders) {
    // 解析 auth 文件路径：默认与 settings.jsonc 同目录
    const defaultAuthFile = join(dirname(settingsPath), 'auth.json');
    const authFilePath = defaultAuthFile;

    tokenManager = new TokenManager(authFilePath);
    await tokenManager.load();

    nonce = generateNonce();
    authStatuses = await validateOAuthStatus(settings, tokenManager);
  }

  const app = createApp({
    settings,
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
