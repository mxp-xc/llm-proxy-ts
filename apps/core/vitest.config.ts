import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@llm-proxy/core': resolve(import.meta.dirname, 'src/index.ts'),
    },
  },
});
