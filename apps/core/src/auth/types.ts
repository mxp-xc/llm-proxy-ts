import type { Logger } from '../types.js';

/**
 * Auth 插件上下文，注入配置、持久化和日志。
 */
export interface AuthPluginContext {
  /** Provider 名称（来自 settings） */
  providerName: string;
  /** Provider 的 baseURL */
  baseURL: string;
  /** 插件自定义配置（来自 settings.auth.config） */
  config: Record<string, unknown>;
  /** 可选的持久化接口，数据存于 auth.json 的 _plugins 子树 */
  store?: AuthPluginStore | undefined;
  /** 日志实例 */
  log: Logger;
}

/**
 * 可选的持久化接口，供需要缓存 token 的插件使用。
 * 数据持久化到 auth.json 的 _plugins.{providerName} 子树。
 */
export interface AuthPluginStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

/**
 * 认证插件接口。
 *
 * 插件通过 `createFetch` 产出与 `createOAuthFetch` 同形的 fetch wrapper：
 * `(baseFetch?) => typeof fetch`，可无缝接入现有 fetch 组合链。
 *
 * 简单场景（header/query 注入）可使用 `createSimpleAuthFetch` 辅助函数。
 * 复杂场景（HMAC 签名等需访问请求 body）直接实现 `createFetch`。
 */
export interface AuthPlugin {
  /** 插件名称，用于日志和诊断 */
  name: string;

  /**
   * 创建 fetch wrapper。
   *
   * 返回的函数签名与 createOAuthFetch 一致，可传入 baseFetch 组合
   * （auth → proxy → global）。
   */
  createFetch(ctx: AuthPluginContext): (baseFetch?: typeof fetch) => typeof fetch;

  /**
   * 可选：启动时校验 config。
   * 抛出 Error 表示配置无效，阻止服务启动。
   */
  validateConfig?(config: Record<string, unknown>): void;
}

/**
 * 运行时已加载的插件实例。
 */
export interface ResolvedAuthPlugin {
  plugin: AuthPlugin;
  modulePath: string;
}
