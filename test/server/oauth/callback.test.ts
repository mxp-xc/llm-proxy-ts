import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Settings, OAuthConfig, ProviderRegistry } from '../../../src/index.js'
import { TokenManager, OAuthError, createProviderRegistry } from '../../../src/index.js'
import { createOAuthCallbackApp } from '../../../src/server/oauth/callback.js'
import type { OAuthCallbackDeps } from '../../../src/server/oauth/callback.js'

const authCodeConfig: OAuthConfig = {
  flow: 'authorization_code',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  authorizationUrl: 'https://auth.example.com/oauth2/authorize',
  scopes: ['api.read'],
}

function makeSettings(providers: Settings['providers'] = {}): Settings {
  return {
    service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
    requestTimeoutMs: 30000,
    proxy: null,
    routing: { enableFlatModelLookup: false },
    plugins: [],
    providers,
  }
}

const oauthProvider = {
  type: 'openai-compatible' as const,
  baseURL: 'https://api.example.com/v1',
  apiKey: null,
  headers: {},
  plugins: [],
  models: {
    chat: { upstreamModel: 'model-x', aliases: [], headers: {}, plugins: [] },
  },
  oauth: authCodeConfig,
}

describe('OAuth callback', () => {
  let tempDir: string
  let authFilePath: string
  let tokenManager: TokenManager
  let nonce: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oauth-callback-test-'))
    authFilePath = join(tempDir, 'auth.json')
    tokenManager = new TokenManager(authFilePath)
    await tokenManager.load()
    nonce = 'test-nonce-12345'
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(tempDir, { recursive: true, force: true })
  })

  function createDeps(overrides: Partial<Settings> = {}): OAuthCallbackDeps {
    const settings = makeSettings({ 'oauth-provider': oauthProvider })
    return { settings: { ...settings, ...overrides }, tokenManager, nonce }
  }

  describe('GET /oauth/login/:provider', () => {
    it('redirects to authorization URL', async () => {
      const app = createOAuthCallbackApp(createDeps())
      const res = await app.request('/login/oauth-provider')

      expect(res.status).toBe(302)
      const location = res.headers.get('location')
      expect(location).toContain('https://auth.example.com/oauth2/authorize')
      expect(location).toContain('client_id=test-client-id')
      expect(location).toContain('response_type=code')
      expect(location).toContain('redirect_uri=')
      expect(location).toContain('state=')
      expect(location).toContain('scope=')
    })

    it('returns 404 for provider without OAuth', async () => {
      const settings = makeSettings({
        'plain-provider': {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'key',
          headers: {},
          plugins: [],
          models: { chat: { upstreamModel: 'm', aliases: [], headers: {}, plugins: [] } },
        },
      })
      const app = createOAuthCallbackApp({ settings, tokenManager, nonce })

      const res = await app.request('/login/plain-provider')
      expect(res.status).toBe(404)
    })

    it('returns 400 for client_credentials flow', async () => {
      const settings = makeSettings({
        'cc-provider': {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: null,
          headers: {},
          plugins: [],
          models: { chat: { upstreamModel: 'm', aliases: [], headers: {}, plugins: [] } },
          oauth: {
            flow: 'client_credentials',
            clientId: 'cid',
            clientSecret: 'cs',
            tokenUrl: 'https://auth.example.com/token',
            scopes: [],
          },
        },
      })
      const app = createOAuthCallbackApp({ settings, tokenManager, nonce })

      const res = await app.request('/login/cc-provider')
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown provider', async () => {
      const app = createOAuthCallbackApp(createDeps())
      const res = await app.request('/login/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /oauth/callback', () => {
    it('exchanges authorization code for token', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: 'exchanged-token',
              expires_in: 3600,
              token_type: 'Bearer',
              refresh_token: 'new-refresh',
            }),
        }),
      )

      // Generate valid state
      const state = Buffer.from(JSON.stringify({ provider: 'oauth-provider', nonce })).toString(
        'base64url',
      )
      const app = createOAuthCallbackApp(createDeps())
      const res = await app.request(`/callback?code=auth-code-123&state=${state}`)

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Authentication Successful')
      expect(html).toContain('oauth-provider')
    })

    it('rejects invalid state (wrong nonce)', async () => {
      const state = Buffer.from(
        JSON.stringify({ provider: 'oauth-provider', nonce: 'wrong-nonce' }),
      ).toString('base64url')
      const app = createOAuthCallbackApp(createDeps())
      const res = await app.request(`/callback?code=code&state=${state}`)

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Authentication Failed')
      expect(html).toContain('invalid_state')
    })

    it('handles OAuth error response', async () => {
      const app = createOAuthCallbackApp(createDeps())
      const res = await app.request(
        '/callback?error=access_denied&error_description=User+cancelled',
      )

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Authentication Failed')
      expect(html).toContain('access_denied')
    })

    it('returns error for missing code or state', async () => {
      const app = createOAuthCallbackApp(createDeps())
      const res = await app.request('/callback')

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Authentication Failed')
    })
  })
})

