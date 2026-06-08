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
  ids: string[]
}

function collectRows(settings: Settings): ModelRow[] {
  const rows: ModelRow[] = []

  for (const [providerName, provider] of Object.entries(settings.providers)) {
    const flat = isFlatLookupEnabled(provider as ProviderConfig, settings)
    for (const [modelKey, model] of Object.entries(provider.models)) {
      const ids: string[] = [`${providerName}/${modelKey}`]
      if (flat) {
        ids.push(modelKey)
        for (const alias of model.aliases) {
          ids.push(alias)
        }
      }
      rows.push({
        provider: providerName,
        modelKey,
        upstreamModel: model.upstreamModel,
        aliases: model.aliases,
        flat,
        ids,
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

  // Expand each row into one row per ID
  interface DisplayRow {
    id: string
    provider: string
    upstreamModel: string
    flat: string
  }

  const displayRows: DisplayRow[] = rows.flatMap((r) =>
    r.ids.map((id) => ({
      id,
      provider: r.provider,
      upstreamModel: r.upstreamModel,
      flat: r.flat ? '✓' : '✗',
    })),
  )

  const colDefs: Array<{ key: keyof DisplayRow; header: string }> = [
    { key: 'id', header: 'ID' },
    { key: 'provider', header: 'Provider' },
    { key: 'upstreamModel', header: 'Upstream Model' },
    { key: 'flat', header: 'Flat' },
  ]

  const widths = new Map<string, number>()
  for (const col of colDefs) {
    const headerLen = col.header.length
    const maxDataLen = displayRows.reduce(
      (max, r) => Math.max(max, String(r[col.key]).length),
      0,
    )
    widths.set(col.key, Math.max(headerLen, maxDataLen))
  }

  const w = (key: string) => widths.get(key) ?? 0

  const sep = colDefs.map((c) => '─'.repeat(w(c.key))).join('  ')
  const headerLine = colDefs.map((c) => c.header.padEnd(w(c.key))).join('  ')

  console.log(headerLine)
  console.log(sep)

  for (const row of displayRows) {
    const line = colDefs.map((c) => String(row[c.key]).padEnd(w(c.key))).join('  ')
    console.log(line)
  }
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
