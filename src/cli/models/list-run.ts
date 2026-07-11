import { loadSettingsFromFile } from '../../config.js'
import type { AliasEntry, ModelRouteConfig, Settings } from '../../config.js'
import { enumerateModelEntries } from '../../providers/model-types.js'

export interface ModelsListOptions {
  settingsPath: string
}

export interface ModelRow {
  id: string
  provider: string
  upstreamModel: string
  aliases: AliasEntry[]
  modelFlat: boolean
  limit: ModelRouteConfig['limit']
}

function collectRows(settings: Settings): ModelRow[] {
  const providerOrder = new Map(Object.keys(settings.providers).map((name, index) => [name, index]))
  const rowsById = new Map<
    string,
    ModelRow & { order: number; providerOrder: number; usesFlatId: boolean }
  >()
  let order = 0
  for (const entry of enumerateModelEntries(settings)) {
    for (const id of entry.ids) {
      const row = {
        id,
        provider: entry.providerName,
        upstreamModel: entry.upstreamModel,
        aliases: entry.aliases,
        modelFlat: entry.modelFlat,
        limit: entry.limit,
        order: order++,
        providerOrder: providerOrder.get(entry.providerName) ?? Number.MAX_SAFE_INTEGER,
        usesFlatId: !id.includes('/'),
      }
      rowsById.delete(id)
      rowsById.set(id, row)
    }
  }
  return [...rowsById.values()]
    .sort(
      (a, b) =>
        a.providerOrder - b.providerOrder ||
        Number(a.usesFlatId) - Number(b.usesFlatId) ||
        a.order - b.order,
    )
    .map(({ order: _order, providerOrder: _providerOrder, usesFlatId: _usesFlatId, ...row }) => row)
}

export function formatLimitNum(value: number | undefined): string {
  if (value === undefined) return '-'
  if (value === 0) return '0'
  if (value >= 1_000_000) return `${Math.floor(value / 1_000_000)}M`
  if (value >= 1000) return `${Math.floor(value / 1000)}K`
  return String(value)
}

const ROW_COL_DEFS = [
  { key: 'id', header: 'ID', align: 'left' as const },
  { key: 'provider', header: 'Provider', align: 'left' as const },
  { key: 'upstreamModel', header: 'Upstream Model', align: 'left' as const },
  { key: 'aliases', header: 'Aliases', align: 'left' as const },
  { key: 'context', header: 'Context', align: 'right' as const },
  { key: 'input', header: 'Input', align: 'right' as const },
  { key: 'output', header: 'Output', align: 'right' as const },
]

interface Prepared {
  single: Record<string, string>
  aliasLines: string[]
  H: number
}

function prepare(rows: ModelRow[]): Prepared[] {
  return rows.map((r) => {
    const single: Record<string, string> = {
      id: r.id,
      provider: r.provider,
      upstreamModel: r.upstreamModel,
      context: formatLimitNum(r.limit?.context),
      input: formatLimitNum(r.limit?.input),
      output: formatLimitNum(r.limit?.output),
    }
    const aliasLines =
      r.aliases.length === 0
        ? ['-']
        : r.aliases.map((a) => (r.modelFlat || a.flat ? `${a.name} *` : a.name))
    return { single, aliasLines, H: Math.max(1, r.aliases.length) }
  })
}

export function renderRows(rows: ModelRow[]): string[] {
  const lines: string[] = []
  if (rows.length === 0) return lines

  const prepared = prepare(rows)
  const widths = new Map<string, number>()
  for (const col of ROW_COL_DEFS) {
    let max = col.header.length
    for (const p of prepared) {
      if (col.key === 'aliases') {
        max = Math.max(max, ...p.aliasLines.map((t) => t.length))
      } else {
        max = Math.max(max, (p.single[col.key] ?? '').length)
      }
    }
    widths.set(col.key, max)
  }

  const pad = (value: string, col: (typeof ROW_COL_DEFS)[number]): string => {
    const width = widths.get(col.key) ?? 0
    return col.align === 'right' ? value.padStart(width) : value.padEnd(width)
  }

  lines.push(ROW_COL_DEFS.map((c) => c.header.padEnd(widths.get(c.key) ?? 0)).join('  '))
  lines.push(ROW_COL_DEFS.map((c) => '─'.repeat(widths.get(c.key) ?? 0)).join('  '))

  for (const p of prepared) {
    const top = Math.floor((p.H - 1) / 2) // 单值列垂直居中行
    for (let i = 0; i < p.H; i++) {
      lines.push(
        ROW_COL_DEFS.map((c) => {
          if (c.key === 'aliases') return pad(p.aliasLines[i] ?? '', c)
          return pad(i === top ? (p.single[c.key] ?? '') : '', c)
        }).join('  '),
      )
    }
  }
  return lines
}

function formatTable(rows: ModelRow[]): void {
  if (rows.length === 0) {
    console.log('No models configured in settings.')
    return
  }
  for (const line of renderRows(rows)) console.log(line)
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
