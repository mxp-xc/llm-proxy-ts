import { describe, expect, it, vi } from 'vitest'
import { OAuthError } from '../../src/oauth/index.js'
import { discoverProviderModels } from '../../src/cli/models-discovery.js'
import { makeSettings } from '../helpers/settings.js'
import type { Settings, OpenAICompatibleProviderConfig, AnthropicProviderConfig } from '../../src/config.js'
import type { UpstreamModelResponse } from '../../src/cli/discover-models.js'
import type { DiscoveredModelList } from '../../src/plugins/types.js'
import type { PluginRegistry } from '../../src/plugins/registry.js'
import type { TokenManager } from '../../src/oauth/index.js'

const authFilePath = '/tmp/auth.json'

/** Build a minimal openai-compatible provider config. */
function openaiCompatibleProvider(
  overrides: Partial<OpenAICompatibleProviderConfig> = {},
): OpenAICompatibleProviderConfig {
  return {
    type: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    apiKey: 'test-key',
    headers: {},
    plugins: [],
    models: {},
    ...overrides,
  }
}

function anthropicProvider(
  overrides: Partial<AnthropicProviderConfig> = {},
): AnthropicProviderConfig {
  return {
    type: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    apiKey: 'test-key',
    headers: {},
    plugins: [],
    models: {},
    ...overrides,
  }
}

