import type { AuthPlugin, ProviderContext } from '@llm-proxy/core'

/**
 * 调试插件：透传 fetch，打印每次请求的 URL、method、headers 和响应状态。
 *
 * 用法：在 settings.json 的 plugins 中添加：
 *   { "module": "./plugins/debug-fetch/index.ts", "providers": "your-provider" }
 *
 * 可选 config：
 *   logBody: boolean  — 是否打印请求/响应 body（默认 false，避免大 body 淹没日志）
 *   logHeaders: boolean — 是否打印请求 headers（默认 true）
 */
export default {
  name: 'debug-fetch',

  async init(ctx) {
    ctx.log.info(
      { config: ctx.config, providers: [...ctx.providers.keys()] },
      'debug-fetch plugin initialized',
    )
  },

  async createFetch(ctx: ProviderContext) {
    const logBody = ctx.config['logBody'] === true
    const logHeaders = ctx.config['logHeaders'] !== false // default true

    return (baseFetch) => async (input, init) => {
      const fetchFn = baseFetch ?? globalThis.fetch
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'

      // ─── 请求日志 ────────────────────────────────────────────
      const reqInfo: Record<string, unknown> = {
        provider: ctx.id,
        method,
        url,
      }
      if (logHeaders && init?.headers) {
        const h =
          init.headers instanceof Headers
            ? Object.fromEntries(init.headers.entries())
            : init.headers
        reqInfo.headers = h
      }
      if (logBody && init?.body) {
        reqInfo.body = typeof init.body === 'string' ? init.body : '[non-string body]'
      }
      ctx.log.info(reqInfo, '→ request')

      // ─── 调用上游 ───────────────────────────────────────────
      const startMs = Date.now()
      const response = await fetchFn(input, init)
      const durationMs = Date.now() - startMs

      // ─── 响应日志 ────────────────────────────────────────────
      const resInfo: Record<string, unknown> = {
        provider: ctx.id,
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        durationMs,
      }
      if (logBody) {
        // clone 以避免消耗 body
        const cloned = response.clone()
        try {
          const text = await cloned.text()
          // 截断超长 body
          resInfo.body = text.length > 2000 ? `${text.slice(0, 2000)}… [truncated, ${text.length} chars]` : text
        } catch {
          resInfo.body = '[unable to read body]'
        }
      }
      ctx.log.info(resInfo, '← response')

      return response
    }
  },
} satisfies AuthPlugin
