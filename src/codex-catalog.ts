import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod/v3'
import { codexModelInfoSchema, type CodexModelInfo, type CodexModelOverride } from './codex-types.js'
import type { Settings } from './config.js'
import { enumerateModelEntries, type ModelEntry } from './providers/model-types.js'

const execFileAsync = promisify(execFile)

const codexCatalogSchema = z.object({
  models: z.array(codexModelInfoSchema),
})

export type CodexCatalogFetcher = () => Promise<string>

async function defaultFetcher(): Promise<string> {
  const { stdout } = await execFileAsync('codex', ['debug', 'models', '--bundled'], {
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

/**
 * Codex bundled catalog 缓存。构造时绑定 fetcher,`get()` 封装懒加载 + 并发去重。
 * 进程级共享(在 createApp 作用域 new 一次),无模块级可变状态。
 */
export class CodexCatalogCache {
  private cached: Map<string, CodexModelInfo> | null = null
  private inflight: Promise<Map<string, CodexModelInfo>> | null = null

  constructor(private readonly fetcher: CodexCatalogFetcher = defaultFetcher) {}

  async get(): Promise<Map<string, CodexModelInfo>> {
    if (this.cached) return this.cached
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      const stdout = await this.fetcher()
      const parsed = codexCatalogSchema.parse(JSON.parse(stdout))
      const map = new Map<string, CodexModelInfo>()
      for (const [index, m] of parsed.models.entries()) {
        if (!m.slug) throw new Error(`codex catalog entry at index ${index} has empty slug`)
        map.set(m.slug, m)
      }
      this.cached = map
      return map
    })()
    try {
      return await this.inflight
    } finally {
      this.inflight = null
    }
  }
}

function applyOverride(base: CodexModelInfo, override: NonNullable<CodexModelOverride>): CodexModelInfo {
  const filtered = Object.fromEntries(
    Object.entries(override).filter(
      ([k, v]) =>
        k !== 'templateSlug' &&
        k !== 'slug' &&
        k !== 'context_window' &&
        k !== 'max_context_window' &&
        v !== undefined,
    ),
  )
  return { ...base, ...filtered } as CodexModelInfo
}

function resolveTemplateSlug(settings: Settings, entry: ModelEntry): string | undefined {
  const provider = settings.providers[entry.providerName]
  const model = provider?.models[entry.modelKey]
  return (
    model?.codex?.templateSlug ??
    provider?.options?.codex?.templateSlug ??
    settings.codex.models_catalog.templateSlug
  )
}

/** context_window 4 层覆盖:limit.context 缺失时的 fallback */
function resolveContextWindow(settings: Settings, entry: ModelEntry): number {
  const provider = settings.providers[entry.providerName]
  const model = provider?.models[entry.modelKey]
  return (
    model?.codex?.context_window ??
    provider?.options?.codex?.context_window ??
    settings.codex.models_catalog.context_window
  )
}

/** reasoning_effort 2 层逐字段合并（provider → model，各取最具体非 undefined 值） */
function resolveReasoningEffort(
  settings: Settings,
  entry: ModelEntry,
): { default: string; supported: string[] } | undefined {
  const provider = settings.providers[entry.providerName]
  const model = provider?.models[entry.modelKey]
  const providerEffort = provider?.options?.reasoning_effort
  const modelEffort = model?.reasoning_effort
  const defaultEffort = modelEffort?.default ?? providerEffort?.default
  const supportedEfforts = modelEffort?.supported ?? providerEffort?.supported
  if (defaultEffort === undefined && supportedEfforts === undefined) return undefined
  // At least one is defined; fill the other with a sentinel that callers skip
  return {
    default: defaultEffort ?? '',
    supported: supportedEfforts ?? [],
  }
}

/**
 * 收集 catalog 全局 effort → description 映射，用于补全新建 reasoning level 的描述。
 * codex 解析 model_catalog_json 时要求 supported_reasoning_levels 每个条目都带 description。
 */
function collectEffortDescriptions(catalog: Map<string, CodexModelInfo>): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of catalog.values()) {
    for (const l of m.supported_reasoning_levels) {
      if (l.description && !map.has(l.effort)) map.set(l.effort, l.description)
    }
  }
  return map
}

/**
 * 将用户配置的 effort 字符串数组映射为 codex catalog 的 supported_reasoning_levels。
 * 优先复用 template 中同 effort 条目（保留 description）；次复用 catalog 全局
 * effort→description 映射；无则兜底默认描述（codex 要求 description 必填）。
 */
function mergeSupportedLevels(
  template: CodexModelInfo['supported_reasoning_levels'],
  efforts: string[],
  descriptions: Map<string, string>,
): CodexModelInfo['supported_reasoning_levels'] {
  const byEffort = new Map(template.map((l) => [l.effort, l]))
  return efforts.map((effort) => {
    const existing = byEffort.get(effort)
    if (existing) return existing
    return { effort, description: descriptions.get(effort) ?? `Reasoning effort: ${effort}` }
  })
}

const FALLBACK_DEFAULT_SLUG = 'gpt-5.4'

/** 全层未配 templateSlug 时,动态取 catalog 首个 supported_in_api 的 slug;无则兜底 */
function pickDefaultTemplateSlug(catalog: Map<string, CodexModelInfo>): string {
  for (const m of catalog.values()) {
    if (m.supported_in_api) return m.slug
  }
  return FALLBACK_DEFAULT_SLUG
}

/** 遍历 listModels id,按 4 层合并生成 codex ModelInfo[] */
export function buildCodexModelsResponse(
  settings: Settings,
  catalog: Map<string, CodexModelInfo>,
): { models: CodexModelInfo[] } {
  const models: CodexModelInfo[] = []
  const defaultSlug = pickDefaultTemplateSlug(catalog)
  const effortDescriptions = collectEffortDescriptions(catalog)
  for (const entry of enumerateModelEntries(settings)) {
    const provider = settings.providers[entry.providerName]
    const model = provider?.models[entry.modelKey]
    const templateSlug = resolveTemplateSlug(settings, entry) ?? defaultSlug
    const template = catalog.get(templateSlug)
    if (!template) {
      throw new Error(`codex template slug not in catalog: ${templateSlug}`)
    }
    const contextWindow = entry.limit?.context ?? resolveContextWindow(settings, entry)

    // 每个 id 生成一条独立的 ModelInfo(template/overrides 在 id 间不共享可变状态)
    for (const id of entry.ids) {
      // 1. 基底 = template
      let info: CodexModelInfo = { ...template }
      // 2. settings 推导默认(slug 固定 = id)
      info.slug = id
      info.display_name = id
      info.context_window = contextWindow
      info.max_context_window = contextWindow
      info.visibility = 'list'
      info.supported_in_api = true
      info.priority = 0
      info.experimental_supported_tools = []
      // 3. reasoning_effort（模型属性，2 层）→ catalog 的 default_reasoning_level / supported_reasoning_levels
      const effort = resolveReasoningEffort(settings, entry)
      if (effort && effort.default !== '') info.default_reasoning_level = effort.default
      if (effort && effort.supported.length > 0) {
        info.supported_reasoning_levels = mergeSupportedLevels(
          template.supported_reasoning_levels,
          effort.supported,
          effortDescriptions,
        )
      }
      // 4. 三层 catalog override（escape hatch，应用顺序在后，覆盖 reasoning_effort）
      info = applyOverride(info, settings.codex.models_catalog)
      if (provider?.options?.codex) info = applyOverride(info, provider.options.codex)
      if (model?.codex) info = applyOverride(info, model.codex)

      models.push(info)
    }
  }
  return { models }
}
