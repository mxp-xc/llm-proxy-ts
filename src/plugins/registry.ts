import type { PluginStore } from './types.js'
import { PluginHookError } from './types.js'
import type {
  Plugin,
  ProxyPlugin,
  AuthPlugin,
  PluginInitContext,
  ProviderContext,
  DiscoveredModelList,
  ResolvedPlugin,
} from './types.js'
import type { PluginEntry, ScopedPluginEntry, Settings } from '../config.js'
import { loadPlugin } from './loader.js'
import { noopLogger } from '../types.js'
import type { Logger } from '../types.js'
import { createPluginStore } from './store-adapter.js'

// ─── Re-exports ───────────────────────────────────────────────────

export type { ResolvedPlugin } from './types.js'

// ─── Plugin constraint validation ────────────────────────────────

/**
 * Validate plugin constraint rules against a loaded plugin list and settings.
 *
 * This is a pure function that can be tested independently of `fromSettings`.
 * It checks:
 * 1. Auth plugins at global level must not target providers with oauth configured
 * 2. Auth plugins are not allowed at provider level
 * 3. Auth plugins are not allowed at model level
 *
 * @param globalPlugins - Resolved plugins from the global `settings.plugins` array
 * @param providerPlugins - Resolved plugins keyed by provider ID
 * @param modelPlugins - Resolved plugins keyed by provider ID then model key
 * @param settings - The full Settings object (used for oauth conflict check)
 * @throws Error if any constraint is violated
 */
export function validatePluginConstraints(
  globalPlugins: ResolvedPlugin[],
  providerPlugins: Map<string, ResolvedPlugin[]>,
  modelPlugins: Map<string, Map<string, ResolvedPlugin[]>>,
  settings: Settings,
): void {
  // 1. Global auth plugins must not target providers with oauth
  for (const rp of globalPlugins) {
    if (isAuthPlugin(rp.plugin)) {
      if (rp.providers.length === 0) {
        throw new Error(
          `Auth plugin '${rp.plugin.name}' must target at least one provider via providers`,
        )
      }
      for (const providerId of rp.providers) {
        const provider = settings.providers[providerId]
        if (provider?.oauth) {
          throw new Error(
            `Provider '${providerId}' cannot have both oauth and auth plugin '${rp.plugin.name}'; use one or the other`,
          )
        }
      }
    }
  }

  // 2. Provider level must not contain AuthPlugin
  for (const [_providerId, plugins] of providerPlugins) {
    for (const rp of plugins) {
      if (isAuthPlugin(rp.plugin)) {
        throw new Error(
          `Auth plugin '${rp.plugin.name}' cannot be configured at provider level; configure it in global plugins instead`,
        )
      }
    }
  }

  // 3. Model level must not contain AuthPlugin
  for (const [_providerId, modelMap] of modelPlugins) {
    for (const [_modelKey, plugins] of modelMap) {
      for (const rp of plugins) {
        if (isAuthPlugin(rp.plugin)) {
          throw new Error(
            `Auth plugin '${rp.plugin.name}' cannot be configured at model level; configure it in global plugins instead`,
          )
        }
      }
    }
  }
}

// ─── PluginRegistry ──────────────────────────────────────────────

export interface AuthFetchRegistry {
  createAuthFetch(
    providerId: string,
    logger?: Logger,
    authFilePath?: string,
  ): Promise<((baseFetch?: typeof fetch) => typeof fetch) | undefined>
}

export interface PipelinePluginRegistry {
  getPipelinePlugins(providerId: string, modelKey: string): ResolvedPlugin[]
}

async function loadResolvedPlugin(
  entry: PluginEntry | ScopedPluginEntry,
  settingsDir: string,
  providers: string[],
  log: Logger,
  logPayload: Record<string, unknown>,
  message: string,
): Promise<ResolvedPlugin> {
  const { plugin, modulePath } = await loadPlugin(entry, settingsDir)
  const rp: ResolvedPlugin = {
    plugin,
    config: entry.config,
    providers,
    ...(modulePath !== undefined ? { modulePath } : {}),
  }
  log.info({ plugin: plugin.name, module: modulePath, ...logPayload }, message)
  return rp
}

