import type { LanguageModel } from 'ai'
import type { Settings, OAuthConfig, ProviderConfig } from '../config.js'
import type { TokenManager } from '../oauth/index.js'
import type { Logger } from '../types.js'
import type { PluginRegistry } from '../plugins/registry.js'
import { createOpenAICompatibleProvider, sanitizeHeaders } from './shared/provider-factory.js'
import { createAnthropicProvider } from './anthropic/provider.js'

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return noopLogger
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
): Promise<ProviderRegistry> {
  const log = logger ?? noopLogger
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

      const factory = createProviderModelFactory(providerName, provider, settings, modelHeaders)

      // Auth 插件路径：使用预构建的 fetch wrapper
      const authFetch = authFetchMap.get(providerName)
      if (authFetch) {
        return { model: factory(undefined, authFetch)(upstreamModel) }
      }

      // OAuth 路径：使用动态 fetch 注入 token
      if (provider.oauth && tokenManager) {
        const oauthFetch = createOAuthFetch(providerName, provider.oauth, tokenManager)
        return { model: factory(undefined, oauthFetch)(upstreamModel) }
      }

      // 静态 API Key 路径
      const selection = selectApiKey(providerName, provider.apiKey, apiKeyIndexes)
      const result: LanguageModelResult = {
        model: factory(selection?.apiKey)(upstreamModel),
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
): (
  selectedApiKey?: string,
  oauthFetch?: (baseFetch?: typeof fetch) => typeof fetch,
) => (upstreamModel: string) => LanguageModel {
  if (provider.type === 'anthropic') {
    return (selectedApiKey, oauthFetch) =>
      createAnthropicProvider(
        providerName,
        provider,
        settings,
        modelHeaders,
        selectedApiKey,
        oauthFetch,
      )
  }
  return (selectedApiKey, oauthFetch) =>
    createOpenAICompatibleProvider(
      providerName,
      provider,
      settings,
      modelHeaders,
      selectedApiKey,
      oauthFetch,
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
