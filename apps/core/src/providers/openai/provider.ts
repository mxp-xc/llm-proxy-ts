import { createOpenAI } from '@ai-sdk/openai'
import { sanitizeHeaders, createProxyFetch } from '../shared/provider-factory.js'
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

  // 有 apiKey 就设，让 AI SDK 注入 Authorization 头
  // 如果调用方同时提供 customFetch 且该 fetch 自己管理认证（如 OAuth），
  // 调用方应传 selectedApiKey=undefined 以避免双重认证头
  if (selectedApiKey !== undefined) {
    options.apiKey = selectedApiKey
  }

  // createOpenAI 内部通过 loadApiKey() 设置 Authorization 头。
  // 当 selectedApiKey 为 undefined 且无 OPENAI_API_KEY 环境变量时，
  // loadApiKey 会在首次请求时抛出错误。
  // OAuth 场景下 customFetch 会自行设置认证头（覆盖 SDK 注入的 Authorization），
  // 此处传占位 apiKey 仅用于绕过 loadApiKey 校验，实际认证由 customFetch 管理。
  if (selectedApiKey === undefined && customFetch) {
    options.apiKey = 'oauth-placeholder'
  }

  if (provider.organization !== undefined) {
    options.organization = provider.organization
  }

  if (provider.project !== undefined) {
    options.project = provider.project
  }

  // fetch 组合：customFetch → proxy fetch → global fetch（与 anthropic/openai-compatible 同构）
  if (customFetch) {
    options.fetch = settings.proxy
      ? customFetch(createProxyFetch(settings.proxy.url, settings.proxy.verify))
      : customFetch()
  } else if (settings.proxy) {
    options.fetch = createProxyFetch(settings.proxy.url, settings.proxy.verify)
  }

  return createOpenAI(options)
}
