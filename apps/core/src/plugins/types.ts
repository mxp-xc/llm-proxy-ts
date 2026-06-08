import type { ProviderConfig, Settings } from '../config.js';
import type { Logger } from '../types.js';

// ─── Store ───────────────────────────────────────────────────────

/** 全局 key-value 持久化存储。插件用 key 命名空间管理隔离（如 `my-auth:baidu:token`）。 */
export interface PluginStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/** @deprecated 使用 PluginStore */
export type AuthPluginStore = PluginStore;

// ─── Models ──────────────────────────────────────────────────────

export interface DiscoveredModel {
  id: string;
  // 后续可扩展
}

export interface DiscoveredModelList {
  models: DiscoveredModel[];
}

// ─── Pipeline types ──────────────────────────────────────────────

export interface PluginResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ProviderCallPatch {
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
}

export interface ProviderResultPatch {
  body?: unknown;
}

// ─── Contexts ────────────────────────────────────────────────────

/** 插件初始化上下文（per-plugin，生命周期 hook 使用） */
export interface PluginInitContext {
  providers: Map<string, ProviderConfig>;
  config: Record<string, unknown>;
  store: PluginStore;
  log: Logger;
}

/** Per-provider 上下文（createFetch / discoverModels 使用） */
export interface ProviderContext {
  id: string;
  provider: ProviderConfig;
  config: Record<string, unknown>;
  store: PluginStore;
  log: Logger;
}

/** Per-request 上下文（管道 hook 使用） */
export interface PluginContext {
  requestId: string;
  settings: Settings;
  provider: { id: string; provider: ProviderConfig };
  config: Record<string, unknown>;
  request?: unknown;
  route?: unknown;
}

// ─── Plugin interfaces ───────────────────────────────────────────

/** 基础插件接口：所有插件共享 */
export interface Plugin {
  name: string;
  /** 初始化插件实例。校验配置、准备状态。应快速完成。抛错则阻止启动。 */
  init?(ctx: PluginInitContext): Promise<void>;
  /** 服务监听端口前调用。可执行阻塞操作如 OAuth 登录。抛错则阻止启动。 */
  beforeServerStart?(): Promise<void>;
  /** 服务监听端口后调用。非阻塞，可执行后台任务。 */
  afterServerStart?(): Promise<void>;
}

/** 管道能力：请求拦截、流检查等 */
export interface ProxyPlugin extends Plugin {
  beforeRequest?(ctx: PluginContext): Promise<void | PluginResponse>;
  beforeProviderCall?(ctx: PluginContext): Promise<void | ProviderCallPatch>;
  afterProviderResult?(ctx: PluginContext): Promise<void | ProviderResultPatch>;
  inspectStreamChunk?(ctx: PluginContext & { chunk: unknown }): Promise<void | PluginResponse>;
  mapProviderError?(ctx: PluginContext & { error: unknown }): Promise<void | PluginResponse>;
}

/** 认证 + models 能力：自定义 fetch wrapper、模型发现 */
export interface AuthPlugin extends Plugin {
  /** 为指定 provider 创建认证 fetch wrapper。per-provider 调用一次。 */
  createFetch(ctx: ProviderContext): Promise<(baseFetch?: typeof fetch) => typeof fetch>;
  /** 自定义获取上游模型列表 */
  discoverModels?(ctx: ProviderContext): Promise<DiscoveredModelList>;
}

// ─── Resolved ────────────────────────────────────────────────────

export interface ResolvedPlugin {
  plugin: Plugin;
  config: Record<string, unknown>;
  providers: string[];
  modulePath?: string;
}
