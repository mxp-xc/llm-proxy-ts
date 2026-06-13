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
    // 让上游在流式响应中返回 usage（stream_options: { include_usage: true }）
    // 可在 provider 配置中设 includeUsage: false 禁用（适用于不支持 stream_options 的上游）
    includeUsage: provider.options?.includeUsage ?? true,
  }

  applyProviderAuth(options, selectedApiKey, customFetch, settings.proxy)

  return createOpenAICompatible(options)
}

/**
 * Apply provider authentication and fetch composition to SDK provider options.
 * Centralizes the pattern shared by openai, anthropic, and openai-compatible providers:
 * 1. Set apiKey if provided
 * 2. Set oauth-placeholder if customFetch is present but no apiKey (bypasses loadApiKey)
 * 3. Compose customFetch with proxy fetch if applicable
 */
export function applyProviderAuth(
  options: { apiKey?: string; fetch?: typeof fetch },
  selectedApiKey: string | undefined,
  customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
  proxySettings: { url: string; verify: boolean } | null,
): void {
  if (selectedApiKey !== undefined) {
    options.apiKey = selectedApiKey
  }

  // OAuth/auth-plugin 路径下，customFetch 管理认证，占位 apiKey 仅绕过 loadApiKey()
  if (selectedApiKey === undefined && customFetch) {
    options.apiKey = 'oauth-placeholder'
  }

  if (customFetch) {
    options.fetch = proxySettings
      ? customFetch(createProxyFetch(proxySettings.url, proxySettings.verify))
      : customFetch()
  } else if (proxySettings) {
    options.fetch = createProxyFetch(proxySettings.url, proxySettings.verify)
  }
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
