import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Settings, OAuthConfig } from '@llm-proxy/core'
import { TokenManager, OAuthError } from '@llm-proxy/core'
import { createOAuthCallbackApp } from '../src/oauth/callback.js'
import type { OAuthCallbackDeps } from '../src/oauth/callback.js'

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