/** A two-model upstream response, as fetchUpstreamModels would return. */
const upstreamModels: UpstreamModelResponse[] = [
  { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
  { id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' },
]

/** Build a fake fetchUpstream mock returning the given models. */
function fetchUpstreamMock(models: UpstreamModelResponse[] = upstreamModels) {
  return vi.fn().mockResolvedValue(models)
}

/** Construct a minimal PluginRegistry-shaped mock. */
function pluginRegistryMock(discover: (providerId: string) => Promise<DiscoveredModelList | undefined>) {
  return {
    discoverModels: vi.fn(discover),
  } as unknown as PluginRegistry
}

/** Construct a minimal TokenManager-shaped mock. */
function tokenManagerMock(opts: {
  status?: 'valid' | 'needs_refresh' | 'needs_login'
  token?: { tokenType: string; accessToken: string }
  ensureError?: Error
}) {
  return {
    getStatus: vi.fn(() => opts.status ?? 'valid'),
    ensureValidToken: vi.fn(async () => {
      if (opts.ensureError) throw opts.ensureError
      return opts.token ?? { tokenType: 'Bearer', accessToken: 'access-token' }
    }),
  } as unknown as TokenManager
}

const oauthConfig = {
  flow: 'authorization_code' as const,
  clientId: 'client-id',
  clientSecret: 'client-secret',
  tokenUrl: 'https://token.example.com/token',
  authorizationUrl: 'https://token.example.com/auth',
  scopes: [],
}

describe('discoverProviderModels', () => {
  it('returns ok when auth plugin discoverModels returns models', async () => {
    const provider = openaiCompatibleProvider({
      models: { existing: { upstreamModel: 'old', aliases: [], headers: {}, plugins: [] } },
    })
    const settings = makeSettings({ myprov: provider })
    const pluginList: DiscoveredModelList = { models: [{ id: 'plugin-model' }] }
    const pluginRegistry = pluginRegistryMock(async () => pluginList)

    const result = await discoverProviderModels({
      providerName: 'myprov',
      provider,
      settings,
      rawParsed: {},
      pluginRegistry,
      authFilePath,
    })

    expect(result).toHaveProperty('ok')
    if ('ok' in result) {
      expect(result.ok.providerName).toBe('myprov')
      expect(result.ok.models).toEqual([{ id: 'plugin-model' }])
      expect(result.ok.source).toBe('plugin')
      // existingModels is the provider's resolved models, returned by reference
      expect(result.ok.existingModels).toBe(provider.models)
    }
    expect(pluginRegistry.discoverModels).toHaveBeenCalledWith('myprov', undefined, authFilePath)
  })

  it('returns skipped plugin_failed when discoverModels throws', async () => {
    const provider = openaiCompatibleProvider()
    const settings = makeSettings({ myprov: provider })
    const pluginRegistry = pluginRegistryMock(async () => {
      throw new Error('plugin boom')
    })

    const result = await discoverProviderModels({
      providerName: 'myprov',
      provider,
      settings,
      rawParsed: {},
      pluginRegistry,
      authFilePath,
    })

    expect(result).toEqual({
      skipped: {
        providerName: 'myprov',
        reason: 'plugin_failed',
        message: 'Auth plugin discoverModels failed — plugin boom',
      },
    })
  })

  it('returns skipped type_unsupported for anthropic provider (no plugin)', async () => {
    const provider = anthropicProvider()
    const settings = makeSettings({ myprov: provider })

    const result = await discoverProviderModels({
      providerName: 'myprov',
      provider,
      settings,
      rawParsed: {},
      authFilePath,
    })

    expect(result).toEqual({
      skipped: {
        providerName: 'myprov',
        reason: 'type_unsupported',
        message: 'anthropic provider does not support OpenAI model discovery',
      },
    })
  })

  it('returns skipped oauth_needs_login when token status is needs_login', async () => {
    const provider = openaiCompatibleProvider({ oauth: oauthConfig })
    const settings = makeSettings({ myprov: provider })
    const tokenManager = tokenManagerMock({ status: 'needs_login' })

    const result = await discoverProviderModels({
      providerName: 'myprov',
      provider,
      settings,
      rawParsed: { providers: { myprov: { apiKey: 'test-key' } } },
      tokenManager,
      authFilePath,
    })

    expect(result).toEqual({
      skipped: {
        providerName: 'myprov',
        reason: 'oauth_needs_login',
        message:
          'OAuth login required. Start the server and visit /oauth/login/myprov to authenticate.',
      },
    })
    expect(tokenManager.ensureValidToken).not.toHaveBeenCalled()
  })

  it('returns skipped oauth_refresh_failed when ensureValidToken throws OAuthError', async () => {
    const provider = openaiCompatibleProvider({ oauth: oauthConfig })
    const settings = makeSettings({ myprov: provider })
    const tokenManager = tokenManagerMock({
      status: 'needs_refresh',
      ensureError: new OAuthError('refresh_failed', 'refresh exploded'),
    })

    const result = await discoverProviderModels({
      providerName: 'myprov',
      provider,
      settings,
      rawParsed: { providers: { myprov: { apiKey: 'test-key' } } },
      tokenManager,
      authFilePath,
    })

    expect(result).toEqual({
      skipped: {
        providerName: 'myprov',
        reason: 'oauth_refresh_failed',
        message: 'OAuth token refresh failed — refresh exploded',
      },
    })
  })

  it('returns ok via HTTP fallback with injected fetchUpstream', async () => {
    const existingModels = { old: { upstreamModel: 'gpt-4o', aliases: [], headers: {}, plugins: [] } }
    const provider = openaiCompatibleProvider({ models: existingModels })
    const settings = makeSettings({ myprov: provider })
    const fetchUpstream = fetchUpstreamMock()

    const result = await discoverProviderModels({
      providerName: 'myprov',
      provider,
      settings,
      rawParsed: { providers: { myprov: { apiKey: 'test-key' } } },
      authFilePath,
      fetchUpstream,
    })

    expect(result).toHaveProperty('ok')
    if ('ok' in result) {
      expect(result.ok.providerName).toBe('myprov')
      expect(result.ok.models).toEqual([{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }])
      expect(result.ok.source).toBe('http')
      expect(result.ok.existingModels).toBe(provider.models)
    }
    expect(fetchUpstream).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test-key',
        modelsEndpoint: undefined,
      }),
    )
  })

  it('returns skipped fetch_failed when fetchUpstream throws', async () => {
    const provider = openaiCompatibleProvider()
    const settings = makeSettings({ myprov: provider })
    const fetchUpstream = vi.fn().mockRejectedValue(new Error('HTTP 500 oops'))

    const result = await discoverProviderModels({
      providerName: 'myprov',
      provider,
      settings,
      rawParsed: { providers: { myprov: { apiKey: 'test-key' } } },
      authFilePath,
      fetchUpstream,
    })

    expect(result).toEqual({
      skipped: {
        providerName: 'myprov',
        reason: 'fetch_failed',
        message: 'HTTP 500 oops',
      },
    })
  })

  it('falls back to HTTP when plugin returns undefined (no oauth)', async () => {
    const provider = openaiCompatibleProvider()
    const settings: Settings = makeSettings({ myprov: provider })
    const pluginRegistry = pluginRegistryMock(async () => undefined)
    const fetchUpstream = fetchUpstreamMock()

    const result = await discoverProviderModels({
      providerName: 'myprov',
      provider,
      settings,
      rawParsed: { providers: { myprov: { apiKey: 'test-key' } } },
      pluginRegistry,
      authFilePath,
      fetchUpstream,
    })

    expect(result).toHaveProperty('ok')
    if ('ok' in result) {
      expect(result.ok.models).toEqual([{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }])
      expect(result.ok.source).toBe('http')
    }
    expect(pluginRegistry.discoverModels).toHaveBeenCalled()
    expect(fetchUpstream).toHaveBeenCalled()
  })
})
