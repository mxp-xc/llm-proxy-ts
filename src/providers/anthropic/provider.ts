import { createAnthropic } from '@ai-sdk/anthropic'
import { sanitizeHeaders, applyProviderAuth } from '../shared/provider-factory.js'
import type { AnthropicProviderConfig } from '../../config.js'

export function createAnthropicProvider(
  providerName: string,
  provider: AnthropicProviderConfig,
  modelHeaders: Record<string, string>,
  selectedApiKey: string | undefined,
  customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
  proxyFetch: typeof fetch | undefined,
) {
  const headers = sanitizeHeaders({ ...provider.headers, ...modelHeaders })

  if (provider.options?.anthropicVersion !== undefined) {
    headers['anthropic-version'] = provider.options.anthropicVersion
  }

  const options: Parameters<typeof createAnthropic>[0] = {
    name: providerName,
    headers,
  }

  if (provider.baseURL !== undefined) {
    options.baseURL = provider.baseURL
  }

  applyProviderAuth(options, selectedApiKey, customFetch, proxyFetch)

  return createAnthropic(options)
}
