import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolveSettingsPath, loadEnvironmentFiles } from '../index.js'
import { runModelsSync } from './models-sync.js'

function parseArgs(argv: string[]): {
  command: string
  subcommand?: string
  provider?: string
  dryRun: boolean
} {
  const args = argv.slice(2)
  let command = ''
  let subcommand: string | undefined
  let provider: string | undefined
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--provider' || arg === '-p') {
      provider = args[++i]
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (!command) {
      command = arg ?? ''
    } else if (!subcommand) {
      subcommand = arg
    }
  }

  const result: { command: string; subcommand?: string; provider?: string; dryRun: boolean } = {
    command,
    dryRun,
  }
  if (subcommand !== undefined) result.subcommand = subcommand
  if (provider !== undefined) result.provider = provider
  return result
}

function printHelp(): void {
  console.log(`
llm-proxy-ts CLI

Usage:
  llm-proxy models sync [options]

Options:
  --provider, -p <name>   Skip provider selection, sync specific provider
  --dry-run               Preview changes without writing to settings
  --help                  Show this help message

Commands:
  models sync             Discover and select models from upstream providers
`)
}

async function main(): Promise<void> {
  const { command, subcommand, provider, dryRun } = parseArgs(process.argv)

  if (!command || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  if (command === 'models' && subcommand === 'sync') {
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

    const syncOpts: Parameters<typeof runModelsSync>[0] = { settingsPath, dryRun }
    if (provider !== undefined) syncOpts.provider = provider
    await runModelsSync(syncOpts)
    return
  }

  console.error(`Unknown command: ${command} ${subcommand ?? ''}`)
  printHelp()
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
