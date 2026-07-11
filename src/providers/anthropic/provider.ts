import { createAnthropic } from '@ai-sdk/anthropic'
import { sanitizeHeaders, applyProviderAuth } from '../shared/provider-factory.js'
import type { AnthropicProviderConfig } from '../../config.js'
import type { ProviderBuildInput } from '../shared/provider-factory.js'

export function createAnthropicProvider(input: ProviderBuildInput<AnthropicProviderConfig>) {
  const { providerName, provider, modelHeaders, selectedApiKey, customFetch, proxyFetch } = input
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
