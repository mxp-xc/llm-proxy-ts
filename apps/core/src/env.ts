import { join } from 'node:path'
import { config as loadDotenv } from 'dotenv'

export interface LoadEnvironmentFilesOptions {
  rootDir: string
  appDir: string
}

export function loadEnvironmentFiles({ rootDir, appDir }: LoadEnvironmentFilesOptions): void {
  for (const filePath of [
    join(rootDir, '.env'),
    join(rootDir, '.env.local'),
    join(appDir, '.env'),
    join(appDir, '.env.local'),
  ]) {
    loadDotenv({ path: filePath, quiet: true, override: true })
  }
}
