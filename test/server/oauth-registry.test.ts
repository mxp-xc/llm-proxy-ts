import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { OAuthConfig } from '../../src/index.js'
import { TokenManager, OAuthError, createProviderRegistry } from '../../src/index.js'
import { makeSettings } from '../helpers/settings.js'
import { createCapturingProviderFactory } from '../helpers/provider-factory.js'

const oauthConfig: OAuthConfig = {
  flow: 'client_credentials',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  scopes: [],
}

const { factory: stubFactory, inputs: capturedFactoryInputs } = createCapturingProviderFactory()

describe('OAuth provider registry', () => {
  let tempDir: string
  let authFilePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oauth-registry-test-'))
    authFilePath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    capturedFactoryInputs.length = 0
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

    const registry = await createProviderRegistry(
      settings,
      tokenManager,
      undefined,
      undefined,
      undefined,
      stubFactory,
    )
    const result = registry.languageModel('oauth-provider', 'm', {})

    expect(result.model).toBeTruthy()
    expect(capturedFactoryInputs).toHaveLength(1)
    expect(capturedFactoryInputs[0]!.providerName).toBe('oauth-provider')
    expect(capturedFactoryInputs[0]!.selectedApiKey).toBeUndefined()
    expect(capturedFactoryInputs[0]!.customFetch).toBeDefined()
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

    const registry = await createProviderRegistry(
      settings,
      undefined,
      undefined,
      undefined,
      undefined,
      stubFactory,
    )
    const result = registry.languageModel('static-provider', 'm', {})

    expect(result.model).toBeTruthy()
    expect(capturedFactoryInputs).toHaveLength(1)
    expect(capturedFactoryInputs[0]!.selectedApiKey).toBe('static-key')
    expect(capturedFactoryInputs[0]!.customFetch).toBeUndefined()
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

    const registry = await createProviderRegistry(
      settings,
      tokenManager,
      undefined,
      undefined,
      undefined,
      stubFactory,
    )
    const result = registry.languageModel('both-provider', 'm', {})

    expect(result.model).toBeTruthy()
    expect(capturedFactoryInputs).toHaveLength(1)
    expect(capturedFactoryInputs[0]!.selectedApiKey).toBeUndefined()
    expect(capturedFactoryInputs[0]!.customFetch).toBeDefined()
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

    const registry = await createProviderRegistry(
      settings,
      tokenManager,
      undefined,
      undefined,
      undefined,
      stubFactory,
    )
    const result = registry.languageModel('auth-code-provider', 'm', {})
    expect(result.model).toBeTruthy()
    expect(capturedFactoryInputs).toHaveLength(1)
    const oauthFetch = capturedFactoryInputs[0]!.customFetch
    expect(oauthFetch).toBeDefined()

    const fetchWithOauth = oauthFetch!(() => Promise.resolve(new Response('{}')))
    await expect(fetchWithOauth('https://api.example.com/v1/models')).rejects.toMatchObject({
      code: 'auth_required',
    } satisfies Partial<OAuthError>)
  })
})
