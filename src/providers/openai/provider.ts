import { createOpenAI } from '@ai-sdk/openai'
import { sanitizeHeaders, applyProviderAuth } from '../shared/provider-factory.js'
import type { OpenAIProviderConfig } from '../../config.js'

export function createOpenAIProvider(
  providerName: string,
  provider: OpenAIProviderConfig,
  modelHeaders: Record<string, string>,
  selectedApiKey: string | undefined,
  customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
  proxyFetch: typeof fetch | undefined,
) {
  const headers = sanitizeHeaders({ ...provider.headers, ...modelHeaders })

  const options: Parameters<typeof createOpenAI>[0] = {
    name: providerName,
    headers,
  }

  if (provider.baseURL !== undefined) {
    options.baseURL = provider.baseURL
  }

  applyProviderAuth(options, selectedApiKey, customFetch, proxyFetch)

  if (provider.options?.organization !== undefined) {
    options.organization = provider.options.organization
  }

  if (provider.options?.project !== undefined) {
    options.project = provider.options.project
  }

  return createOpenAI(options)
}
