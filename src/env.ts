import { join } from 'node:path'
import { config as loadDotenv } from 'dotenv'

export interface LoadEnvironmentFilesOptions {
  rootDir: string
}

export function loadEnvironmentFiles({ rootDir }: LoadEnvironmentFilesOptions): void {
  for (const filePath of [
    join(rootDir, '.env'),
    join(rootDir, '.env.local'),
  ]) {
    loadDotenv({ path: filePath, quiet: true, override: true })
  }
}
