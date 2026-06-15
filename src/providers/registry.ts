import type { LanguageModel } from 'ai'
import type { Settings, OAuthConfig, ProviderConfig } from '../config.js'
import type { OpenAICompatibleProviderConfig } from '../config.js'
import type { AnthropicProviderConfig } from '../config.js'
import type { OpenAIProviderConfig } from '../config.js'
import type { TokenManager } from '../oauth/index.js'
import { noopLogger } from '../types.js'
import type { Logger } from '../types.js'
import type { PluginRegistry } from '../plugins/registry.js'
import {
  createOpenAICompatibleProvider,
  sanitizeHeaders,
} from './shared/provider-factory.js'
import { createAnthropicProvider } from './anthropic/provider.js'
import { createOpenAIProvider } from './openai/provider.js'

// ─── ProviderFactory interface ──────────────────────────────────

/**
 * Injectable factory that creates provider-specific AI SDK model factories.
 * Used to decouple `createProviderRegistry` from concrete provider implementations,
 * enabling dependency injection in tests without module-level mocking.
 */
export interface ProviderFactory {
  createOpenAICompatible(
    providerName: string,
    provider: OpenAICompatibleProviderConfig,
    settings: Settings,
    modelHeaders: Record<string, string>,
    selectedApiKey: string | undefined,
    customFetch?: (baseFetch?: typeof fetch) => typeof fetch,
  ): (upstreamModel: string) => LanguageModel

  createAnthropic(
    providerName: string,
    provider: AnthropicProviderConfig,
    settings: Settings,
    modelHeaders: Record<string, string>,
    selectedApiKey: string | undefined,
    customFetch?: (baseFetch?: typeof fetch) => typeof fetch,
  ): (upstreamModel: string) => LanguageModel

  createOpenAI(
    providerName: string,
    provider: OpenAIProviderConfig,
    settings: Settings,
    modelHeaders: Record<string, string>,
    selectedApiKey: string | undefined,
    customFetch?: (baseFetch?: typeof fetch) => typeof fetch,
  ): (upstreamModel: string) => LanguageModel
}

/** Default factory using the real provider implementations. */
const defaultFactory: ProviderFactory = {
  createOpenAICompatible: createOpenAICompatibleProvider,
  createAnthropic: createAnthropicProvider,
  createOpenAI(providerName, provider, settings, modelHeaders, selectedApiKey, customFetch) {
    const openaiProvider = createOpenAIProvider(
      providerName,
      provider,
      settings,
      modelHeaders,
      selectedApiKey,
      customFetch,
    )
    return (upstreamModel) => openaiProvider.responses(upstreamModel)
  },
}

export interface KeySelection {
  index: number
  count: number
}

export interface LanguageModelResult {
  model: LanguageModel
  keySelection?: KeySelection
}

export interface ProviderRegistry {
  languageModel(
    providerName: string,
    upstreamModel: string,
    modelHeaders: Record<string, string>,
  ): LanguageModelResult
  debugProviderConfig(providerName: string): {
    baseURL: string
    headers: Record<string, string>
    proxyEnabled: boolean
  }
}

export async function createProviderRegistry(
  settings: Settings,
  tokenManager?: TokenManager,
  logger?: Logger,
  pluginRegistry?: PluginRegistry,
  authFilePath?: string,
  factory?: ProviderFactory,
): Promise<ProviderRegistry> {
  const log = logger ?? noopLogger
  const providerFactory = factory ?? defaultFactory
  const apiKeyIndexes = new Map<string, number>()

  // 预构建 auth fetch wrappers（per-provider）
  const authFetchMap = new Map<string, (baseFetch?: typeof fetch) => typeof fetch>()
  if (pluginRegistry) {
    for (const providerId of Object.keys(settings.providers)) {
      const authFetch = await pluginRegistry.createAuthFetch(providerId, log, authFilePath)
      if (authFetch) {
        authFetchMap.set(providerId, authFetch)
      }
    }
  }

  return {
    languageModel(providerName, upstreamModel, modelHeaders) {
      const provider = settings.providers[providerName]
      if (!provider) {
        throw new Error(`Unknown provider '${providerName}'`)
      }

      const modelFactory = createProviderModelFactory(providerName, provider, settings, modelHeaders, providerFactory)

      // Auth 插件路径：使用预构建的 fetch wrapper，但保留内置 API Key 注入
      const authFetch = authFetchMap.get(providerName)
      if (authFetch) {
        const selection = selectApiKey(providerName, provider.apiKey, apiKeyIndexes)
        const result: LanguageModelResult = {
          model: modelFactory(selection?.apiKey, authFetch)(upstreamModel),
        }
        if (selection) {
          result.keySelection = { index: selection.index, count: selection.count }
        }
        return result
      }

      // OAuth 路径：使用动态 fetch 注入 token
      if (provider.oauth && tokenManager) {
        const oauthFetch = createOAuthFetch(providerName, provider.oauth, tokenManager)
        // OAuth fetch 自己注入 Authorization 头，apiKey 传 undefined 避免双重认证
        return { model: modelFactory(undefined, oauthFetch)(upstreamModel) }
      }

      // 静态 API Key 路径
      const selection = selectApiKey(providerName, provider.apiKey, apiKeyIndexes)
      const result: LanguageModelResult = {
        model: modelFactory(selection?.apiKey)(upstreamModel),
      }
      if (selection) {
        result.keySelection = { index: selection.index, count: selection.count }
      }
      return result
    },
    debugProviderConfig(providerName) {
      const provider = settings.providers[providerName]
      if (!provider) {
        throw new Error(`Unknown provider '${providerName}'`)
      }

      return {
        baseURL:
          provider.type === 'anthropic'
            ? (provider.baseURL ?? 'https://api.anthropic.com/v1')
            : provider.type === 'openai'
              ? (provider.baseURL ?? 'https://api.openai.com/v1')
              : provider.baseURL,
        headers: sanitizeHeaders(provider.headers),
        proxyEnabled: settings.proxy !== null,
      }
    },
  }
}