export class PluginRegistry {
  private readonly allResolvedCache: ResolvedPlugin[]

  private constructor(
    private readonly globalPlugins: ResolvedPlugin[],
    private readonly providerPlugins: Map<string, ResolvedPlugin[]>,
    private readonly modelPlugins: Map<string, Map<string, ResolvedPlugin[]>>,
    private readonly settings: Settings,
  ) {
    this.allResolvedCache = this.computeAllResolved()
  }

  /**
   * 从 Settings 加载所有插件。
   *
   * 全局 plugins 支持 Plugin/ProxyPlugin/AuthPlugin。
   * Provider 级 plugins 仅允许 ProxyPlugin。
   */
  static async fromSettings(
    settings: Settings,
    settingsDir: string,
    logger?: Logger,
  ): Promise<PluginRegistry> {
    const log = logger ?? noopLogger

    // 1. 加载全局插件（并行）
    const globalPlugins = await Promise.all(
      settings.plugins.map((entry) =>
        loadResolvedPlugin(
          entry,
          settingsDir,
          entry.providers,
          log,
          { providers: entry.providers },
          'global plugin loaded',
        ),
      ),
    )

    // 2. 加载 provider 级插件（provider 间并行，provider 内并行）
    const providerPlugins = new Map<string, ResolvedPlugin[]>()
    const providerResults = await Promise.all(
      Object.entries(settings.providers).map(async ([providerId, provider]) => {
        const resolved = await Promise.all(
          provider.plugins.map((entry) =>
            loadResolvedPlugin(
              entry,
              settingsDir,
              [providerId],
              log,
              { provider: providerId },
              'provider plugin loaded',
            ),
          ),
        )
        return [providerId, resolved] as const
      }),
    )
    for (const [providerId, resolved] of providerResults) {
      if (resolved.length > 0) {
        providerPlugins.set(providerId, resolved)
      }
    }

    // 3. 加载 model 级插件（provider/model/entry 三层并行）
    const modelPlugins = new Map<string, Map<string, ResolvedPlugin[]>>()
    const modelResults = await Promise.all(
      Object.entries(settings.providers).map(async ([providerId, provider]) => {
        const modelEntries = await Promise.all(
          Object.entries(provider.models).map(async ([modelKey, modelConfig]) => {
            const resolved: ResolvedPlugin[] = []
            if (modelConfig.plugins && modelConfig.plugins.length > 0) {
              const loaded = await Promise.all(
                modelConfig.plugins.map((entry) =>
                  loadResolvedPlugin(
                    entry,
                    settingsDir,
                    [providerId],
                    log,
                    { provider: providerId, model: modelKey },
                    'model plugin loaded',
                  ),
                ),
              )
              resolved.push(...loaded)
            }
            return [modelKey, resolved] as const
          }),
        )
        return [providerId, modelEntries] as const
      }),
    )
    for (const [providerId, modelEntries] of modelResults) {
      const inner = new Map<string, ResolvedPlugin[]>()
      for (const [modelKey, resolved] of modelEntries) {
        if (resolved.length > 0) {
          inner.set(modelKey, resolved)
        }
      }
      if (inner.size > 0) {
        modelPlugins.set(providerId, inner)
      }
    }

    // 4. 校验约束
    validatePluginConstraints(globalPlugins, providerPlugins, modelPlugins, settings)

    return new PluginRegistry(globalPlugins, providerPlugins, modelPlugins, settings)
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /** 初始化所有插件。每个插件调用一次 init()（并行，单个失败不阻塞其它）。 */
  async initAll(logger?: Logger, authFilePath?: string): Promise<void> {
    const log = logger ?? noopLogger

    const initables = filterInitable(this.allResolved())
    const results = await Promise.allSettled(
      initables.map(async (rp) => {
        const store = this.#resolveStore(authFilePath, rp)
        const ctx: PluginInitContext = {
          providers: new Map(Object.entries(this.settings.providers)),
          config: rp.config,
          store,
          log: log.child({ component: 'plugin', plugin: rp.plugin.name }),
        }
        await rp.plugin.init(ctx)
        return rp.plugin.name
      }),
    )
    for (const [index, r] of results.entries()) {
      if (r.status === 'fulfilled') {
        log.info({ plugin: r.value }, 'plugin initialized')
      } else {
        log.error({ err: r.reason, plugin: initables[index]!.plugin.name }, 'plugin init failed')
      }
    }
  }

  /** 服务监听前调用所有插件的 beforeServerStart()。 */
  async beforeServerStartAll(logger?: Logger): Promise<void> {
    const log = logger ?? noopLogger
    for (const rp of this.allResolved()) {
      if (rp.plugin.beforeServerStart) {
        try {
          await rp.plugin.beforeServerStart()
        } catch (err) {
          log.error({ err, plugin: rp.plugin.name }, 'plugin beforeServerStart failed')
          throw err
        }
      }
    }
  }

  /** 服务监听后调用所有插件的 afterServerStart()（并行，单个失败不阻塞其它）。 */
  async afterServerStartAll(logger?: Logger): Promise<void> {
    const log = logger ?? noopLogger
    const callables = filterAfterStart(this.allResolved())
    const results = await Promise.allSettled(
      callables.map(async (rp) => {
        await rp.plugin.afterServerStart()
        return rp.plugin.name
      }),
    )
    for (const [index, r] of results.entries()) {
      if (r.status === 'rejected') {
        log.error(
          { err: r.reason, plugin: callables[index]!.plugin.name },
          'plugin afterServerStart failed',
        )
      }
    }
  }

  // ─── Per-provider auth ────────────────────────────────────────

  /** 为指定 provider 创建认证 fetch wrapper。 */
  async createAuthFetch(
    providerId: string,
    logger?: Logger,
    authFilePath?: string,
  ): Promise<((baseFetch?: typeof fetch) => typeof fetch) | undefined> {
    const resolved = this.#resolveAuthPluginContext(providerId, logger, authFilePath)
    if (!resolved) return undefined
    try {
      return await resolved.rp.plugin.createFetch(resolved.ctx)
    } catch (cause) {
      throwPluginHookError(resolved.rp.plugin.name, providerId, 'createFetch', cause)
    }
  }

  /** 为指定 provider 发现模型列表。 */
  async discoverModels(
    providerId: string,
    logger?: Logger,
    authFilePath?: string,
  ): Promise<DiscoveredModelList | undefined> {
    const resolved = this.#resolveAuthPluginContext(providerId, logger, authFilePath, {
      requireDiscoverModels: true,
    })
    if (!resolved?.rp.plugin.discoverModels) return undefined
    try {
      return await resolved.rp.plugin.discoverModels(resolved.ctx)
    } catch (cause) {
      throwPluginHookError(resolved.rp.plugin.name, providerId, 'discoverModels', cause)
    }
  }

  // ─── Per-request pipeline ─────────────────────────────────────

  /**
   * 获取指定 provider（及可选 model）的管道插件链。
   * 合并策略：global → provider → model，Map.set 覆盖保证 model 级同名插件优先。
   */
  getPipelinePlugins(providerId: string, modelKey?: string): ResolvedPlugin[] {
    // 全局级只包含 ProxyPlugin
    const globalLevel = this.globalPlugins.filter(
      (rp) =>
        isProxyPlugin(rp.plugin) &&
        (rp.providers.length === 0 || rp.providers.includes(providerId)),
    )
    const providerLevel = this.providerPlugins.get(providerId) ?? []
    const modelLevel =
      (modelKey ? this.modelPlugins.get(providerId)?.get(modelKey) : undefined) ?? []

    // Merge: global → provider → model, Map.set overwrites so model wins for same-name
    const mergeMap = new Map<string, ResolvedPlugin>()
    for (const rp of globalLevel) {
      mergeMap.set(rp.plugin.name, rp)
    }
    for (const rp of providerLevel) {
      mergeMap.set(rp.plugin.name, rp)
    }
    for (const rp of modelLevel) {
      mergeMap.set(rp.plugin.name, rp)
    }
    return [...mergeMap.values()]
  }

  // ─── Helpers ──────────────────────────────────────────────────

  #resolveStore(authFilePath: string | undefined, rp: ResolvedPlugin): PluginStore {
    return authFilePath ? createPluginStore(authFilePath, rp.plugin.name) : noopStore
  }

  #resolveAuthPluginContext(
    providerId: string,
    logger?: Logger,
    authFilePath?: string,
    options: { requireDiscoverModels?: boolean } = {},
  ): { rp: ResolvedPlugin & { plugin: AuthPlugin }; ctx: ProviderContext } | undefined {
    const log = logger ?? noopLogger

    for (const rp of this.globalPlugins) {
      if (!isAuthPlugin(rp.plugin)) continue
      if (!rp.providers.includes(providerId)) continue
      if (options.requireDiscoverModels && !rp.plugin.discoverModels) continue

      const provider = this.settings.providers[providerId]
      if (!provider) continue

      const store = this.#resolveStore(authFilePath, rp)
      return {
        rp: rp as ResolvedPlugin & { plugin: AuthPlugin },
        ctx: {
          id: providerId,
          provider,
          config: rp.config,
          store,
          log: log.child({
            component: 'auth-plugin',
            plugin: rp.plugin.name,
            provider: providerId,
          }),
        },
      }
    }
    return undefined
  }

  private allResolved(): ResolvedPlugin[] {
    return this.allResolvedCache
  }

  private computeAllResolved(): ResolvedPlugin[] {
    const seen = new Set<Plugin>()
    const result: ResolvedPlugin[] = []

    for (const rp of this.globalPlugins) {
      if (!seen.has(rp.plugin)) {
        seen.add(rp.plugin)
        result.push(rp)
      }
    }
    for (const rps of this.providerPlugins.values()) {
      for (const rp of rps) {
        if (!seen.has(rp.plugin)) {
          seen.add(rp.plugin)
          result.push(rp)
        }
      }
    }
    for (const modelMap of this.modelPlugins.values()) {
      for (const rps of modelMap.values()) {
        for (const rp of rps) {
          if (!seen.has(rp.plugin)) {
            seen.add(rp.plugin)
            result.push(rp)
          }
        }
      }
    }
    return result
  }
}

