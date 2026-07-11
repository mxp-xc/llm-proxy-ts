import type { LanguageModel } from 'ai'
import type { Settings, OAuthConfig, ProviderConfig } from '../config.js'
import type { OpenAICompatibleProviderConfig } from '../config.js'
import type { AnthropicProviderConfig } from '../config.js'
import type { OpenAIProviderConfig } from '../config.js'
import type { TokenManager } from '../oauth/index.js'
import { noopLogger } from '../types.js'
import type { Logger } from '../types.js'
import type { AuthFetchRegistry } from '../plugins/registry.js'
import {
  createOpenAICompatibleProvider,
  createProxyFetch,
  type ProviderBuildInput,
} from './shared/provider-factory.js'
import { safeProxyUrl } from '../proxy-url.js'
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
    input: ProviderBuildInput<OpenAICompatibleProviderConfig>,
  ): (upstreamModel: string) => LanguageModel

  createAnthropic(
    input: ProviderBuildInput<AnthropicProviderConfig>,
  ): (upstreamModel: string) => LanguageModel

  createOpenAI(
    input: ProviderBuildInput<OpenAIProviderConfig>,
  ): (upstreamModel: string) => LanguageModel
}

/** Default factory using the real provider implementations. */
const defaultFactory: ProviderFactory = {
  createOpenAICompatible: createOpenAICompatibleProvider,
  createAnthropic: createAnthropicProvider,
  createOpenAI(input) {
    const openaiProvider = createOpenAIProvider(input)
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

export interface LanguageModelOptions {
  customFetch?: ((baseFetch?: typeof fetch) => typeof fetch) | undefined
}

export interface ProviderPassthroughTransport {
  fetch: typeof fetch
  apiKey?: string | undefined
  keySelection?: KeySelection
}

interface ResolvedProviderTransport {
  apiKey: string | undefined
  keySelection?: KeySelection
  customFetch?: ((baseFetch?: typeof fetch) => typeof fetch) | undefined
}

export interface ProviderRegistry {
  languageModel(
    providerName: string,
    upstreamModel: string,
    modelHeaders: Record<string, string>,
    options?: LanguageModelOptions,
  ): LanguageModelResult
  /** 供 passthrough 透传路径复用 registry 内部 auth/proxy composition。 */
  passthroughTransport(providerName: string): ProviderPassthroughTransport
}

export async function createProviderRegistry(
  settings: Settings,
  tokenManager?: TokenManager,
  logger?: Logger,
  pluginRegistry?: AuthFetchRegistry,
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

  const toKeySelection = (
    selection: ReturnType<typeof selectApiKey>,
  ): { apiKey: string | undefined; keySelection?: KeySelection } => {
    if (!selection) return { apiKey: undefined }
    return {
      apiKey: selection.apiKey,
      keySelection: { index: selection.index, count: selection.count },
    }
  }

  const resolveProviderTransport = (
    providerName: string,
    provider: ProviderConfig,
  ): ResolvedProviderTransport => {
    const authFetch = authFetchMap.get(providerName)
    if (authFetch) {
      const selection = toKeySelection(selectApiKey(providerName, provider.apiKey, apiKeyIndexes))
      return { ...selection, customFetch: authFetch }
    }

    if (provider.oauth && tokenManager) {
      const oauthFetch = createOAuthFetch(providerName, provider.oauth, tokenManager)
      return { apiKey: undefined, customFetch: oauthFetch }
    }

    const selection = toKeySelection(selectApiKey(providerName, provider.apiKey, apiKeyIndexes))
    return selection
  }

  const resolvePassthroughTransport = (
    providerName: string,
    provider: ProviderConfig,
  ): ProviderPassthroughTransport => {
    const baseFetch = sharedProxyFetch ?? globalThis.fetch
    const transport = resolveProviderTransport(providerName, provider)
    return {
      apiKey: transport.apiKey,
      ...(transport.keySelection ? { keySelection: transport.keySelection } : {}),
      fetch: transport.customFetch ? transport.customFetch(baseFetch) : baseFetch,
    }
  }

  const getProvider = (providerName: string): ProviderConfig => {
    const provider = settings.providers[providerName]
    if (!provider) {
      throw new Error(`Unknown provider '${providerName}'`)
    }
    return provider
  }

  const passthroughTransport = (providerName: string): ProviderPassthroughTransport => {
    return resolvePassthroughTransport(providerName, getProvider(providerName))
  }

  const composeFetchWrappers = (
    outer: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
    inner: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
  ): ((baseFetch?: typeof fetch) => typeof fetch) | undefined => {
    if (!outer) return inner
    if (!inner) return outer
    return (baseFetch) => outer(inner(baseFetch))
  }

  return {
    languageModel(providerName, upstreamModel, modelHeaders, options) {
      const provider = getProvider(providerName)

      const modelFactory = createProviderModelFactory(
        providerName,
        provider,
        modelHeaders,
        providerFactory,
        sharedProxyFetch,
      )
      const transport = resolveProviderTransport(providerName, provider)
      const customFetch = composeFetchWrappers(transport.customFetch, options?.customFetch)
      const result: LanguageModelResult = {
        model: modelFactory(transport.apiKey, customFetch)(upstreamModel),
      }
      if (transport.keySelection) {
        result.keySelection = transport.keySelection
      }
      return result
    },
    passthroughTransport,
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
  const buildInput = <TProvider extends ProviderConfig>(
    typedProvider: TProvider,
    selectedApiKey: string | undefined,
    customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
  ): ProviderBuildInput<TProvider> => ({
    providerName,
    provider: typedProvider,
    modelHeaders,
    selectedApiKey,
    customFetch,
    proxyFetch,
  })

  switch (provider.type) {
    case 'anthropic':
      return (selectedApiKey, customFetch) =>
        providerFactory.createAnthropic(buildInput(provider, selectedApiKey, customFetch))
    case 'openai':
      return (selectedApiKey, customFetch) =>
        providerFactory.createOpenAI(buildInput(provider, selectedApiKey, customFetch))
    case 'openai-compatible':
      return (selectedApiKey, customFetch) =>
        providerFactory.createOpenAICompatible(buildInput(provider, selectedApiKey, customFetch))
    default:
      return assertNever(provider)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider type ${(value as { type?: string }).type}`)
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
