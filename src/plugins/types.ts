import type { ModelLimit } from '../providers/model-types.js'
import type { ProviderConfig, Settings } from '../config.js'
import type { Logger } from '../types.js'

// ─── Store ───────────────────────────────────────────────────────

/** 插件持久化存储。数据自动存储在 _plugins.{pluginName} 下。 */
export interface PluginStore {
  /** 读取当前插件的全部存储数据。无数据时返回空对象。返回值为浅拷贝。 */
  get(): Promise<Record<string, unknown>>
  /**
   * 替换当前插件的全部存储数据（非合并）。
   * 调用后之前存储的所有字段都会被丢弃，仅保留本次传入的数据。
   * 如需保留已有字段，请先 get() 合并后再 set()。
   */
  set(data: Record<string, unknown>): Promise<void>
}

// ─── Models ──────────────────────────────────────────────────────

export interface DiscoveredModel {
  id: string
  /** Optional CLI-only description supplied by model discovery integrations. */
  description?: string
  limit?: ModelLimit
}

export interface DiscoveredModelList {
  models: DiscoveredModel[]
}

// ─── Pipeline types ──────────────────────────────────────────────

export interface PluginResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export type PluginHook = 'createFetch' | 'discoverModels' | 'inspectStreamChunk'

/** 插件 hook 失败的统一错误，供请求层按来源做一次结构化记录。 */
export class PluginHookError extends Error {
  constructor(
    public readonly plugin: string,
    public readonly provider: string,
    public readonly hook: PluginHook,
    cause: unknown,
  ) {
    super(`Plugin '${plugin}' hook '${hook}' failed for provider '${provider}'`, { cause })
    this.name = 'PluginHookError'
  }
}

// ─── Contexts ────────────────────────────────────────────────────

/** 插件初始化上下文（per-plugin，生命周期 hook 使用） */
export interface PluginInitContext {
  providers: Map<string, ProviderConfig>
  config: Record<string, unknown>
  store: PluginStore
  log: Logger
}

/** Per-provider 上下文（createFetch / discoverModels 使用） */
export interface ProviderContext {
  id: string
  provider: ProviderConfig
  config: Record<string, unknown>
  store: PluginStore
  log: Logger
}

/** Per-request 上下文（管道 hook 使用） */
export interface PluginContext {
  requestId: string
  settings: Settings
  provider: { id: string; provider: ProviderConfig }
  config: Record<string, unknown>
  request?: unknown
  route?: unknown
}

// ─── Plugin interfaces ───────────────────────────────────────────

/** 基础插件接口：所有插件共享 */
export interface Plugin {
  name: string
  /** 初始化插件实例。应快速完成；PluginRegistry.initAll 会记录 init 错误并继续启动。 */
  init?(ctx: PluginInitContext): Promise<void>
  /** 服务监听端口前调用。可执行阻塞操作如 OAuth 登录。抛错则阻止启动。 */
  beforeServerStart?(): Promise<void>
  /** 服务监听端口后调用。非阻塞，可执行后台任务。 */
  afterServerStart?(): Promise<void>
}

/** 管道能力：检查上游流 chunk 并可短路为插件响应。 */
export interface ProxyPlugin extends Plugin {
  inspectStreamChunk?(ctx: PluginContext & { chunk: unknown }): Promise<void | PluginResponse>
}

/** 认证 + models 能力：自定义 fetch wrapper、模型发现 */
export interface AuthPlugin extends Plugin {
  /** 为指定 provider 创建认证 fetch wrapper。per-provider 调用一次。
   *
   * 注意：如果插件的 fetch wrapper 设置了 Authorization 或 x-api-key 头，
   * 请确保对应 provider 的 apiKey 未配置，否则会同时发送两套认证信息。
   * OAuth 路径自动传 apiKey=undefined 以避免此冲突。
   */
  createFetch(ctx: ProviderContext): Promise<(baseFetch?: typeof fetch) => typeof fetch>
  /** 自定义获取上游模型列表 */
  discoverModels?(ctx: ProviderContext): Promise<DiscoveredModelList>
}

// ─── Resolved ────────────────────────────────────────────────────

export interface ResolvedPlugin {
  plugin: Plugin
  config: Record<string, unknown>
  providers: string[]
  modulePath?: string
}