function throwPluginHookError(
  plugin: string,
  provider: string,
  hook: 'createFetch' | 'discoverModels',
  cause: unknown,
): never {
  if (cause instanceof PluginHookError) throw cause
  throw new PluginHookError(plugin, provider, hook, cause)
}

// ─── Type guards ─────────────────────────────────────────────────

function isAuthPlugin(plugin: Plugin): plugin is AuthPlugin {
  return typeof (plugin as AuthPlugin).createFetch === 'function'
}

/** 筛选带 `init` 的插件，将元素类型收窄为带 `NonNullable<init>` 的 ResolvedPlugin。 */
function filterInitable(
  rps: ResolvedPlugin[],
): Array<ResolvedPlugin & { plugin: { init: NonNullable<Plugin['init']> } }> {
  return rps.filter(
    (rp): rp is ResolvedPlugin & { plugin: { init: NonNullable<Plugin['init']> } } =>
      rp.plugin.init !== undefined,
  )
}

/** 筛选带 `afterServerStart` 的插件，将元素类型收窄为带 `NonNullable<afterServerStart>` 的 ResolvedPlugin。 */
function filterAfterStart(
  rps: ResolvedPlugin[],
): Array<
  ResolvedPlugin & { plugin: { afterServerStart: NonNullable<Plugin['afterServerStart']> } }
> {
  return rps.filter(
    (
      rp,
    ): rp is ResolvedPlugin & {
      plugin: { afterServerStart: NonNullable<Plugin['afterServerStart']> }
    } => rp.plugin.afterServerStart !== undefined,
  )
}

function isProxyPlugin(plugin: Plugin): plugin is ProxyPlugin {
  return typeof (plugin as ProxyPlugin).inspectStreamChunk === 'function'
}

// ─── No-op defaults ──────────────────────────────────────────────

const noopStore: PluginStore = {
  async get() {
    return {}
  },
  async set() {},
}
