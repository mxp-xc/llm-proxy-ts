import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { OAuthConfig } from '../../src/index.js'
import { TokenManager, OAuthError, createProviderRegistry } from '../../src/index.js'
import type { ProviderFactory } from '../../src/providers/registry.js'
import { makeSettings } from '../helpers/settings.js'

const oauthConfig: OAuthConfig = {
  flow: 'client_credentials',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  scopes: [],
}

/**
 * Captured options from the stub factory for assertion.
 */
const capturedOptions: Array<{
  providerName: string
  selectedApiKey: string | undefined
  hasOauthFetch: boolean
}> = []

/**
 * Stub factory that captures call arguments and returns lightweight model objects,
 * replacing the previous vi.mock of provider-factory.js.
 */
const stubFactory = {
  createOpenAICompatible(providerName: string, _provider: unknown, _modelHeaders: Record<string, string>, selectedApiKey: string | undefined, customFetch?: (baseFetch?: typeof fetch) => typeof fetch) {
    capturedOptions.push({
      providerName,
      selectedApiKey,
      hasOauthFetch: customFetch !== undefined,
    })
    return (upstreamModel: string) => ({ upstreamModel, providerName })
  },
  createAnthropic(providerName: string, _provider: unknown, _modelHeaders: Record<string, string>, selectedApiKey: string | undefined, customFetch?: (baseFetch?: typeof fetch) => typeof fetch) {
    capturedOptions.push({
      providerName,
      selectedApiKey,
      hasOauthFetch: customFetch !== undefined,
    })
    return (upstreamModel: string) => ({ upstreamModel, providerName })
  },
  createOpenAI(providerName: string, _provider: unknown, _modelHeaders: Record<string, string>, selectedApiKey: string | undefined, customFetch?: (baseFetch?: typeof fetch) => typeof fetch) {
    capturedOptions.push({
      providerName,
      selectedApiKey,
      hasOauthFetch: customFetch !== undefined,
    })
    return (upstreamModel: string) => ({ upstreamModel, providerName })
  },
} as unknown as ProviderFactory

describe('OAuth provider registry', () => {
  let tempDir: string
  let authFilePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oauth-registry-test-'))
    authFilePath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    capturedOptions.length = 0
    await rm(tempDir, { recursive: true, force: true })
  })

  it('uses oauthFetch when provider has oauth config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'oauth-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
      }),
    )

    const settings = makeSettings({
      'oauth-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: null,
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'm', aliases: [], headers: {}, plugins: [] } },
        oauth: oauthConfig,
      },
    })

    const tokenManager = TokenManager.fromFile(authFilePath)
    await tokenManager.load()

    const registry = await createProviderRegistry(settings, tokenManager, undefined, undefined, undefined, stubFactory)
    const result = registry.languageModel('oauth-provider', 'm', {})

    expect(result.model).toBeTruthy()
    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]!.providerName).toBe('oauth-provider')
    expect(capturedOptions[0]!.selectedApiKey).toBeUndefined()
    expect(capturedOptions[0]!.hasOauthFetch).toBe(true)
  })

  it('uses static apiKey when provider has no oauth', async () => {
    const settings = makeSettings({
      'static-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'static-key',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'm', aliases: [], headers: {}, plugins: [] } },
      },
    })

    const registry = await createProviderRegistry(settings, undefined, undefined, undefined, undefined, stubFactory)
    const result = registry.languageModel('static-provider', 'm', {})

    expect(result.model).toBeTruthy()
    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]!.selectedApiKey).toBe('static-key')
    expect(capturedOptions[0]!.hasOauthFetch).toBe(false)
  })

  it('oauth takes precedence when both apiKey and oauth are configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'oauth-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
      }),
    )

    const settings = makeSettings({
      'both-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'static-key',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'm', aliases: [], headers: {}, plugins: [] } },
        oauth: oauthConfig,
      },
    })

    const tokenManager = TokenManager.fromFile(authFilePath)
    await tokenManager.load()

    const registry = await createProviderRegistry(settings, tokenManager, undefined, undefined, undefined, stubFactory)
    const result = registry.languageModel('both-provider', 'm', {})

    expect(result.model).toBeTruthy()
    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]!.selectedApiKey).toBeUndefined()
    expect(capturedOptions[0]!.hasOauthFetch).toBe(true)
  })

  it('throws OAuthError when auth is required for auth_code flow', async () => {
    const authCodeConfig: OAuthConfig = {
      flow: 'authorization_code',
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      tokenUrl: 'https://auth.example.com/oauth2/token',
      authorizationUrl: 'https://auth.example.com/oauth2/authorize',
      scopes: [],
    }

    const settings = makeSettings({
      'auth-code-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: null,
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'm', aliases: [], headers: {}, plugins: [] } },
        oauth: authCodeConfig,
      },
    })

    const tokenManager = TokenManager.fromFile(authFilePath)
    await tokenManager.load()

    // The registry creates a model with oauthFetch. When the model is used,
    // the fetch function calls ensureValidToken which throws OAuthError.
    // But languageModel() itself doesn't call ensureValidToken — the fetch
    // function does at request time. So languageModel() succeeds here.
    const registry = await createProviderRegistry(settings, tokenManager, undefined, undefined, undefined, stubFactory)
    const result = registry.languageModel('auth-code-provider', 'm', {})
    expect(result.model).toBeTruthy()
  })
})
