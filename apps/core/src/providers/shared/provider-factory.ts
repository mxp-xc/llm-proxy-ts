import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { ProxyAgent, request } from 'undici'
import type { Settings } from '../../config.js'
import type { OpenAICompatibleProviderConfig } from '../../config.js'

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sensitiveHeaders = new Set([
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'apikey',
    'api_key',
  ])
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !sensitiveHeaders.has(key.toLowerCase())),
  )
}

export function createOpenAICompatibleProvider(
  providerName: string,
  provider: OpenAICompatibleProviderConfig,
  settings: Settings,
  modelHeaders: Record<string, string>,
  selectedApiKey: string | undefined,
  customFetch?: (baseFetch?: typeof fetch) => typeof fetch,
) {
  const headers = sanitizeHeaders({ ...provider.headers, ...modelHeaders })
  const options: Parameters<typeof createOpenAICompatible>[0] = {
    name: providerName,
    baseURL: provider.baseURL,
    headers,
  }

  // 有 apiKey 就设，让 AI SDK 注入认证头
  // 如果调用方同时提供 customFetch 且该 fetch 自己管理认证（如 OAuth），
  // 调用方应传 selectedApiKey=undefined 以避免双重认证头
  if (selectedApiKey !== undefined) {
    options.apiKey = selectedApiKey
  }

  // fetch 组合：customFetch → proxy fetch → global fetch
  if (customFetch) {
    options.fetch = settings.proxy
      ? customFetch(createProxyFetch(settings.proxy.url, settings.proxy.verify))
      : customFetch()
  } else if (settings.proxy) {
    options.fetch = createProxyFetch(settings.proxy.url, settings.proxy.verify)
  }

  return createOpenAICompatible(options)
}

export function createProxyFetch(proxyUrl: string, verify: boolean): typeof fetch {
  const dispatcher = new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: verify } })

  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const options: Parameters<typeof request>[1] = { dispatcher }

    if (init?.method !== undefined) {
      options.method = init.method as never
    }

    if (init?.body !== undefined && init.body !== null) {
      options.body = init.body as never
    }

    if (init?.headers !== undefined) {
      options.headers = init.headers as never
    }

    const response = await request(url, options)

    return new Response(response.body as never, {
      status: response.statusCode,
      headers: response.headers as HeadersInit,
    })
  }
}
