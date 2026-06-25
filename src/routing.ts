import type { ProviderConfig, Settings } from './config.js'
import { isFlatLookupEnabled } from './config-helpers.js'
import { enumerateModelEntries } from './providers/model-types.js'
import type { PluginRegistry, ResolvedPlugin } from './plugins/registry.js'
import { getBuiltInPlugin } from './plugins/loader.js'

export interface RouteMatch {
  providerName: string
  provider: ProviderConfig
  modelKey: string
  modelSelector: string
  upstreamModel: string
  headers: Record<string, string>
  resolvedPlugins: ResolvedPlugin[]
}

export class RoutingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly selector: string,
    message: string,
  ) {
    super(message)
  }

  toResponse(): { error: { type: string; code: string; message: string; selector: string } } {
    return {
      error: {
        type: 'routing_error',
        code: this.code,
        message: this.message,
        selector: this.selector,
      },
    }
  }
}

export class RoutingTable {
  private constructor(
    private readonly settings: Settings,
    private readonly flatRoutes: Map<string, RouteMatch>,
    private readonly pluginRegistry?: PluginRegistry,
  ) {}

  static fromSettings(settings: Settings, pluginRegistry?: PluginRegistry): RoutingTable {
    const flatRoutes = new Map<string, RouteMatch>()

    // 复用共享枚举核心 enumerateModelEntries —— 与 listModels/collectRows/buildCodexModelsResponse
    // 共享同一 (provider, modelKey, flat, aliases) 视图。route 按 (provider, modelKey) 构建;
    // flat 选择器(modelKey + aliases)写入 flatRoutes 并做 ambiguous 检测。
    for (const entry of enumerateModelEntries(settings)) {
      const provider = settings.providers[entry.providerName]
      if (!provider) continue
      const route = buildRoute(
        entry.providerName,
        provider,
        entry.modelKey,
        `${entry.providerName}/${entry.modelKey}`,
        pluginRegistry,
      )

      if (entry.flat) {
        for (const selector of [entry.modelKey, ...entry.aliases]) {
          if (flatRoutes.has(selector)) {
            throw new Error(`ambiguous flat route '${selector}' is configured`)
          }
          flatRoutes.set(selector, route)
        }
      }
    }

    return new RoutingTable(settings, flatRoutes, pluginRegistry)
  }

  resolve(selector: string): RouteMatch {
    if (Object.keys(this.settings.providers).length === 0) {
      throw new RoutingError(
        404,
        'no_providers_configured',
        selector,
        'No upstream providers are configured',
      )
    }

    if (!selector.includes('/')) {
      const anyFlatEnabled = Object.values(this.settings.providers).some((p) =>
        isFlatLookupEnabled(p, this.settings),
      )

      if (!anyFlatEnabled) {
        throw new RoutingError(
          404,
          'flat_lookup_disabled',
          selector,
          'Flat model lookup is disabled',
        )
      }

      const route = this.flatRoutes.get(selector)
      if (!route) {
        throw new RoutingError(
          404,
          'unknown_model',
          selector,
          'No model route matched requested model selector',
        )
      }
      return route
    }

    if (selector.split('/').length !== 2) {
      throw new RoutingError(
        404,
        'unknown_model',
        selector,
        'Model selector must use configured provider/model routing',
      )
    }

    const [providerName, requestedModel] = selector.split('/') as [string, string]
    const provider = this.settings.providers[providerName]
    if (!provider) {
      throw new RoutingError(
        404,
        'unknown_provider',
        selector,
        'No provider matched requested model selector',
      )
    }

    if (provider.models[requestedModel]) {
      return buildRoute(providerName, provider, requestedModel, selector, this.pluginRegistry)
    }

    for (const [modelKey, model] of Object.entries(provider.models)) {
      if (model.aliases.includes(requestedModel)) {
        return buildRoute(providerName, provider, modelKey, selector, this.pluginRegistry)
      }
    }

    throw new RoutingError(
      404,
      'unknown_model',
      selector,
      'No model route matched requested model selector',
    )
  }
}

function buildRoute(
  providerName: string,
  provider: ProviderConfig,
  modelKey: string,
  modelSelector: string,
  pluginRegistry?: PluginRegistry,
): RouteMatch {
  const model = provider.models[modelKey]
  if (!model) {
    throw new Error(`Missing model route '${modelKey}'`)
  }

  // 获取管道插件链（provider 级优先 → 全局级）
  let resolvedPlugins: ResolvedPlugin[]
  if (pluginRegistry) {
    resolvedPlugins = pluginRegistry.getPipelinePlugins(providerName, modelKey)
  } else {
    // 无 PluginRegistry 时，按名解析内置插件（保持向后兼容）
    resolvedPlugins = resolveBuiltinPlugins(provider, model)
  }

  return {
    providerName,
    provider,
    modelKey,
    modelSelector,
    upstreamModel: model.upstreamModel,
    headers: { ...provider.headers, ...model.headers },
    resolvedPlugins,
  }
}

/** 无 PluginRegistry 时，按名解析内置插件 */
function resolveBuiltinPlugins(
  provider: ProviderConfig,
  model: { plugins: ProviderConfig['plugins'] },
): ResolvedPlugin[] {
  const entries = [...provider.plugins, ...model.plugins]
  const mergeMap = new Map<string, ResolvedPlugin>()

  for (const entry of entries) {
    if (entry.name && !entry.module) {
      const plugin = getBuiltInPlugin(entry.name)
      if (plugin) {
        mergeMap.set(entry.name, {
          plugin,
          config: entry.config,
          providers: [],
        })
      }
    }
  }

  return [...mergeMap.values()]
}
