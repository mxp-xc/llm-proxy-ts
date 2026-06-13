import { createAnthropic } from '@ai-sdk/anthropic'
import { sanitizeHeaders, createProxyFetch } from '../shared/provider-factory.js'
import type { AnthropicProviderConfig, Settings } from '../../config.js'

export function createAnthropicProvider(
  providerName: string,
  provider: AnthropicProviderConfig,
  settings: Settings,
  modelHeaders: Record<string, string>,
  selectedApiKey: string | undefined,
  customFetch?: (baseFetch?: typeof fetch) => typeof fetch,
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

  // 有 apiKey 就设，让 AI SDK 注入认证头
  // 如果调用方同时提供 customFetch 且该 fetch 自己管理认证（如 OAuth），
  // 调用方应传 selectedApiKey=undefined 以避免双重认证头
  if (selectedApiKey !== undefined) {
    options.apiKey = selectedApiKey
  }

  // fetch 组合：customFetch → proxy fetch → global fetch（与 openai-compatible 同构）
  if (customFetch) {
    options.fetch = settings.proxy
      ? customFetch(createProxyFetch(settings.proxy.url, settings.proxy.verify))
      : customFetch()
  } else if (settings.proxy) {
    options.fetch = createProxyFetch(settings.proxy.url, settings.proxy.verify)
  }

  return createAnthropic(options)
}
