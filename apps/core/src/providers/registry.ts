import type { LanguageModel } from 'ai';
import type { Settings, OAuthConfig, ProviderConfig } from '../config.js';
import type { TokenManager } from '../oauth/index.js';
import type { Logger } from '../types.js';
import type { AuthPluginContext, ResolvedAuthPlugin } from '../auth/types.js';
import { createPluginStore } from '../auth/store-adapter.js';
import { createOpenAICompatibleProvider, sanitizeHeaders } from '../openai-compatible.js';

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() { return noopLogger; },
};

export interface ProviderRegistry {
  languageModel(providerName: string, upstreamModel: string, modelHeaders: Record<string, string>): LanguageModel;
  debugProviderConfig(providerName: string): { baseURL: string; headers: Record<string, string>; proxyEnabled: boolean };
}

export function createProviderRegistry(
  settings: Settings,
  tokenManager?: TokenManager,
  logger?: Logger,
  authPlugins?: Map<string, ResolvedAuthPlugin>,
  authFilePath?: string,
): ProviderRegistry {
  const log = logger ?? noopLogger;
  const apiKeyIndexes = new Map<string, number>();

  return {
    languageModel(providerName, upstreamModel, modelHeaders) {
      const provider = settings.providers[providerName];
      if (!provider) {
        throw new Error(`Unknown provider '${providerName}'`);
      }

      // Auth 插件路径：使用插件的 fetch wrapper
      if (provider.auth && authPlugins) {
        const resolved = authPlugins.get(providerName);
        if (!resolved) {
          throw new Error(`Auth plugin not loaded for provider '${providerName}'`);
        }
        const ctx = buildAuthPluginContext(providerName, provider, resolved, log, authFilePath);
        const authFetch = resolved.plugin.createFetch(ctx);
        return createOpenAICompatibleProvider(
          providerName, provider, settings, modelHeaders, undefined, authFetch,
        )(upstreamModel);
      }

      // OAuth 路径：使用动态 fetch 注入 token
      if (provider.oauth && tokenManager) {
        const oauthFetch = createOAuthFetch(providerName, provider.oauth, tokenManager);
        return createOpenAICompatibleProvider(
          providerName, provider, settings, modelHeaders, undefined, oauthFetch,
        )(upstreamModel);
      }

      // 静态 API Key 路径（现有逻辑）
      const selection = selectApiKey(providerName, provider.apiKey, apiKeyIndexes);
      if (selection) {
        log.info(
          { provider: providerName, keyIndex: selection.index, keyCount: selection.count },
          'selected api key for provider',
        );
      }

      return createOpenAICompatibleProvider(providerName, provider, settings, modelHeaders, selection?.apiKey)(upstreamModel);
    },
    debugProviderConfig(providerName) {
      const provider = settings.providers[providerName];
      if (!provider) {
        throw new Error(`Unknown provider '${providerName}'`);
      }

      return {
        baseURL: provider.baseURL,
        headers: sanitizeHeaders(provider.headers),
        proxyEnabled: settings.proxy !== null,
      };
    },
  };
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
    const token = await tokenManager.ensureValidToken(providerName, oauthConfig);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `${token.tokenType} ${token.accessToken}`);
    const fetchFn = baseFetch ?? globalThis.fetch;
    return fetchFn(input, { ...init, headers });
  };
}

function selectApiKey(
  providerName: string,
  apiKey: string | [string, ...string[]] | null | undefined,
  apiKeyIndexes: Map<string, number>,
): { apiKey: string; index: number; count: number } | undefined {
  if (apiKey === undefined || apiKey === null) {
    return undefined;
  }

  if (typeof apiKey === 'string') {
    return { apiKey, index: 0, count: 1 };
  }

  const index = apiKeyIndexes.get(providerName) ?? 0;
  const selectedIndex = index % apiKey.length;
  const selectedApiKey = apiKey[selectedIndex];
  if (selectedApiKey === undefined) {
    throw new Error(`Missing API key at index ${selectedIndex} for provider '${providerName}'`);
  }
  apiKeyIndexes.set(providerName, index + 1);
  return { apiKey: selectedApiKey, index: selectedIndex, count: apiKey.length };
}

function buildAuthPluginContext(
  providerName: string,
  provider: ProviderConfig,
  resolved: ResolvedAuthPlugin,
  log: Logger,
  authFilePath?: string,
): AuthPluginContext {
  return {
    providerName,
    baseURL: provider.baseURL,
    config: provider.auth?.config ?? {},
    store: authFilePath ? createPluginStore(authFilePath, providerName) : undefined,
    log: log.child({ component: 'auth-plugin', plugin: resolved.plugin.name, provider: providerName }),
  };
}
