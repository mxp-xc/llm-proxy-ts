import type { AuthPluginContext } from './types.js';

/**
 * 简单认证结果：只需注入 headers 和/或 query params。
 *
 * 适用于"获取 token → 注入 header/query"的模式。
 * HMAC 等需访问请求 body 的场景，插件应直接实现 `createFetch`。
 */
export interface SimpleAuthCredentials {
  /** 要设置到请求上的 headers */
  headers?: Record<string, string>;
  /** 要追加到请求 URL 上的 query 参数 */
  query?: Record<string, string>;
}

/**
 * 从 acquireCredentials 函数创建 fetch wrapper。
 *
 * 每次请求调用 acquireCredentials 获取认证信息，
 * 然后注入到请求的 headers 和/或 URL query params 中。
 *
 * @example
 * ```typescript
 * // 注入 Bearer header
 * const plugin: AuthPlugin = {
 *   name: 'demo-auth',
 *   createFetch(ctx) {
 *     return createSimpleAuthFetch(async (ctx) => {
 *       const token = await fetchToken(ctx);
 *       return { headers: { Authorization: `Bearer ${token}` } };
 *     }, ctx);
 *   },
 * };
 * ```
 */
export function createSimpleAuthFetch(
  acquireCredentials: (ctx: AuthPluginContext) => Promise<SimpleAuthCredentials>,
  ctx: AuthPluginContext,
): (baseFetch?: typeof fetch) => typeof fetch {
  return (baseFetch) => async (input, init) => {
    const credentials = await acquireCredentials(ctx);

    // 构建最终 URL（追加 query params）
    let url: URL;
    let reconstructedInput: RequestInfo | URL;

    if (typeof input === 'string') {
      url = new URL(input);
      reconstructedInput = url;
    } else if (input instanceof URL) {
      url = new URL(input.toString());
      reconstructedInput = url;
    } else {
      // Request 对象
      url = new URL(input.url);
      reconstructedInput = new Request(url.toString(), input);
    }

    if (credentials.query) {
      for (const [key, value] of Object.entries(credentials.query)) {
        url.searchParams.set(key, value);
      }
      // URL 已修改，需要重建 input
      if (typeof input === 'string') {
        reconstructedInput = url.toString();
      } else if (input instanceof URL) {
        reconstructedInput = url.toString();
      } else {
        reconstructedInput = new Request(url.toString(), input);
      }
    }

    // 构建 headers
    const headers = new Headers(init?.headers);
    if (credentials.headers) {
      for (const [key, value] of Object.entries(credentials.headers)) {
        headers.set(key, value);
      }
    }

    const fetchFn = baseFetch ?? globalThis.fetch;
    return fetchFn(reconstructedInput, { ...init, headers });
  };
}
