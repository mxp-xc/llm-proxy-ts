import { createAnthropic } from '@ai-sdk/anthropic'
import { sanitizeHeaders, createProxyFetch } from '../openai/provider.js'
import type { AnthropicProviderConfig, Settings } from '../../config.js'

export function createAnthropicProvider(
  providerName: string,
  provider: AnthropicProviderConfig,
  settings: Settings,
  modelHeaders: Record<string, string>,
  selectedApiKey: string | undefined,
  oauthFetch?: (baseFetch?: typeof fetch) => typeof fetch,
) {
  const headers = sanitizeHeaders({ ...provider.headers, ...modelHeaders })

  if (provider.anthropicVersion !== undefined) {
    headers['anthropic-version'] = provider.anthropicVersion
  }

  const options: Parameters<typeof createAnthropic>[0] = {
    name: providerName,
    headers,
  }

  if (provider.baseURL !== undefined) {
    options.baseURL = provider.baseURL
  }

  // OAuth 激活时不设 apiKey，避免与 OAuth fetch 注入的认证头冲突
  if (!oauthFetch && selectedApiKey !== undefined) {
    options.apiKey = selectedApiKey
  }

  // fetch 组合：OAuth fetch → proxy fetch → global fetch（与 openai-compatible 同构）
  if (oauthFetch) {
    options.fetch = settings.proxy
      ? oauthFetch(createProxyFetch(settings.proxy.url, settings.proxy.verify))
      : oauthFetch()
  } else if (settings.proxy) {
    options.fetch = createProxyFetch(settings.proxy.url, settings.proxy.verify)
  }

  return createAnthropic(options)
}
