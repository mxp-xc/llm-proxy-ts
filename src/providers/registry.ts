import { APICallError, wrapLanguageModel, type LanguageModel } from 'ai'
import type { Settings, OAuthConfig, ProviderConfig } from '../config.js'
import type { OpenAICompatibleProviderConfig } from '../config.js'
import type { AnthropicProviderConfig } from '../config.js'
import type { OpenAIProviderConfig } from '../config.js'
import type { TokenManager } from '../oauth/index.js'
import { noopLogger } from '../types.js'
import type { Logger } from '../types.js'
import type { AuthFetchRegistry } from '../plugins/registry.js'
import {
  createDirectFetch,
  createOpenAICompatibleProvider,
  createProxyFetch,
  type ProviderBuildInput,
} from './shared/provider-factory.js'
import { safeProxyUrl } from '../proxy-url.js'
import { createAnthropicProvider } from './anthropic/provider.js'
import { resolveProviderMetadata } from './metadata.js'
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
  onKeySelection?: (selection: KeySelection) => void
}

interface ResolvedProviderTransport {
  apiKeys: Array<{ apiKey: string | undefined; index?: number }>
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

  // 共享 transport fetch:settings 不可变,registry 作用域一次性构建。
  // proxy:null 也使用显式直连 Agent，避免终端 http_proxy 覆盖配置文件语义。
  const sharedProxyFetch = settings.proxy
    ? createProxyFetch(settings.proxy.url, settings.proxy.verify)
    : createDirectFetch()

