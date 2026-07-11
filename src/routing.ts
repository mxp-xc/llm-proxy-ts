import type { ProviderConfig, Settings } from './config.js'
import { enumerateModelEntries } from './providers/model-types.js'
import type { PipelinePluginRegistry, ResolvedPlugin } from './plugins/registry.js'
import { getBuiltInPlugin } from './plugins/loader.js'
import { canUseFlatModelSelector, parseModelSelector } from './model-selector.js'

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
}

export class RoutingTable {
  private constructor(
    private readonly settings: Settings,
    private readonly flatRoutes: Map<string, RouteMatch>,
    private readonly prefixedRoutes: Map<string, RouteMatch>,
  ) {}

  static fromSettings(settings: Settings, pluginRegistry?: PipelinePluginRegistry): RoutingTable {
    const flatRoutes = new Map<string, RouteMatch>()
    // 带前缀入口缓存:settings 不可变,fromSettings 时一次性构建所有 provider/model + 别名路由,
    // resolve() 带前缀分支直接 Map 查找,消除 per-request buildRoute + 线性别名扫描。
    const prefixedRoutes = new Map<string, RouteMatch>()
    // 带前缀入口唯一性检测:同 provider 内 {modelKey} ∪ {alias name} 全局唯一,跨 provider 不误报
    const prefixed = new Set<string>()

    // 复用共享枚举核心 enumerateModelEntries —— 与 listModels/collectRows/buildCodexModelsResponse
    // 共享同一 (provider, modelKey, flat, aliases) 视图。route 按 (provider, modelKey) 构建;
    // 裸名入口(modelKey + 满足条件的 aliases)写入 flatRoutes;后注册的同名入口覆盖先注册入口。
    for (const entry of enumerateModelEntries(settings)) {
      const provider = settings.providers[entry.providerName]
      if (!provider) continue
      // modelKey 对应的带前缀路由(同时被裸名入口复用)
      const route = buildRoute(
        entry.providerName,
        provider,
        entry.modelKey,
        `${entry.providerName}/${entry.modelKey}`,
        pluginRegistry,
      )

      // 带前缀入口唯一性:同 provider 内 {modelKey} ∪ {alias name} 全局唯一
      const assertPrefixedUnique = (name: string) => {
        const key = `${entry.providerName}/${name}`
        if (prefixed.has(key)) {
          throw new Error(`duplicate model selector '${name}' in provider '${entry.providerName}'`)
        }
        prefixed.add(key)
      }

      // 注册带前缀路由:modelKey 入口
      assertPrefixedUnique(entry.modelKey)
      prefixedRoutes.set(`${entry.providerName}/${entry.modelKey}`, route)
      // 每个别名一条独立路由(modelSelector 不同),复用同一 resolvedPlugins/headers
      for (const alias of entry.aliases) {
        assertPrefixedUnique(alias.name)
        prefixedRoutes.set(
          `${entry.providerName}/${alias.name}`,
          buildRoute(
            entry.providerName,
            provider,
            entry.modelKey,
            `${entry.providerName}/${alias.name}`,
            pluginRegistry,
          ),
        )
      }

      // 裸名入口注册(flatRoutes 跨 provider 全局),后配置覆盖先配置。
      const registerBare = (selector: string) => {
        if (flatRoutes.has(selector)) {
          flatRoutes.delete(selector)
        }
        flatRoutes.set(selector, route)
      }
      if (entry.modelFlat && canUseFlatModelSelector(entry.modelKey)) {
        registerBare(entry.modelKey)
      }
      for (const alias of entry.aliases) {
        if ((entry.modelFlat || alias.flat) && canUseFlatModelSelector(alias.name)) {
          registerBare(alias.name)
        }
      }
    }

    return new RoutingTable(settings, flatRoutes, prefixedRoutes)
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

    const parsedSelector = parseModelSelector(selector)
    if (parsedSelector.kind === 'flat') {
      const route = this.flatRoutes.get(parsedSelector.name)
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

    if (parsedSelector.kind === 'invalid') {
      throw new RoutingError(
        404,
        'unknown_model',
        selector,
        'Model selector must use configured provider/model routing',
      )
    }

    // 带前缀路由:fromSettings 时已预构建缓存,直接 Map 查找(命中即返回同一 RouteMatch 实例)。
    const cached = this.prefixedRoutes.get(selector)
    if (cached) {
      return cached
    }

    // 未命中缓存:区分 unknown_provider / unknown_model 以保持错误语义。
    if (!this.settings.providers[parsedSelector.provider]) {
      throw new RoutingError(
        404,
        'unknown_provider',
        selector,
        'No provider matched requested model selector',
      )
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
  pluginRegistry?: PipelinePluginRegistry,
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
