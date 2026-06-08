import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolveSettingsPath, loadEnvironmentFiles } from '../index.js'

export interface CliContext {
  rootDir: string
  settingsPath: string
}

export function resolveCliContext(): CliContext {
  const cliDir = dirname(fileURLToPath(import.meta.url))
  const rootDir = resolve(cliDir, '../../../..')

  loadEnvironmentFiles({ rootDir, appDir: rootDir })
  const settingsPath = resolveSettingsPath({ rootDir })

  if (!existsSync(settingsPath)) {
    console.error(`Settings file not found at ${settingsPath}`)
    console.error(
      'Create one from the example: cp config/settings.example.jsonc config/settings.jsonc',
    )
    process.exit(1)
  }

  return { rootDir, settingsPath }
}
