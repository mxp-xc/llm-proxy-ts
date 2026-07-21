import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Settings, OAuthConfig } from '../../../src/index.js'
import { TokenManager, OAuthError } from '../../../src/index.js'
import { createOAuthCallbackApp } from '../../../src/server/oauth/callback.js'
import type { OAuthCallbackDeps } from '../../../src/server/oauth/callback.js'
import { makeSettings } from '../../helpers/settings.js'

const authCodeConfig: OAuthConfig = {
  flow: 'authorization_code',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  authorizationUrl: 'https://auth.example.com/oauth2/authorize',
  scopes: ['api.read'],
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

function createTestLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return logger
}

describe('OAuth callback', () => {
  let tempDir: string
  let authFilePath: string
  let nonce: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oauth-callback-test-'))
    authFilePath = join(tempDir, 'auth.json')
    nonce = 'test-nonce-12345'
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(tempDir, { recursive: true, force: true })
  })

  function createDeps(
    tokenManager: TokenManager,
    overrides: Partial<Settings> = {},
  ): OAuthCallbackDeps {
    const settings = makeSettings({ 'oauth-provider': oauthProvider })
    return { settings: { ...settings, ...overrides }, tokenManager, nonce }
  }

  describe('GET /oauth/login/:provider', () => {
    it('redirects to authorization URL', async () => {
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()
      const app = createOAuthCallbackApp(createDeps(tokenManager))

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
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()
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
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()
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
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()
      const app = createOAuthCallbackApp(createDeps(tokenManager))
      const res = await app.request('/login/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /oauth/callback', () => {
    it('exchanges authorization code for token', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'exchanged-token',
            expires_in: 3600,
            token_type: 'Bearer',
            refresh_token: 'new-refresh',
          }),
      })

      const tokenManager = TokenManager.fromFile(authFilePath, mockFetch)
      await tokenManager.load()

      // Generate valid state
      const state = Buffer.from(JSON.stringify({ provider: 'oauth-provider', nonce })).toString(
        'base64url',
      )
      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      const res = await app.request(`/callback?code=auth-code-123&state=${state}`)

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Authentication Successful')
      expect(html).toContain('oauth-provider')
      expect(logger.info).toHaveBeenCalledWith(
        { provider: 'oauth-provider' },
        'oauth.callback.succeeded',
      )
    })

    it('logs full error object when authorization code exchange fails', async () => {
      const exchangeError = new Error('exchange exploded')
      const tokenManager = {
        exchangeCode: vi.fn().mockRejectedValue(exchangeError),
      } as unknown as TokenManager
      const logger = createTestLogger()

      const state = Buffer.from(JSON.stringify({ provider: 'oauth-provider', nonce })).toString(
        'base64url',
      )
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      const res = await app.request(`/callback?code=auth-code-123&state=${state}`)

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Authentication Failed')
      expect(html).toContain('exchange_failed')
      expect(html).not.toContain('exchange exploded')
      expect(logger.error).toHaveBeenCalledWith(
        { err: exchangeError, provider: 'oauth-provider' },
        'oauth.callback.failed',
      )
    })

    it('rejects invalid state (wrong nonce)', async () => {
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()

      const state = Buffer.from(
        JSON.stringify({ provider: 'oauth-provider', nonce: 'wrong-nonce' }),
      ).toString('base64url')
      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      const res = await app.request(`/callback?code=code&state=${state}`)

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Authentication Failed')
      expect(html).toContain('invalid_state')
      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'invalid_state' },
        'oauth.callback.invalid',
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(state)
    })

    it('handles OAuth error response', async () => {
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()

      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      const res = await app.request(
        '/callback?error=access_denied&error_description=User+cancelled',
      )

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Authentication Failed')
      expect(html).toContain('access_denied')
      expect(logger.warn).toHaveBeenCalledWith(
        { errorCode: 'access_denied' },
        'oauth.callback.rejected',
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('User cancelled')
    })

    it('does not copy arbitrary provider error text into telemetry', async () => {
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()

      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      await app.request('/callback?error=secret%20provider%20text')

      expect(logger.warn).toHaveBeenCalledWith(
        { errorCode: 'provider_error' },
        'oauth.callback.rejected',
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret provider text')
    })

    it('returns error for missing code or state', async () => {
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()

      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      const res = await app.request('/callback')

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Authentication Failed')
      expect(logger.warn).toHaveBeenCalledWith(
        { hasCode: false, hasState: false },
        'oauth.callback.invalid',
      )
    })
  })
})
