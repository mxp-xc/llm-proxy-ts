import { defineConfig } from 'vitest/config'
import { config as loadDotenv } from 'dotenv'
import { join, resolve } from 'node:path'

// 在 vitest 启动前加载环境变量
// 加载顺序：先通用 → 再本地覆盖 → 最后测试专用（优先级最高）
const rootDir = import.meta.dirname
for (const filePath of [
  join(rootDir, '.env'),
  join(rootDir, '.env.local'),
  join(rootDir, '.env.test.local'),
]) {
  loadDotenv({ path: filePath, quiet: true, override: true })
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