  // 启动时记录代理配置,便于排查「请求是否走代理」。url 经 safeProxyUrl 剥离凭据后以
  // 结构化 URL 形式输出(如 http://127.0.0.1:9000)。
  if (settings.proxy) {
    log.info(
      {
        proxyUrl: safeProxyUrl(settings.proxy.url),
        verify: settings.proxy.verify,
      },
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

  const resolveProviderTransport = (
    providerName: string,
    provider: ProviderConfig,
  ): ResolvedProviderTransport => {
    const authFetch = authFetchMap.get(providerName)
    if (authFetch) {
      return {
        ...selectApiKeys(providerName, provider.apiKey, apiKeyIndexes),
        customFetch: authFetch,
      }
    }

    if (provider.oauth && tokenManager) {
      const oauthFetch = createOAuthFetch(providerName, provider.oauth, tokenManager)
      return { apiKeys: [{ apiKey: undefined }], customFetch: oauthFetch }
    }

    return selectApiKeys(providerName, provider.apiKey, apiKeyIndexes)
  }

  const getProvider = (providerName: string): ProviderConfig => {
    const provider = settings.providers[providerName]
    if (!provider) {
      throw new Error(`Unknown provider '${providerName}'`)
    }
    return provider
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
      const provider = resolveProviderMetadata(getProvider(providerName)).provider

      const modelFactory = createProviderModelFactory(
        providerName,
        provider,
        modelHeaders,
        providerFactory,
        sharedProxyFetch,
      )
      const transport = resolveProviderTransport(providerName, provider)
      const customFetch = composeFetchWrappers(transport.customFetch, options?.customFetch)
      const delegates = transport.apiKeys.map(({ apiKey }) =>
        modelFactory(apiKey, customFetch)(upstreamModel),
      )
      const result: LanguageModelResult = {
        model:
          delegates.length > 1
            ? createFailoverLanguageModel(
                delegates,
                transport.keySelection!.count,
                transport.apiKeys.map(({ index }) => index!),
                options?.onKeySelection,
                log,
              )
            : delegates[0]!,
      }
      if (transport.keySelection) {
        result.keySelection = transport.keySelection
      }
      return result
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
    const signal =
      init?.signal === null
        ? undefined
        : (init?.signal ?? (input instanceof Request ? input.signal : undefined))
    const token = await tokenManager.ensureValidToken(providerName, oauthConfig, signal)
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    if (init?.headers !== undefined) {
      for (const [name, value] of new Headers(init.headers)) {
        headers.set(name, value)
      }
    }
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

  // metadata.ts 只集中 registry/discovery 重复的 URL 与发现策略。动态索引异构
  // ProviderFactory 会丢失 provider/config 类型关联并需要不安全断言，因此保留穷尽 switch。
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

function selectApiKeys(
  providerName: string,
  apiKey: string | [string, ...string[]] | null | undefined,
  apiKeyIndexes: Map<string, number>,
): ResolvedProviderTransport {
  if (apiKey === undefined || apiKey === null) {
    return { apiKeys: [{ apiKey: undefined }] }
  }

  if (typeof apiKey === 'string') {
    return {
      apiKeys: [{ apiKey, index: 0 }],
      keySelection: { index: 0, count: 1 },
    }
  }

  const index = apiKeyIndexes.get(providerName) ?? 0
  const selectedIndex = index % apiKey.length
  apiKeyIndexes.set(providerName, index + 1)
  const apiKeys = apiKey.map((_, offset) => {
    const plannedIndex = (selectedIndex + offset) % apiKey.length
    const selectedApiKey = apiKey[plannedIndex]
    if (selectedApiKey === undefined) {
      throw new Error(`Missing API key at index ${plannedIndex} for provider '${providerName}'`)
    }
    return { apiKey: selectedApiKey, index: plannedIndex }
  })
  return {
    apiKeys,
    keySelection: { index: selectedIndex, count: apiKey.length },
  }
}

function createFailoverLanguageModel(
  models: LanguageModel[],
  keyCount: number,
  keyIndexes: number[],
  onKeySelection: ((selection: KeySelection) => void) | undefined,
  logger: Logger,
): LanguageModel {
  type WrappableLanguageModel = Parameters<typeof wrapLanguageModel>[0]['model']
  const delegates = models.map((model) =>
    wrapLanguageModel({ model: model as WrappableLanguageModel, middleware: {} }),
  )
  let current = 0

  const select = () => {
    const delegateIndex = current % delegates.length
    const delegate = delegates[delegateIndex]!
    onKeySelection?.({ index: keyIndexes[delegateIndex]!, count: keyCount })
    return delegate
  }

  const advanceAfterFailure = (): void => {
    current = (current + 1) % delegates.length
  }

  return wrapLanguageModel({
    model: delegates[0]!,
    middleware: {
      async wrapGenerate({ params }) {
        try {
          const result = await select().doGenerate(params)
          return result
        } catch (error) {
          advanceAfterFailure()
          throw error
        }
      },
      async wrapStream({ params }) {
        try {
          const result = await select().doStream(params)
          const reader = result.stream.getReader()
          const buffered = []

          while (true) {
            const next = await reader.read()
            if (next.done) {
              return { ...result, stream: replayProviderStream(buffered, reader) }
            }
            if (next.value.type === 'error') {
              try {
                await reader.cancel(next.value.error)
              } catch (cancelError) {
                logger.error({ err: cancelError }, 'provider failover stream cleanup failed')
              }
              throw toRetryableProviderStreamError(next.value.error)
            }
            if (next.value.type === 'raw') {
              const rawError = retryableProviderStreamError(next.value.rawValue)
              if (rawError) {
                try {
                  await reader.cancel(rawError)
                } catch (cancelError) {
                  logger.error({ err: cancelError }, 'provider failover stream cleanup failed')
                }
                throw rawError
              }
            }
            buffered.push(next.value)
            if (isProviderStreamCommitPart(next.value)) {
              return { ...result, stream: replayProviderStream(buffered, reader) }
            }
          }
        } catch (error) {
          advanceAfterFailure()
          throw toRetryableProviderStreamError(error)
        }
      },
    },
  })
}

function isProviderStreamCommitPart(part: { type: string; rawValue?: unknown }): boolean {
  if (part.type === 'raw') {
    const rawType =
      part.rawValue && typeof part.rawValue === 'object'
        ? (part.rawValue as Record<string, unknown>).type
        : undefined
    if (
      rawType === 'response.created' ||
      rawType === 'response.queued' ||
      rawType === 'response.in_progress'
    ) {
      return false
    }
  }
  return ![
    'stream-start',
    'response-metadata',
    'text-start',
    'text-end',
    'reasoning-start',
    'reasoning-end',
    'tool-input-end',
  ].includes(part.type)
}

function toRetryableProviderStreamError(error: unknown): unknown {
  return retryableProviderStreamError(error) ?? error
}

function retryableProviderStreamError(error: unknown): APICallError | undefined {
  if (APICallError.isInstance(error)) return error.isRetryable ? error : undefined

  const details = providerStreamErrorDetails(error)
  const retryableStatus =
    details.statusCode === 408 ||
    details.statusCode === 409 ||
    details.statusCode === 429 ||
    (details.statusCode !== undefined && details.statusCode >= 500)
  const retryableMarker =
    /rate.?limit|too.?many.?requests|temporar(?:y|ily).?unavailable|service.?unavailable|overload|server.?error|bad.?gateway|gateway.?timeout|connection.?(?:closed|reset)|socket.?connection|fetch.?failed|body.?terminated|\bterminated\b/i.test(
      `${details.code ?? ''} ${details.type ?? ''} ${details.message}`,
    )
  if (details.statusCode !== undefined && !retryableStatus) return undefined
  if (!retryableStatus && !retryableMarker) return undefined

  return new APICallError({
    message: details.message,
    url: 'provider-stream://upstream',
    requestBodyValues: {},
    ...(details.statusCode !== undefined ? { statusCode: details.statusCode } : {}),
    responseHeaders: { 'retry-after-ms': '0' },
    isRetryable: true,
    cause: error,
  })
}

function providerStreamErrorDetails(error: unknown): {
  message: string
  statusCode?: number
  code?: string
  type?: string
} {
  if (typeof error === 'string') return { message: error }
  if (!error || typeof error !== 'object') return { message: String(error) }

  const record = error as Record<string, unknown>
  const nestedSource =
    record.error && typeof record.error === 'object'
      ? record.error
      : record.response && typeof record.response === 'object'
        ? record.response
        : undefined
  const nested = nestedSource ? providerStreamErrorDetails(nestedSource) : undefined
  const statusValue = record.statusCode ?? record.status ?? nested?.statusCode
  const statusCode =
    typeof statusValue === 'number'
      ? statusValue
      : typeof statusValue === 'string' && /^\d{3}$/.test(statusValue)
        ? Number(statusValue)
        : undefined
  return {
    message:
      typeof record.message === 'string'
        ? record.message
        : (nested?.message ?? 'Upstream provider stream failed'),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(typeof record.code === 'string'
      ? { code: record.code }
      : nested?.code
        ? { code: nested.code }
        : {}),
    ...(typeof record.type === 'string'
      ? { type: record.type }
      : nested?.type
        ? { type: nested.type }
        : {}),
  }
}

function replayProviderStream<T>(
  buffered: T[],
  reader: ReadableStreamDefaultReader<T>,
): ReadableStream<T> {
  let bufferIndex = 0
  return new ReadableStream<T>({
    async pull(controller) {
      if (bufferIndex < buffered.length) {
        controller.enqueue(buffered[bufferIndex++]!)
        return
      }
      const next = await reader.read()
      if (next.done) {
        controller.close()
      } else {
        controller.enqueue(next.value)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}
