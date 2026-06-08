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
  oauthFetch?: (baseFetch?: typeof fetch) => typeof fetch,
) {
  const headers = sanitizeHeaders({ ...provider.headers, ...modelHeaders })
  const options: Parameters<typeof createOpenAICompatible>[0] = {
    name: providerName,
    baseURL: provider.baseURL,
    headers,
  }

  // OAuth 激活时不设 apiKey，避免与 OAuth fetch 注入的 Authorization 冲突
  if (!oauthFetch && selectedApiKey !== undefined) {
    options.apiKey = selectedApiKey
  }

  // fetch 组合：OAuth fetch → proxy fetch → global fetch
  if (oauthFetch) {
    options.fetch = settings.proxy
      ? oauthFetch(createProxyFetch(settings.proxy.url, settings.proxy.verify))
      : oauthFetch()
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
