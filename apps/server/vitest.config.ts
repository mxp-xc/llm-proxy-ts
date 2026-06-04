import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { join } from 'node:path';

// 在 vitest 启动前加载环境变量（直接使用 dotenv，避免跨包导入）
const rootDir = resolve(import.meta.dirname, '../..');
const appDir = import.meta.dirname;
for (const filePath of [
  join(rootDir, '.env'),
  join(rootDir, '.env.local'),
  join(appDir, '.env'),
  join(appDir, '.env.local'),
]) {
  loadDotenv({ path: filePath, quiet: true, override: true });
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@llm-proxy/core': resolve(import.meta.dirname, '../core/src/index.ts'),
    },
  },
});
