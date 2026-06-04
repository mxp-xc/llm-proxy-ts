import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadSettingsFromFile, loadEnvironmentFiles, resolveSettingsPath, settingsSchema } from '@llm-proxy/core';
import { logger } from './logging.js';

async function main(): Promise<void> {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rootDir = resolve(appDir, '../..');

  loadEnvironmentFiles({ rootDir, appDir });

  const settingsPath = resolveSettingsPath({ rootDir });
  const settings = existsSync(settingsPath) ? await loadSettingsFromFile(settingsPath) : settingsSchema.parse({});
  const app = createApp({ settings });

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
