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
  createProxyFetch,
  sanitizeHeaders,
} from './shared/provider-factory.js'
import { safeProxyUrl } from '../server/logging.js'
import { createAnthropicProvider } from './anthropic/provider.js'
import { createOpenAIProvider } from './openai/provider.js'

// ─── ProviderFactory interface ──────────────────────────────────

/**
 * Injectable factory that creates provider-specific AI SDK model factories.
 * Used to decouple `createProviderRegistry` from concrete provider implementations,
 * enabling dependency injection in tests without module-level mocking.
 *
 * `proxyFetch` 由 registry 作用域预构建(共享 ProxyAgent),per-request 不再 new;
 * 由 createProviderModelFactory 透传到各工厂。无代理时为 undefined。
 */
export interface ProviderFactory {
  createOpenAICompatible(
    providerName: string,
    provider: OpenAICompatibleProviderConfig,
    modelHeaders: Record<string, string>,
    selectedApiKey: string | undefined,
    customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
    proxyFetch: typeof fetch | undefined,
  ): (upstreamModel: string) => LanguageModel

  createAnthropic(
    providerName: string,
    provider: AnthropicProviderConfig,
    modelHeaders: Record<string, string>,
    selectedApiKey: string | undefined,
    customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
    proxyFetch: typeof fetch | undefined,
  ): (upstreamModel: string) => LanguageModel

  createOpenAI(
    providerName: string,
    provider: OpenAIProviderConfig,
    modelHeaders: Record<string, string>,
    selectedApiKey: string | undefined,
    customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
    proxyFetch: typeof fetch | undefined,
  ): (upstreamModel: string) => LanguageModel
}

/** Default factory using the real provider implementations. */
const defaultFactory: ProviderFactory = {
  createOpenAICompatible: createOpenAICompatibleProvider,
  createAnthropic: createAnthropicProvider,
  createOpenAI(providerName, provider, modelHeaders, selectedApiKey, customFetch, proxyFetch) {
    const openaiProvider = createOpenAIProvider(
      providerName,
      provider,
      modelHeaders,
      selectedApiKey,
      customFetch,
      proxyFetch,
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
  /** 按 providerName 选 API key（复用内部轮询状态）。
   *  供 passthrough 透传路径注入 Authorization，与 AI SDK 路径共享 keySelection 轮询。 */
  selectApiKey(providerName: string): { apiKey: string | undefined; keySelection?: KeySelection }
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

  // 共享 ProxyAgent fetch:settings 不可变,registry 作用域一次性构建,
  // 所有 languageModel() 调用复用同一 ProxyAgent(原 per-request new ProxyAgent 消除)。
  const sharedProxyFetch = settings.proxy
    ? createProxyFetch(settings.proxy.url, settings.proxy.verify)
    : undefined

  // 启动时记录代理配置,便于排查「请求是否走代理」。url 经 safeProxyUrl 剥离凭据后以
  // 结构化 URL 形式输出(如 http://127.0.0.1:9000)。
  if (settings.proxy) {
    log.info(
      { proxyUrl: safeProxyUrl(settings.proxy.url), verify: settings.proxy.verify },
      'proxy configured',
    )
  } else {
    log.info('proxy disabled — no proxy configured in settings')
  }

  // 预构建 auth fetch wrappers（per-provider，并行加载）
  const authFetchMap = new Map<string, (baseFetch?: typeof fetch) => typeof fetch>()
  if (pluginRegistry) {
    const entries = Object.keys(settings.providers)
    const results = await Promise.all(
      entries.map(async (id) => {
        const af = await pluginRegistry.createAuthFetch(id, log, authFilePath)
        return [id, af] as const
      }),
    )
    for (const [id, af] of results) {
      if (af) {
        authFetchMap.set(id, af)
      }
    }
  }

  return {
    languageModel(providerName, upstreamModel, modelHeaders) {
      const provider = settings.providers[providerName]
      if (!provider) {
        throw new Error(`Unknown provider '${providerName}'`)
      }

      const modelFactory = createProviderModelFactory(
        providerName,
        provider,
        modelHeaders,
        providerFactory,
        sharedProxyFetch,
      )

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
    selectApiKey(providerName) {
      const provider = settings.providers[providerName]
      if (!provider) {
        throw new Error(`Unknown provider '${providerName}'`)
      }
      const selection = selectApiKey(providerName, provider.apiKey, apiKeyIndexes)
      if (!selection) return { apiKey: undefined }
      return {
        apiKey: selection.apiKey,
        keySelection: { index: selection.index, count: selection.count },
      }
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
 * `proxyFetch` 由 registry 作用域共享,透传到具体 provider 工厂。
 */
function createProviderModelFactory(
  providerName: string,
  provider: ProviderConfig,
  modelHeaders: Record<string, string>,
  providerFactory: ProviderFactory,
  proxyFetch: typeof fetch | undefined,
): (
  selectedApiKey?: string,
  customFetch?: (baseFetch?: typeof fetch) => typeof fetch,
) => (upstreamModel: string) => LanguageModel {
  if (provider.type === 'anthropic') {
    return (selectedApiKey, customFetch) =>
      providerFactory.createAnthropic(
        providerName,
        provider,
        modelHeaders,
        selectedApiKey,
        customFetch,
        proxyFetch,
      )
  }
  if (provider.type === 'openai') {
    return (selectedApiKey, customFetch) =>
      providerFactory.createOpenAI(
        providerName,
        provider,
        modelHeaders,
        selectedApiKey,
        customFetch,
        proxyFetch,
      )
  }
  return (selectedApiKey, customFetch) =>
    providerFactory.createOpenAICompatible(
      providerName,
      provider,
      modelHeaders,
      selectedApiKey,
      customFetch,
      proxyFetch,
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
