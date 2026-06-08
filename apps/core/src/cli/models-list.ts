import { Command } from 'commander'
import { loadSettingsFromFile } from '../config.js'
import { isFlatLookupEnabled } from '../config-helpers.js'
import type { ProviderConfig, Settings } from '../config.js'
import { resolveCliContext } from './context.js'

export interface ModelsListOptions {
  settingsPath: string
  format: 'table' | 'json'
}

interface ModelRow {
  provider: string
  modelKey: string
  upstreamModel: string
  aliases: string[]
  flat: boolean
}

function collectRows(settings: Settings): ModelRow[] {
  const rows: ModelRow[] = []

  for (const [providerName, provider] of Object.entries(settings.providers)) {
    const flat = isFlatLookupEnabled(provider as ProviderConfig, settings)
    for (const [modelKey, model] of Object.entries(provider.models)) {
      rows.push({
        provider: providerName,
        modelKey,
        upstreamModel: model.upstreamModel,
        aliases: model.aliases,
        flat,
      })
    }
  }

  return rows
}

function formatTable(rows: ModelRow[]): void {
  if (rows.length === 0) {
    console.log('No models configured in settings.')
    return
  }

  // Calculate column widths
  const colDefs: Array<{ key: keyof ModelRow; header: string }> = [
    { key: 'provider', header: 'Provider' },
    { key: 'modelKey', header: 'Model Key' },
    { key: 'upstreamModel', header: 'Upstream Model' },
    { key: 'aliases', header: 'Aliases' },
    { key: 'flat', header: 'Flat' },
  ]

  const widths = new Map<string, number>()
  for (const col of colDefs) {
    const headerLen = col.header.length
    const maxDataLen = rows.reduce((max, r) => Math.max(max, formatCell(r, col.key).length), 0)
    widths.set(col.key, Math.max(headerLen, maxDataLen))
  }

  const w = (key: string) => widths.get(key) ?? 0

  const sep = colDefs.map((c) => '─'.repeat(w(c.key))).join('  ')
  const headerLine = colDefs.map((c) => c.header.padEnd(w(c.key))).join('  ')

  console.log(headerLine)
  console.log(sep)

  for (const row of rows) {
    const line = colDefs.map((c) => formatCell(row, c.key).padEnd(w(c.key))).join('  ')
    console.log(line)
  }
}

function formatCell(row: ModelRow, key: keyof Omit<ModelRow, never>): string {
  if (key === 'aliases') return row.aliases.join(', ')
  if (key === 'flat') return row.flat ? '✓' : '✗'
  return String(row[key])
}

function formatJson(rows: ModelRow[]): void {
  console.log(JSON.stringify(rows, null, 2))
}

export async function runModelsList(options: ModelsListOptions): Promise<void> {
  const { settingsPath, format } = options
  const settings = await loadSettingsFromFile(settingsPath)

  if (Object.keys(settings.providers).length === 0) {
    if (format === 'json') {
      console.log('[]')
    } else {
      console.log('No providers configured in settings.')
    }
    return
  }

  const rows = collectRows(settings)

  if (format === 'json') {
    formatJson(rows)
  } else {
    formatTable(rows)
  }
}

export function createModelsListCommand(): Command {
  return new Command('list')
    .description('Display all configured models from settings')
    .option('-f, --format <format>', 'Output format: table or json', 'table')
    .action(async (opts) => {
      const { settingsPath } = resolveCliContext()
      await runModelsList({
        settingsPath,
        format: opts.format ?? 'table',
      })
    })
}