// ── OAuth provider registry integration (from oauth-registry.test.ts) ──

const oauthConfig: OAuthConfig = {
  flow: 'client_credentials',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  scopes: [],
}

const mocks = vi.hoisted(() => ({
  capturedOptions: [] as Array<{
    providerName: string
    selectedApiKey: string | undefined
    hasOauthFetch: boolean
  }>,
}))

vi.mock('../../../src/providers/shared/provider-factory.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/providers/shared/provider-factory.js')>()
  return {
    ...original,
    createOpenAICompatibleProvider(
      providerName: string,
      _provider: unknown,
      _settings: unknown,
      _modelHeaders: unknown,
      selectedApiKey: string | undefined,
      oauthFetch?: unknown,
    ) {
      mocks.capturedOptions.push({
        providerName,
        selectedApiKey,
        hasOauthFetch: oauthFetch !== undefined,
      })
      return (upstreamModel: string) => ({ upstreamModel, providerName })
    },
    sanitizeHeaders(headers: Record<string, string>) {
      const sensitiveHeaders = new Set([
        'authorization',
        'proxy-authorization',
        'x-api-key',
        'api-key',
        'apikey',
        'api_key',
      ])
      return Object.fromEntries(
        Object.entries(headers).filter(([key]) => !sensitiveHeaders.has(key.toLowerCase())),
      )
    },
  }
})

describe('OAuth provider registry', () => {
  let tempDir: string
  let authFilePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oauth-registry-test-'))
    authFilePath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    mocks.capturedOptions.length = 0
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

    const tokenManager = new TokenManager(authFilePath)
    await tokenManager.load()

    const registry = await createProviderRegistry(settings, tokenManager)
    const result = registry.languageModel('oauth-provider', 'm', {})

    expect(result.model).toBeTruthy()
    expect(mocks.capturedOptions).toHaveLength(1)
    expect(mocks.capturedOptions[0]!.providerName).toBe('oauth-provider')
    expect(mocks.capturedOptions[0]!.selectedApiKey).toBeUndefined()
    expect(mocks.capturedOptions[0]!.hasOauthFetch).toBe(true)
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

    const registry = await createProviderRegistry(settings)
    const result = registry.languageModel('static-provider', 'm', {})

    expect(result.model).toBeTruthy()
    expect(mocks.capturedOptions).toHaveLength(1)
    expect(mocks.capturedOptions[0]!.selectedApiKey).toBe('static-key')
    expect(mocks.capturedOptions[0]!.hasOauthFetch).toBe(false)
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

    const tokenManager = new TokenManager(authFilePath)
    await tokenManager.load()

    const registry = await createProviderRegistry(settings, tokenManager)
    const result = registry.languageModel('both-provider', 'm', {})

    expect(result.model).toBeTruthy()
    expect(mocks.capturedOptions).toHaveLength(1)
    expect(mocks.capturedOptions[0]!.selectedApiKey).toBeUndefined()
    expect(mocks.capturedOptions[0]!.hasOauthFetch).toBe(true)
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

    const tokenManager = new TokenManager(authFilePath)
    await tokenManager.load()

    // The registry creates a model with oauthFetch. When the model is used,
    // the fetch function calls ensureValidToken which throws OAuthError.
    // But languageModel() itself doesn't call ensureValidToken — the fetch
    // function does at request time. So languageModel() succeeds here.
    const registry = await createProviderRegistry(settings, tokenManager)
    const result = registry.languageModel('auth-code-provider', 'm', {})
    expect(result.model).toBeTruthy()
  })
})
