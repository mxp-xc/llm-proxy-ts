import { describe, expect, it, vi } from 'vitest'
import { OAuthError } from '../../src/oauth/index.js'
import { discoverProviderModels } from '../../src/cli/models/discovery.js'
import type { ModelDiscoveryRegistry } from '../../src/cli/models/discovery.js'
import { makeSettings } from '../helpers/settings.js'
import type {
  Settings,
  OpenAICompatibleProviderConfig,
  AnthropicProviderConfig,
  OpenAIProviderConfig,
} from '../../src/config.js'
import type { UpstreamModelResponse } from '../../src/cli/models/discover.js'
import type { DiscoveredModelList } from '../../src/plugins/types.js'
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

/** Build a minimal openai provider config. baseURL is optional for this type. */
function openaiProvider(overrides: Partial<OpenAIProviderConfig> = {}): OpenAIProviderConfig {
  return {
    type: 'openai',
    baseURL: 'https://api.example.com/v1',
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
function pluginRegistryMock(
  discover: (providerId: string) => Promise<DiscoveredModelList | undefined>,
): ModelDiscoveryRegistry {
  return {
    discoverModels: vi.fn(discover),
  }
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
    const pluginCause = new Error('plugin dependency failed')
    const pluginError = new Error('plugin boom', { cause: pluginCause })
    const pluginRegistry = pluginRegistryMock(async () => {
      throw pluginError
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
        cause: pluginError,
      },
    })
    if ('skipped' in result) {
      expect(result.skipped.cause).toBe(pluginError)
      expect((result.skipped.cause as Error).cause).toBe(pluginCause)
      expect((result.skipped.cause as Error).stack).toBe(pluginError.stack)
    }
  })

  it.each([
    {
      providerType: 'openai-compatible',
      provider: openaiCompatibleProvider(),
      expected: { baseURL: 'https://api.example.com/v1', authMode: 'bearer' },
    },
    {
      providerType: 'anthropic',
      provider: anthropicProvider({ baseURL: undefined }),
      expected: { baseURL: 'https://api.anthropic.com/v1', authMode: 'anthropic' },
    },
    {
      providerType: 'openai',
      provider: openaiProvider({ baseURL: undefined }),
      expected: { baseURL: 'https://api.openai.com/v1', authMode: 'bearer' },
    },
  ])('uses the default $providerType discovery parameters', async ({ provider, expected }) => {
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
    expect(fetchUpstream).toHaveBeenCalledWith(
      expect.objectContaining({
        ...expected,
        apiKey: 'test-key',
      }),
    )
  })

  it.each([
    {
      option: 'modelsEndpoint',
      provider: openaiCompatibleProvider({ options: { modelsEndpoint: '/custom/models' } }),
      expected: { modelsEndpoint: '/custom/models' },
    },
    {
      option: 'anthropicVersion',
      provider: anthropicProvider({ options: { anthropicVersion: '2024-10-22' } }),
      expected: { anthropicVersion: '2024-10-22' },
    },
    {
      option: 'openAIOptions',
      provider: openaiProvider({ options: { organization: 'org-test', project: 'proj-test' } }),
      expected: { openAIOptions: { organization: 'org-test', project: 'proj-test' } },
    },
  ])('parses provider-specific $option discovery options', async ({ provider, expected }) => {
    const settings = makeSettings({ myprov: provider })
    const fetchUpstream = fetchUpstreamMock()

    await discoverProviderModels({
      providerName: 'myprov',
      provider,
      settings,
      rawParsed: { providers: { myprov: { apiKey: 'test-key' } } },
      authFilePath,
      fetchUpstream,
    })

    expect(fetchUpstream).toHaveBeenCalledWith(expect.objectContaining(expected))
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
    const refreshCause = new Error('token endpoint unavailable')
    const refreshError = new OAuthError('refresh_failed', 'refresh exploded', {
      cause: refreshCause,
    })
    const tokenManager = tokenManagerMock({
      status: 'needs_refresh',
      ensureError: refreshError,
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
        cause: refreshError,
      },
    })
    if ('skipped' in result) {
      expect(result.skipped.cause).toBe(refreshError)
      expect((result.skipped.cause as Error).cause).toBe(refreshCause)
      expect((result.skipped.cause as Error).stack).toBe(refreshError.stack)
    }
  })

  it('returns ok via HTTP fallback with injected fetchUpstream', async () => {
    const existingModels = {
      old: { upstreamModel: 'gpt-4o', aliases: [], headers: {}, plugins: [] },
    }
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
      }),
    )
  })

  it('returns skipped fetch_failed when fetchUpstream throws', async () => {
    const provider = openaiCompatibleProvider()
    const settings = makeSettings({ myprov: provider })
    const fetchCause = new Error('socket closed')
    const fetchError = new Error('HTTP 500 oops', { cause: fetchCause })
    const fetchUpstream = vi.fn().mockRejectedValue(fetchError)

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
        cause: fetchError,
      },
    })
    if ('skipped' in result) {
      expect(result.skipped.cause).toBe(fetchError)
      expect((result.skipped.cause as Error).cause).toBe(fetchCause)
      expect((result.skipped.cause as Error).stack).toBe(fetchError.stack)
    }
  })

  it.each([
    { models: [{ id: '' }], expected: 'id' },
    { models: [{ id: 'bad-limit', context_length: 0 }], expected: 'context' },
    { models: [{ id: 'bad-limit', max_output_tokens: 1.5 }], expected: 'output' },
    {
      models: [{ id: 'bad-limit', context_length: Number.POSITIVE_INFINITY }],
      expected: 'context',
    },
  ])('rejects invalid HTTP discovery data: $expected', async ({ models, expected }) => {
    const provider = openaiCompatibleProvider()
    const settings = makeSettings({ myprov: provider })
    const fetchUpstream = fetchUpstreamMock(models as UpstreamModelResponse[])

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
        message: expect.stringMatching(new RegExp(`Invalid discovered models.*${expected}`, 's')),
        cause: expect.any(Error),
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
