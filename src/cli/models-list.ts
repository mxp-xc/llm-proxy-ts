import { Command } from 'commander'
import { loadSettingsFromFile } from '../config.js'
import type { ModelRouteConfig, Settings } from '../config.js'
import { enumerateModelEntries } from '../providers/model-types.js'
import { resolveCliContext } from './context.js'

export interface ModelsListOptions {
  settingsPath: string
}

interface ModelRow {
  provider: string
  modelKey: string
  upstreamModel: string
  aliases: string[]
  flat: boolean
  ids: string[]
  limit: ModelRouteConfig['limit']
}

function collectRows(settings: Settings): ModelRow[] {
  return enumerateModelEntries(settings).map((entry) => ({
    provider: entry.providerName,
    modelKey: entry.modelKey,
    upstreamModel: entry.upstreamModel,
    aliases: entry.aliases,
    flat: entry.flat,
    ids: entry.ids,
    limit: entry.limit ?? undefined,
  }))
}

export function formatLimitNum(value: number | undefined): string {
  if (value === undefined) return '-'
  if (value === 0) return '0'
  if (value % 1_048_576 === 0) return `${value / 1_048_576}M`
  if (value % 1024 === 0) return `${value / 1024}K`
  return String(value)
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
    context: string
    input: string
    output: string
  }

  const displayRows: DisplayRow[] = rows.flatMap((r) =>
    r.ids.map((id) => ({
      id,
      provider: r.provider,
      upstreamModel: r.upstreamModel,
      context: formatLimitNum(r.limit?.context),
      input: formatLimitNum(r.limit?.input),
      output: formatLimitNum(r.limit?.output),
    })),
  )

  const colDefs: Array<{ key: keyof DisplayRow; header: string; align: 'left' | 'right' }> = [
    { key: 'id', header: 'ID', align: 'left' },
    { key: 'provider', header: 'Provider', align: 'left' },
    { key: 'upstreamModel', header: 'Upstream Model', align: 'left' },
    { key: 'context', header: 'Context', align: 'right' },
    { key: 'input', header: 'Input', align: 'right' },
    { key: 'output', header: 'Output', align: 'right' },
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

  const pad = (value: string, col: (typeof colDefs)[number]): string => {
    const width = w(col.key)
    return col.align === 'right' ? value.padStart(width) : value.padEnd(width)
  }

  const sep = colDefs.map((c) => '─'.repeat(w(c.key))).join('  ')
  const headerLine = colDefs.map((c) => c.header.padEnd(w(c.key))).join('  ')

  console.log(headerLine)
  console.log(sep)

  for (const row of displayRows) {
    const line = colDefs.map((c) => pad(String(row[c.key]), c)).join('  ')
    console.log(line)
  }
}

export async function runModelsList(options: ModelsListOptions): Promise<void> {
  const { settingsPath } = options
  const settings = await loadSettingsFromFile(settingsPath)

  if (Object.keys(settings.providers).length === 0) {
    console.log('No providers configured in settings.')
    return
  }

  const rows = collectRows(settings)
  formatTable(rows)
}

export function createModelsListCommand(): Command {
  return new Command('list')
    .description('Display all configured models from settings')
    .action(async () => {
      const { settingsPath } = resolveCliContext()
      await runModelsList({ settingsPath })
    })
}
