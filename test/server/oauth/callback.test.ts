import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Settings, OAuthConfig } from '../../../src/index.js'
import { TokenManager } from '../../../src/index.js'
import { createOAuthCallbackApp } from '../../../src/server/oauth/callback.js'
import type { OAuthCallbackDeps } from '../../../src/server/oauth/callback.js'
import { makeToken } from '../../helpers/oauth.js'
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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oauth-callback-test-'))
    authFilePath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(tempDir, { recursive: true, force: true })
  })

  function createDeps(
    tokenManager: TokenManager,
    overrides: Partial<Settings> = {},
    now?: () => number,
  ): OAuthCallbackDeps {
    const settings = makeSettings({ 'oauth-provider': oauthProvider })
    return {
      settings: { ...settings, ...overrides },
      tokenManager,
      ...(now ? { now } : {}),
    }
  }

  async function loginState(app: ReturnType<typeof createOAuthCallbackApp>): Promise<string> {
    const response = await app.request('/login/oauth-provider')
    const location = response.headers.get('location')
    return new URL(location!).searchParams.get('state')!
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

    it('generates a different state for every login', async () => {
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()
      const app = createOAuthCallbackApp(createDeps(tokenManager))

      expect(await loginState(app)).not.toBe(await loginState(app))
    })

    it('evicts the oldest pending state when capacity is reached', async () => {
      const tokenManager = {
        exchangeCode: vi.fn().mockResolvedValue(makeToken()),
      } as unknown as TokenManager
      const app = createOAuthCallbackApp({
        ...createDeps(tokenManager),
        maxPendingStates: 2,
      })
      const oldestState = await loginState(app)
      const nextState = await loginState(app)
      const newestState = await loginState(app)

      const oldestResponse = await app.request(`/callback?code=oldest&state=${oldestState}`)
      const nextResponse = await app.request(`/callback?code=next&state=${nextState}`)
      const newestResponse = await app.request(`/callback?code=newest&state=${newestState}`)

      expect(await oldestResponse.text()).toContain('invalid_state')
      expect(await nextResponse.text()).toContain('Authentication Successful')
      expect(await newestResponse.text()).toContain('Authentication Successful')
      expect(tokenManager.exchangeCode).toHaveBeenCalledTimes(2)
    })

    it('removes expired states before evicting an unexpired state', async () => {
      let now = 1_000_000
      const tokenManager = {
        exchangeCode: vi.fn().mockResolvedValue(makeToken()),
      } as unknown as TokenManager
      const app = createOAuthCallbackApp({
        ...createDeps(tokenManager, {}, () => now),
        maxPendingStates: 2,
      })
      const expiredState = await loginState(app)
      now += 10 * 60 * 1000 - 1
      const unexpiredState = await loginState(app)
      now += 2

      const newestState = await loginState(app)
      const expiredResponse = await app.request(`/callback?code=expired&state=${expiredState}`)
      const unexpiredResponse = await app.request(
        `/callback?code=unexpired&state=${unexpiredState}`,
      )
      const newestResponse = await app.request(`/callback?code=newest&state=${newestState}`)

      expect(await expiredResponse.text()).toContain('invalid_state')
      expect(await unexpiredResponse.text()).toContain('Authentication Successful')
      expect(await newestResponse.text()).toContain('Authentication Successful')
      expect(tokenManager.exchangeCode).toHaveBeenCalledTimes(2)
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
      const app = createOAuthCallbackApp({ settings, tokenManager })

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
      const app = createOAuthCallbackApp({ settings, tokenManager })

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

      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      const state = await loginState(app)
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

    it('passes the callback request signal to the token exchange', async () => {
      let exchangeSignal: AbortSignal | undefined
      const mockFetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
        exchangeSignal = init?.signal ?? undefined
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'exchanged-token',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )
      })
      const tokenManager = TokenManager.fromFile(authFilePath, mockFetch)
      await tokenManager.load()
      const app = createOAuthCallbackApp(createDeps(tokenManager))
      const state = await loginState(app)
      const controller = new AbortController()
      const request = new Request(`http://localhost/callback?code=auth-code-123&state=${state}`, {
        signal: controller.signal,
      })

      const response = await app.request(request)

      expect(response.status).toBe(200)
      expect(exchangeSignal).toBe(request.signal)
    })

    it('logs callback cancellation as an expected abort', async () => {
      let markExchangeStarted: (() => void) | undefined
      const exchangeStarted = new Promise<void>((resolve) => {
        markExchangeStarted = resolve
      })
      const tokenManager = {
        exchangeCode: vi.fn(
          async (
            _providerName: string,
            _config: OAuthConfig,
            _code: string,
            _redirectUri: string,
            signal?: AbortSignal,
          ) => {
            if (!signal) throw new Error('missing callback signal')
            markExchangeStarted?.()
            return await new Promise<never>((_, reject) => {
              const rejectOnAbort = () => reject(signal.reason)
              if (signal.aborted) rejectOnAbort()
              else signal.addEventListener('abort', rejectOnAbort, { once: true })
            })
          },
        ),
      } as unknown as TokenManager
      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      const state = await loginState(app)
      const controller = new AbortController()
      const request = new Request(`http://localhost/callback?code=auth-code-123&state=${state}`, {
        signal: controller.signal,
      })

      const responsePromise = app.request(request)
      await exchangeStarted
      const abortError = new DOMException('client disconnected', 'AbortError')
      controller.abort(abortError)
      const response = await responsePromise

      expect(response.status).toBe(200)
      expect(logger.info).toHaveBeenCalledWith(
        { err: abortError, provider: 'oauth-provider' },
        'oauth.callback.aborted',
      )
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('logs full error object when authorization code exchange fails', async () => {
      const exchangeError = new Error('exchange exploded')
      const tokenManager = {
        exchangeCode: vi.fn().mockRejectedValue(exchangeError),
      } as unknown as TokenManager
      const logger = createTestLogger()

      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      const state = await loginState(app)
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

    it('rejects unknown state', async () => {
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()

      const state = 'unknown-state'
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

    it('rejects replayed state', async () => {
      const tokenManager = {
        exchangeCode: vi.fn().mockResolvedValue(makeToken()),
      } as unknown as TokenManager
      const app = createOAuthCallbackApp(createDeps(tokenManager))
      const state = await loginState(app)

      const first = await app.request(`/callback?code=first&state=${state}`)
      const replay = await app.request(`/callback?code=second&state=${state}`)

      expect(await first.text()).toContain('Authentication Successful')
      expect(await replay.text()).toContain('invalid_state')
      expect(tokenManager.exchangeCode).toHaveBeenCalledTimes(1)
    })

    it('rejects expired state with an injected clock', async () => {
      let now = 1_000_000
      const tokenManager = {
        exchangeCode: vi.fn(),
      } as unknown as TokenManager
      const app = createOAuthCallbackApp(createDeps(tokenManager, {}, () => now))
      const state = await loginState(app)

      now += 10 * 60 * 1000 + 1
      const response = await app.request(`/callback?code=code&state=${state}`)

      expect(await response.text()).toContain('invalid_state')
      expect(tokenManager.exchangeCode).not.toHaveBeenCalled()
    })

    it('consumes valid state before handling an OAuth error response', async () => {
      const tokenManager = {
        exchangeCode: vi.fn(),
      } as unknown as TokenManager
      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      const state = await loginState(app)
      const res = await app.request(
        `/callback?error=access_denied&error_description=User+cancelled&state=${state}`,
      )
      const replay = await app.request(`/callback?code=replayed-code&state=${state}`)

      expect(res.status).toBe(200)
      const html = await res.text()
      const replayHtml = await replay.text()
      expect(html).toContain('Authentication Failed')
      expect(html).toContain('access_denied')
      expect(html).not.toContain('User cancelled')
      expect(replayHtml).toContain('invalid_state')
      expect(tokenManager.exchangeCode).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        { errorCode: 'access_denied', provider: 'oauth-provider' },
        'oauth.callback.rejected',
      )
      const logs = JSON.stringify(logger.warn.mock.calls)
      expect(logs).not.toContain('User cancelled')
      expect(logs).not.toContain(state)
      expect(logs).not.toContain('replayed-code')
      const pages = html + replayHtml
      expect(pages).not.toContain(state)
      expect(pages).not.toContain('replayed-code')
    })

    it('does not copy arbitrary provider error text into telemetry', async () => {
      const tokenManager = TokenManager.fromFile(authFilePath)
      await tokenManager.load()

      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })
      const state = await loginState(app)
      const response = await app.request(
        `/callback?error=secret%20provider%20text&error_description=secret+description&state=${state}`,
      )

      expect(logger.warn).toHaveBeenCalledWith(
        { errorCode: 'provider_error', provider: 'oauth-provider' },
        'oauth.callback.rejected',
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret provider text')
      expect(await response.text()).not.toContain('secret description')
    })

    it('rejects an OAuth error response with invalid state', async () => {
      const tokenManager = {
        exchangeCode: vi.fn(),
      } as unknown as TokenManager
      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })

      const response = await app.request('/callback?error=access_denied&state=invalid-state')

      expect(await response.text()).toContain('invalid_state')
      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'invalid_state' },
        'oauth.callback.invalid',
      )
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: expect.anything() }),
        'oauth.callback.rejected',
      )
      expect(tokenManager.exchangeCode).not.toHaveBeenCalled()
    })

    it('rejects an OAuth error response with expired state', async () => {
      let now = 1_000_000
      const tokenManager = {
        exchangeCode: vi.fn(),
      } as unknown as TokenManager
      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager, {}, () => now), logger })
      const state = await loginState(app)
      now += 10 * 60 * 1000 + 1

      const response = await app.request(`/callback?error=access_denied&state=${state}`)

      expect(await response.text()).toContain('invalid_state')
      expect(logger.warn).toHaveBeenCalledWith(
        { reason: 'invalid_state' },
        'oauth.callback.invalid',
      )
      expect(tokenManager.exchangeCode).not.toHaveBeenCalled()
    })

    it('rejects an OAuth error response without state', async () => {
      const tokenManager = {
        exchangeCode: vi.fn(),
      } as unknown as TokenManager
      const logger = createTestLogger()
      const app = createOAuthCallbackApp({ ...createDeps(tokenManager), logger })

      const response = await app.request(
        '/callback?error=access_denied&error_description=User+cancelled',
      )

      const html = await response.text()
      expect(html).toContain('invalid_request')
      expect(html).not.toContain('access_denied')
      expect(html).not.toContain('User cancelled')
      expect(logger.warn).toHaveBeenCalledWith(
        { hasCode: false, hasState: false },
        'oauth.callback.invalid',
      )
      expect(tokenManager.exchangeCode).not.toHaveBeenCalled()
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
