import { resolveEnvPlaceholders } from '../../config.js'
import type { ModelRouteInput, ProviderConfig, Settings } from '../../config.js'
import { isRecord } from '../../providers/protocol-types.js'
import type { TokenManager } from '../../oauth/index.js'
import type { PluginRegistry } from '../../plugins/registry.js'
import type { DiscoveredModel } from '../../plugins/types.js'
import { fetchUpstreamModels, openAIToDiscoveredModels } from './discover.js'

export interface ProviderModelsResult {
  providerName: string
  models: DiscoveredModel[]
  existingModels: Record<string, ModelRouteInput>
  /** 模型来源：plugin = auth 插件 discoverModels；http = OpenAI 协议 fallback。 */
  source: 'plugin' | 'http'
}

export type DiscoverSkipReason =
  | 'plugin_failed'
  | 'type_unsupported'
  | 'oauth_needs_login'
  | 'oauth_refresh_failed'
  | 'fetch_failed'

export type DiscoverResult =
  | { ok: ProviderModelsResult }
  | { skipped: { providerName: string; reason: DiscoverSkipReason; message: string } }

export interface DiscoverInput {
  providerName: string
  provider: ProviderConfig
  settings: Settings
  rawParsed: unknown
  pluginRegistry?: PluginRegistry
  tokenManager?: TokenManager
  authFilePath: string
  fetchUpstream?: typeof fetchUpstreamModels
}

/**
 * 纯函数：编排单个 provider 的模型发现。
 *
 * 优先 auth 插件 discoverModels → anthropic/openai 类型跳过 → HTTP fallback（含 OAuth token 解析）。
 * 不含任何 clack UI 调用，返回 discriminated union 供调用方决定文案。
 */
export async function discoverProviderModels(input: DiscoverInput): Promise<DiscoverResult> {
  const { providerName, provider, settings, rawParsed, pluginRegistry, tokenManager, authFilePath } =
    input
  const fetchUpstream = input.fetchUpstream ?? fetchUpstreamModels

  // 1. 优先 auth 插件 discoverModels
  if (pluginRegistry) {
    try {
      const discovered = await pluginRegistry.discoverModels(providerName, undefined, authFilePath)
      if (discovered) {
        return {
          ok: {
            providerName,
            models: discovered.models,
            existingModels: provider.models,
            source: 'plugin',
          },
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        skipped: {
          providerName,
          reason: 'plugin_failed',
          message: `Auth plugin discoverModels failed — ${msg}`,
        },
      }
    }
  }

  // 2. anthropic / openai 类型不支持 OpenAI 协议发现
  if (provider.type === 'anthropic' || provider.type === 'openai') {
    return {
      skipped: {
        providerName,
        reason: 'type_unsupported',
        message: `${provider.type} provider does not support OpenAI model discovery`,
      },
    }
  }

  // 3. HTTP fallback
  try {
    if (!isRecord(rawParsed)) throw new Error('Invalid settings format')
    const rawProviders = rawParsed['providers']
    if (!isRecord(rawProviders)) throw new Error('No providers found in settings')
    const rawProvider = rawProviders[providerName]
    if (!isRecord(rawProvider)) throw new Error(`No raw provider config for ${providerName}`)
    const resolvedApiKey =
      rawProvider['apiKey'] != null
        ? (resolveEnvPlaceholders(rawProvider['apiKey']) as string | string[] | null)
        : provider.apiKey

    let oauthToken: { tokenType: string; accessToken: string } | undefined
    if (provider.oauth && tokenManager) {
      const status = tokenManager.getStatus(providerName, provider.oauth)
      if (status === 'needs_login') {
        return {
          skipped: {
            providerName,
            reason: 'oauth_needs_login',
            message:
              'OAuth login required. Start the server and visit /oauth/login/' +
              providerName +
              ' to authenticate.',
          },
        }
      }
      try {
        const token = await tokenManager.ensureValidToken(providerName, provider.oauth)
        oauthToken = { tokenType: token.tokenType, accessToken: token.accessToken }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          skipped: {
            providerName,
            reason: 'oauth_refresh_failed',
            message: `OAuth token refresh failed — ${msg}`,
          },
        }
      }
    }

    const openaiModels = await fetchUpstream({
      baseURL: provider.baseURL,
      apiKey: resolvedApiKey,
      proxySettings: settings.proxy,
      modelsEndpoint: provider.options?.modelsEndpoint,
      headers: provider.headers,
      oauthToken,
    })
    const models = openAIToDiscoveredModels(openaiModels).models
    return { ok: { providerName, models, existingModels: provider.models, source: 'http' } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { skipped: { providerName, reason: 'fetch_failed', message: msg } }
  }
}