/**
 * 创建 OAuth fetch 工厂：在每次请求前确保 token 有效并注入 Authorization 头。
 *
 * 支持与 proxy fetch 组合：oauthFetch(proxyFetch) → proxyFetch 添加代理，
 * oauth fetch 添加认证头。
 */
export function createOAuthFetch(
  providerName: string,
  oauthConfig: OAuthConfig,
  tokenManager: TokenManager,
): (baseFetch?: typeof fetch) => typeof fetch {
  return (baseFetch) => async (input, init) => {
    const token = await tokenManager.ensureValidToken(providerName, oauthConfig)
    const headers = new Headers(init?.headers)
    // 清理 SDK 注入的占位/过期认证头，防止 oauth-placeholder 泄漏到上游
    // @ai-sdk/openai 注入 Authorization: Bearer oauth-placeholder
    // @ai-sdk/anthropic 注入 x-api-key: oauth-placeholder
    headers.delete('Authorization')
    headers.delete('x-api-key')
    headers.set('Authorization', `${token.tokenType} ${token.accessToken}`)
    const fetchFn = baseFetch ?? globalThis.fetch
    return fetchFn(input, { ...init, headers })
  }
}

/**
 * 根据 provider.type 返回对应的 AI SDK provider 工厂函数。
 * 消除 auth plugin / OAuth / static API key 三条路径的重复分派逻辑。
 */
function createProviderModelFactory(
  providerName: string,
  provider: ProviderConfig,
  settings: Settings,
  modelHeaders: Record<string, string>,
  providerFactory: ProviderFactory,
): (
  selectedApiKey?: string,
  customFetch?: (baseFetch?: typeof fetch) => typeof fetch,
) => (upstreamModel: string) => LanguageModel {
  if (provider.type === 'anthropic') {
    return (selectedApiKey, customFetch) =>
      providerFactory.createAnthropic(
        providerName,
        provider,
        settings,
        modelHeaders,
        selectedApiKey,
        customFetch,
      )
  }
  if (provider.type === 'openai') {
    return (selectedApiKey, customFetch) =>
      providerFactory.createOpenAI(
        providerName,
        provider,
        settings,
        modelHeaders,
        selectedApiKey,
        customFetch,
      )
  }
  return (selectedApiKey, customFetch) =>
    providerFactory.createOpenAICompatible(
      providerName,
      provider,
      settings,
      modelHeaders,
      selectedApiKey,
      customFetch,
    )
}

function selectApiKey(
  providerName: string,
  apiKey: string | [string, ...string[]] | null | undefined,
  apiKeyIndexes: Map<string, number>,
): { apiKey: string; index: number; count: number } | undefined {
  if (apiKey === undefined || apiKey === null) {
    return undefined
  }

  if (typeof apiKey === 'string') {
    return { apiKey, index: 0, count: 1 }
  }

  const index = apiKeyIndexes.get(providerName) ?? 0
  const selectedIndex = index % apiKey.length
  const selectedApiKey = apiKey[selectedIndex]
  if (selectedApiKey === undefined) {
    throw new Error(`Missing API key at index ${selectedIndex} for provider '${providerName}'`)
  }
  apiKeyIndexes.set(providerName, index + 1)
  return { apiKey: selectedApiKey, index: selectedIndex, count: apiKey.length }
}
