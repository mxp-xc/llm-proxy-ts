import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod/v3'
import { codexModelInfoSchema, type CodexModelInfo, type CodexModelOverride, type Settings } from '../config.js'
import { isFlatLookupEnabled } from '../config-helpers.js'
import type { ModelLimit } from '../providers/model-types.js'

const execFileAsync = promisify(execFile)

const codexCatalogSchema = z.object({
  models: z.array(codexModelInfoSchema),
})

export type CodexCatalogFetcher = () => Promise<string>

let cachedCatalog: Map<string, CodexModelInfo> | null = null
let inflight: Promise<Map<string, CodexModelInfo>> | null = null

async function defaultFetcher(): Promise<string> {
  const { stdout } = await execFileAsync('codex', ['debug', 'models', '--bundled'])
  return stdout
}

/** 懒加载获取 codex bundled catalog,按 slug 索引缓存;并发请求去重 */
export async function fetchCodexBundledCatalog(
  fetcher: CodexCatalogFetcher = defaultFetcher,
): Promise<Map<string, CodexModelInfo>> {
  if (cachedCatalog) return cachedCatalog
  if (inflight) return inflight
  inflight = (async () => {
    const stdout = await fetcher()
    const parsed = codexCatalogSchema.parse(JSON.parse(stdout))
    const map = new Map<string, CodexModelInfo>()
    for (const [index, m] of parsed.models.entries()) {
      if (!m.slug) throw new Error(`codex catalog entry at index ${index} has empty slug`)
      map.set(m.slug, m)
    }
    cachedCatalog = map
    return map
  })()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

/** 测试用:重置模块级缓存 */
export function __resetCodexCatalogCacheForTest(): void {
  cachedCatalog = null
  inflight = null
}

interface ModelEntry {
  id: string
  providerName: string
  modelKey: string
  limit: ModelLimit | undefined
}

function enumerateModelEntries(settings: Settings): ModelEntry[] {
  const entries: ModelEntry[] = []
  for (const [providerName, provider] of Object.entries(settings.providers)) {
    const flatEnabled = isFlatLookupEnabled(provider, settings)
    for (const [modelKey, model] of Object.entries(provider.models)) {
      entries.push({ id: `${providerName}/${modelKey}`, providerName, modelKey, limit: model.limit })
      if (flatEnabled) {
        entries.push({ id: modelKey, providerName, modelKey, limit: model.limit })
        for (const alias of model.aliases) {
          entries.push({ id: alias, providerName, modelKey, limit: model.limit })
        }
      }
    }
  }
  return entries
}

function applyOverride(base: CodexModelInfo, override: NonNullable<CodexModelOverride>): CodexModelInfo {
  const filtered = Object.fromEntries(
    Object.entries(override).filter(
      ([k, v]) => k !== 'templateSlug' && k !== 'slug' && k !== 'context_window' && v !== undefined,
    ),
  )
  return { ...base, ...filtered } as CodexModelInfo
}

function resolveTemplateSlug(settings: Settings, entry: ModelEntry): string {
  const provider = settings.providers[entry.providerName]
  const model = provider?.models[entry.modelKey]
  return (
    model?.codex?.templateSlug ??
    provider?.options?.codex?.templateSlug ??
    settings.codex.templateSlug
  )
}

/** context_window 4 层覆盖:limit.context 缺失时的 fallback */
function resolveContextWindow(settings: Settings, entry: ModelEntry): number {
  const provider = settings.providers[entry.providerName]
  const model = provider?.models[entry.modelKey]
  return (
    model?.codex?.context_window ??
    provider?.options?.codex?.context_window ??
    settings.codex.context_window
  )
}

/** 遍历 listModels id,按 4 层合并生成 codex ModelInfo[] */
export function buildCodexModelsResponse(
  settings: Settings,
  catalog: Map<string, CodexModelInfo>,
): { models: CodexModelInfo[] } {
  const models: CodexModelInfo[] = []
  for (const entry of enumerateModelEntries(settings)) {
    const provider = settings.providers[entry.providerName]
    const model = provider?.models[entry.modelKey]
    const templateSlug = resolveTemplateSlug(settings, entry)
    const template = catalog.get(templateSlug)
    if (!template) {
      throw new Error(`codex template slug not in catalog: ${templateSlug}`)
    }

    // 1. 基底 = template
    let info: CodexModelInfo = { ...template }
    // 2. settings 推导默认(slug 固定)
    info.slug = entry.id
    info.display_name = entry.id
    const contextWindow = entry.limit?.context ?? resolveContextWindow(settings, entry)
    info.context_window = contextWindow
    info.max_context_window = contextWindow
    info.visibility = 'list'
    info.supported_in_api = true
    info.priority = 0
    info.experimental_supported_tools = []
    // 3. 三层覆盖 global → provider → model
    info = applyOverride(info, settings.codex)
    if (provider?.options?.codex) info = applyOverride(info, provider.options.codex)
    if (model?.codex) info = applyOverride(info, model.codex)

    models.push(info)
  }
  return { models }
}
