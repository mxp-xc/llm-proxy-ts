import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolveSettingsPath } from '../resolve-settings-path.js'
import { loadEnvironmentFiles } from '../env.js'

export interface CliContext {
  rootDir: string
  settingsPath: string
}

export function resolveCliContext(): CliContext {
  const cliDir = dirname(fileURLToPath(import.meta.url))
  const rootDir = resolve(cliDir, '../..')

  loadEnvironmentFiles({ rootDir })
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
