import { createOpenAI } from '@ai-sdk/openai'
import { sanitizeHeaders, applyProviderAuth } from '../shared/provider-factory.js'
import type { OpenAIProviderConfig, Settings } from '../../config.js'

export function createOpenAIProvider(
  providerName: string,
  provider: OpenAIProviderConfig,
  settings: Settings,
  modelHeaders: Record<string, string>,
  selectedApiKey: string | undefined,
  customFetch?: (baseFetch?: typeof fetch) => typeof fetch,
) {
  const headers = sanitizeHeaders({ ...provider.headers, ...modelHeaders })

  const options: Parameters<typeof createOpenAI>[0] = {
    name: providerName,
    headers,
  }

  if (provider.baseURL !== undefined) {
    options.baseURL = provider.baseURL
  }

  applyProviderAuth(options, selectedApiKey, customFetch, settings.proxy)

  if (provider.options?.organization !== undefined) {
    options.organization = provider.options.organization
  }

  if (provider.options?.project !== undefined) {
    options.project = provider.options.project
  }

  return createOpenAI(options)
}
