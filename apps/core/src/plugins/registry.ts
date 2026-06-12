import type { PluginStore } from './types.js'
import type {
  Plugin,
  ProxyPlugin,
  AuthPlugin,
  PluginInitContext,
  ProviderContext,
  DiscoveredModelList,
  ResolvedPlugin,
} from './types.js'
import type { PluginEntry, Settings } from '../config.js'
import { loadPlugin } from './loader.js'
import type { Logger } from '../types.js'
import { createPluginStore } from './store-adapter.js'

// ─── Re-exports ───────────────────────────────────────────────────

export type { ResolvedPlugin } from './types.js'

// ─── PluginRegistry ──────────────────────────────────────────────

export class PluginRegistry {
  private constructor(
    private readonly globalPlugins: ResolvedPlugin[],
    private readonly providerPlugins: Map<string, ResolvedPlugin[]>,
    private readonly settings: Settings,
    private readonly settingsDir: string,
  ) {}

  /**
   * 从 Settings 加载所有插件。
   *
   * 全局 plugins 支持 Plugin/ProxyPlugin/AuthPlugin。
   * Provider 级 plugins 仅允许 ProxyPlugin。
   */
  static async fromSettings(
    settings: Settings,
    settingsDir: string,
    authFilePath?: string,
    logger?: Logger,
  ): Promise<PluginRegistry> {
    const log = logger ?? noopLogger
    const globalPlugins: ResolvedPlugin[] = []
    const providerPlugins = new Map<string, ResolvedPlugin[]>()

    // 1. 加载全局插件
    for (const entry of settings.plugins) {
      const { plugin, modulePath } = await loadPlugin(entry, settingsDir)
      const rp: ResolvedPlugin = {
        plugin,
        config: entry.config,
        providers: entry.providers,
        ...(modulePath !== undefined ? { modulePath } : {}),
      }

      // 全局 auth 插件与 provider 的 oauth 互斥检查
      if (isAuthPlugin(plugin)) {
        for (const providerId of rp.providers) {
          const provider = settings.providers[providerId]
          if (provider?.oauth) {
            throw new Error(
              `Provider '${providerId}' cannot have both oauth and auth plugin '${plugin.name}'; use one or the other`,
            )
          }
        }
      }

      log.info(
        { plugin: plugin.name, module: modulePath, providers: rp.providers },
        'global plugin loaded',
      )
      globalPlugins.push(rp)
    }

    // 2. 加载 provider 级插件
    for (const [providerId, provider] of Object.entries(settings.providers)) {
      const resolved: ResolvedPlugin[] = []
      for (const entry of provider.plugins) {
        const { plugin, modulePath } = await loadPlugin(entry, settingsDir)

        // Provider 级不允许 AuthPlugin
        if (isAuthPlugin(plugin)) {
          throw new Error(
            `Auth plugin '${plugin.name}' cannot be configured at provider level; configure it in global plugins instead`,
          )
        }

        resolved.push({
          plugin,
          config: entry.config,
          providers: [providerId],
          ...(modulePath !== undefined ? { modulePath } : {}),
        })
        log.info(
          { plugin: plugin.name, module: modulePath, provider: providerId },
          'provider plugin loaded',
        )
      }
      if (resolved.length > 0) {
        providerPlugins.set(providerId, resolved)
      }
    }

    return new PluginRegistry(globalPlugins, providerPlugins, settings, settingsDir)
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  /** 初始化所有插件。每个插件调用一次 init()。 */
  async initAll(logger?: Logger, authFilePath?: string): Promise<void> {
    const log = logger ?? noopLogger

    for (const rp of this.allResolved()) {
      if (rp.plugin.init) {
        const store = this.#resolveStore(authFilePath, rp)
        const ctx: PluginInitContext = {
          providers: new Map(Object.entries(this.settings.providers)),
          config: rp.config,
          store,
          log: log.child({ component: 'plugin', plugin: rp.plugin.name }),
        }
        await rp.plugin.init(ctx)
        log.info({ plugin: rp.plugin.name }, 'plugin initialized')
      }
    }
  }

  /** 服务监听前调用所有插件的 beforeServerStart()。 */
  async beforeServerStartAll(): Promise<void> {
    for (const rp of this.allResolved()) {
      if (rp.plugin.beforeServerStart) {
        await rp.plugin.beforeServerStart()
      }
    }
  }

  /** 服务监听后调用所有插件的 afterServerStart()。 */
  async afterServerStartAll(): Promise<void> {
    for (const rp of this.allResolved()) {
      if (rp.plugin.afterServerStart) {
        await rp.plugin.afterServerStart()
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
    const log = logger ?? noopLogger

    for (const rp of this.globalPlugins) {
      if (!isAuthPlugin(rp.plugin)) continue
      if (!rp.providers.includes(providerId)) continue

      const provider = this.settings.providers[providerId]
      if (!provider) continue

      const store = this.#resolveStore(authFilePath, rp)
      const ctx: ProviderContext = {
        id: providerId,
        provider,
        config: rp.config,
        store,
        log: log.child({ component: 'auth-plugin', plugin: rp.plugin.name, provider: providerId }),
      }
      return rp.plugin.createFetch(ctx)
    }
    return undefined
  }

  /** 为指定 provider 发现模型列表。 */
  async discoverModels(
    providerId: string,
    logger?: Logger,
    authFilePath?: string,
  ): Promise<DiscoveredModelList | undefined> {
    const log = logger ?? noopLogger

    for (const rp of this.globalPlugins) {
      if (!isAuthPlugin(rp.plugin)) continue
      if (!rp.providers.includes(providerId)) continue
      if (!rp.plugin.discoverModels) continue

      const provider = this.settings.providers[providerId]
      if (!provider) continue

      const store = this.#resolveStore(authFilePath, rp)
      const ctx: ProviderContext = {
        id: providerId,
        provider,
        config: rp.config,
        store,
        log: log.child({ component: 'auth-plugin', plugin: rp.plugin.name, provider: providerId }),
      }
      return rp.plugin.discoverModels(ctx)
    }
    return undefined
  }

  // ─── Per-request pipeline ─────────────────────────────────────

  /**
   * 获取指定 provider 的管道插件链。
   * 执行顺序：provider 级优先 → 全局级（middleware chain）。
   */
  getPipelinePlugins(providerId: string): ResolvedPlugin[] {
    const providerLevel = this.providerPlugins.get(providerId) ?? []
    // 全局级只包含 ProxyPlugin
    const globalLevel = this.globalPlugins.filter((rp) => isProxyPlugin(rp.plugin))
    return [...providerLevel, ...globalLevel]
  }

  // ─── Helpers ──────────────────────────────────────────────────

  #resolveStore(authFilePath: string | undefined, rp: ResolvedPlugin): PluginStore {
    return authFilePath ? createPluginStore(authFilePath, rp.plugin.name) : noopStore
  }

  private allResolved(): ResolvedPlugin[] {
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
    return result
  }
}

// ─── Type guards ─────────────────────────────────────────────────

function isAuthPlugin(plugin: Plugin): plugin is AuthPlugin {
  return typeof (plugin as AuthPlugin).createFetch === 'function'
}

function isProxyPlugin(plugin: Plugin): plugin is ProxyPlugin {
  return (
    typeof (plugin as ProxyPlugin).beforeRequest === 'function' ||
    typeof (plugin as ProxyPlugin).beforeProviderCall === 'function' ||
    typeof (plugin as ProxyPlugin).afterProviderResult === 'function' ||
    typeof (plugin as ProxyPlugin).inspectStreamChunk === 'function' ||
    typeof (plugin as ProxyPlugin).mapProviderError === 'function'
  )
}

// ─── No-op defaults ──────────────────────────────────────────────

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return noopLogger
  },
}

const noopStore: PluginStore = {
  async get() {
    return {}
  },
  async set() {},
}

// ─── Backward compat ─────────────────────────────────────────────

export const BUILT_IN_PLUGIN_NAMES = new Set(['vendor_sse_error'])

/** 合并 provider 级和 model 级插件配置，model 级按 name 覆盖 provider 级。 */
export function resolvePluginConfigs(
  providerPlugins: PluginEntry[],
  modelPlugins: PluginEntry[],
): PluginEntry[] {
  const byName = new Map<string, PluginEntry>()
  for (const plugin of providerPlugins) {
    if (plugin.name) byName.set(plugin.name, plugin)
  }
  for (const plugin of modelPlugins) {
    if (plugin.name) byName.set(plugin.name, plugin)
    else byName.set(String(byName.size), plugin)
  }
  return [...byName.values()]
}

/** 校验插件名是否在已知集合中。 */
export function assertKnownPlugins(plugins: PluginEntry[]): void {
  for (const plugin of plugins) {
    if (plugin.name && !BUILT_IN_PLUGIN_NAMES.has(plugin.name)) {
      throw new Error(`Unknown plugin '${plugin.name}'`)
    }
  }
}
