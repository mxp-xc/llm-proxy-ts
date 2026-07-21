import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  isTokenValid,
  isTokenExpired,
  classifyStatus,
  refreshAccessToken,
  fetchClientCredentialsToken,
  exchangeAuthorizationCode,
  TokenManager,
} from '../../src/oauth/token-manager.js'
import type { OAuthConfig } from '../../src/config.js'
import type { OAuthToken } from '../../src/oauth/types.js'
import { OAuthError } from '../../src/oauth/types.js'
import type { Logger } from '../../src/types.js'
import {
  makeToken,
  makeExpiredToken,
  authCodeConfig,
  clientCredentialsConfig,
  mockTokenResponse,
  createMemoryPersistence,
} from '../helpers/oauth.js'

async function expectOAuthErrorCode(
  promise: Promise<unknown>,
  code: OAuthError['code'],
): Promise<void> {
  try {
    await promise
    throw new Error('Expected OAuthError')
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthError)
    expect((error as OAuthError).code).toBe(code)
  }
}

function createCapturingLogger() {
  const info: Array<{ payload: unknown; msg: string | undefined }> = []
  const error: Array<{ payload: unknown; msg: string | undefined }> = []
  const logger: Logger = {
    info(payload, msg) {
      info.push({ payload, msg })
    },
    warn() {},
    error(payload, msg) {
      error.push({ payload, msg })
    },
    fatal() {},
    child() {
      return logger
    },
  }
  return { logger, info, error }
}

describe('token-manager', () => {
  describe('isTokenValid', () => {
    it('returns true for valid token', () => {
      expect(isTokenValid(makeToken())).toBe(true)
    })

    it('returns false for expired token', () => {
      expect(isTokenValid(makeExpiredToken())).toBe(false)
    })

    it('returns false for token expiring within 30s margin', () => {
      expect(isTokenValid(makeToken({ expiresAt: Date.now() / 1000 + 15 }))).toBe(false)
    })

    it('returns true for token expiring just outside margin', () => {
      expect(isTokenValid(makeToken({ expiresAt: Date.now() / 1000 + 31 }))).toBe(true)
    })
  })

  describe('isTokenExpired', () => {
    it('returns opposite of isTokenValid', () => {
      expect(isTokenExpired(makeToken())).toBe(false)
      expect(isTokenExpired(makeExpiredToken())).toBe(true)
    })
  })

  describe('classifyStatus', () => {
    it('returns "valid" for valid token', () => {
      expect(classifyStatus(makeToken(), authCodeConfig)).toBe('valid')
    })

    it('returns "needs_refresh" for expired token with refreshToken (auth code)', () => {
      expect(classifyStatus(makeExpiredToken(), authCodeConfig)).toBe('needs_refresh')
    })

    it('returns "needs_login" for expired token without refreshToken (auth code)', () => {
      const token = makeExpiredToken()
      const { refreshToken: _, ...tokenWithoutRefresh } = token
      expect(classifyStatus(tokenWithoutRefresh, authCodeConfig)).toBe('needs_login')
    })

    it('returns "needs_login" for no token (auth code)', () => {
      expect(classifyStatus(undefined, authCodeConfig)).toBe('needs_login')
    })

    it('returns "needs_refresh" for expired token (client credentials)', () => {
      expect(classifyStatus(makeExpiredToken(), clientCredentialsConfig)).toBe('needs_refresh')
    })

    it('returns "needs_refresh" for no token (client credentials)', () => {
      expect(classifyStatus(undefined, clientCredentialsConfig)).toBe('needs_refresh')
    })
  })

  describe('refreshAccessToken', () => {
    it('sends refresh_token grant and returns new token', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse()),
      })

      const token = await refreshAccessToken(authCodeConfig, 'existing-refresh-token', mockFetch)

      expect(token.accessToken).toBe('new-access-token')
      expect(token.refreshToken).toBe('new-refresh-token')
      expect(token.tokenType).toBe('Bearer')

      const [url, init] = mockFetch.mock.calls[0]!
      expect(url).toBe('https://auth.example.com/oauth2/token')
      expect(init.method).toBe('POST')
      expect(init.body).toContain('grant_type=refresh_token')
      expect(init.body).toContain('refresh_token=existing-refresh-token')
    })

    it('throws OAuthError on HTTP error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('secret refresh response'),
      })

      try {
        await refreshAccessToken(authCodeConfig, 'rt', mockFetch)
        expect.unreachable('refresh should have failed')
      } catch (error) {
        expect(error).toBeInstanceOf(OAuthError)
        expect((error as OAuthError).code).toBe('refresh_failed')
        expect((error as Error).message).toBe('Token refresh failed: HTTP 400')
        expect((error as Error).message).not.toContain('secret refresh response')
      }
    })

    it('throws OAuthError on network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network error'))

      await expect(refreshAccessToken(authCodeConfig, 'rt', mockFetch)).rejects.toThrow(OAuthError)
    })

    it('keeps refresh_failed for malformed token responses', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ expires_in: 3600 }),
      })

      await expectOAuthErrorCode(
        refreshAccessToken(authCodeConfig, 'rt', mockFetch),
        'refresh_failed',
      )
    })
  })

  describe('fetchClientCredentialsToken', () => {
    it('sends client_credentials grant', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse({ refresh_token: undefined })),
      })

      const token = await fetchClientCredentialsToken(clientCredentialsConfig, mockFetch)

      expect(token.accessToken).toBe('new-access-token')
      expect(token.refreshToken).toBeUndefined()

      const [, init] = mockFetch.mock.calls[0]!
      expect(init.body).toContain('grant_type=client_credentials')
    })

    it('does not include an HTTP error response body in the error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('secret client credentials response'),
      })

      await expect(fetchClientCredentialsToken(clientCredentialsConfig, mockFetch)).rejects.toThrow(
        'Client credentials token fetch failed: HTTP 403',
      )
      await expect(
        fetchClientCredentialsToken(clientCredentialsConfig, mockFetch),
      ).rejects.not.toThrow('secret client credentials response')
    })
  })

  describe('exchangeAuthorizationCode', () => {
    it('sends authorization_code grant with redirect_uri', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse()),
      })

      const token = await exchangeAuthorizationCode(
        authCodeConfig,
        'auth-code-123',
        'http://localhost:8000/oauth/callback',
        mockFetch,
      )

      expect(token.accessToken).toBe('new-access-token')

      const [, init] = mockFetch.mock.calls[0]!
      expect(init.body).toContain('grant_type=authorization_code')
      expect(init.body).toContain('code=auth-code-123')
      expect(init.body).toContain('redirect_uri=')
    })

    it('throws OAuthError on exchange failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('secret exchange response'),
      })

      try {
        await exchangeAuthorizationCode(
          authCodeConfig,
          'bad-code',
          'http://localhost:8000/oauth/callback',
          mockFetch,
        )
        expect.unreachable('exchange should have failed')
      } catch (error) {
        expect(error).toBeInstanceOf(OAuthError)
        expect((error as Error).message).toBe('Authorization code exchange failed: HTTP 401')
        expect((error as Error).message).not.toContain('secret exchange response')
      }
    })

    it('uses exchange_failed for malformed token responses', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ expires_in: 3600 }),
      })

      await expectOAuthErrorCode(
        exchangeAuthorizationCode(
          authCodeConfig,
          'auth-code-123',
          'http://localhost:8000/oauth/callback',
          mockFetch,
        ),
        'exchange_failed',
      )
    })

    it('uses exchange_failed when parsing token JSON fails', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new Error('invalid json')),
      })

      await expectOAuthErrorCode(
        exchangeAuthorizationCode(
          authCodeConfig,
          'auth-code-123',
          'http://localhost:8000/oauth/callback',
          mockFetch,
        ),
        'exchange_failed',
      )
    })
  })

  it.each([
    [
      'refresh token',
      (fetchFn: typeof globalThis.fetch) => refreshAccessToken(authCodeConfig, 'rt', fetchFn),
      'refresh_failed',
    ],
    [
      'client credentials',
      (fetchFn: typeof globalThis.fetch) =>
        fetchClientCredentialsToken(clientCredentialsConfig, fetchFn),
      'refresh_failed',
    ],
    [
      'authorization code',
      (fetchFn: typeof globalThis.fetch) =>
        exchangeAuthorizationCode(
          authCodeConfig,
          'auth-code-123',
          'http://localhost:8000/oauth/callback',
          fetchFn,
        ),
      'exchange_failed',
    ],
  ] as const)('does not expose malformed %s response bodies', async (_name, request, code) => {
    const secretBody = 'access_token=malformed-super-secret'
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(secretBody, { status: 200 }))

    try {
      await request(fetchFn)
      expect.unreachable('token request should have failed')
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthError)
      expect((error as OAuthError).code).toBe(code)
      expect((error as Error).message).toContain('token endpoint returned invalid JSON')
      expect((error as Error).message).not.toContain(secretBody)
      expect((error as Error).stack).not.toContain(secretBody)
      expect((error as Error).cause).toBeUndefined()
    }
  })

  describe('TokenManager', () => {
    it('load reads from persistence', async () => {
      const token = makeToken()
      const persistence = createMemoryPersistence({ 'my-provider': token })
      const manager = new TokenManager(persistence)
      await manager.load()

      expect(manager.getStatus('my-provider', authCodeConfig)).toBe('valid')
    })

    it('ensureValidToken returns cached valid token', async () => {
      const token = makeToken()
      const persistence = createMemoryPersistence({ p: token })
      const { logger, info, error } = createCapturingLogger()
      const manager = new TokenManager(persistence, undefined, logger)
      await manager.load()

      const result = await manager.ensureValidToken('p', authCodeConfig)
      expect(result.accessToken).toBe(token.accessToken)
      expect(info).toHaveLength(0)
      expect(error).toHaveLength(0)
    })

    it('ensureValidToken refreshes expired token with refreshToken', async () => {
      const expiredToken = makeExpiredToken()
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse()),
      })

      const persistence = createMemoryPersistence({ p: expiredToken })
      const manager = new TokenManager(persistence, mockFetch)
      await manager.load()

      const result = await manager.ensureValidToken('p', authCodeConfig)
      expect(result.accessToken).toBe('new-access-token')
    })

    it('ensureValidToken fetches new token for client_credentials', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse({ refresh_token: undefined })),
      })

      const persistence = createMemoryPersistence()
      const manager = new TokenManager(persistence, mockFetch)
      await manager.load()

      const result = await manager.ensureValidToken('p', clientCredentialsConfig)
      expect(result.accessToken).toBe('new-access-token')
      expect(result.refreshToken).toBeUndefined()
    })

    it('ensureValidToken throws OAuthError for auth_code without token', async () => {
      const persistence = createMemoryPersistence()
      const manager = new TokenManager(persistence)
      await manager.load()

      try {
        await manager.ensureValidToken('p', authCodeConfig)
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(OAuthError)
        expect((error as OAuthError).code).toBe('auth_required')
      }
    })

    it('exchangeCode persists token via persistence', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse()),
      })

      const persistence = createMemoryPersistence()
      const manager = new TokenManager(persistence, mockFetch)
      await manager.load()

      const token = await manager.exchangeCode(
        'p',
        authCodeConfig,
        'auth-code-123',
        'http://localhost:8000/oauth/callback',
      )

      expect(token.accessToken).toBe('new-access-token')

      // Verify persisted via persistence
      const stored = await persistence.load()
      expect(stored['p']!.accessToken).toBe('new-access-token')
    })

    it('deduplicates concurrent ensureValidToken calls', async () => {
      let callCount = 0
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++
        // Simulate slow response
        await new Promise((r) => setTimeout(r, 50))
        return {
          ok: true,
          json: () => Promise.resolve(mockTokenResponse()),
        }
      })

      const persistence = createMemoryPersistence()
      const { logger, info, error } = createCapturingLogger()
      const manager = new TokenManager(persistence, mockFetch, logger)
      await manager.load()

      // Fire 5 concurrent calls for same provider
      const results = await Promise.all([
        manager.ensureValidToken('p', clientCredentialsConfig),
        manager.ensureValidToken('p', clientCredentialsConfig),
        manager.ensureValidToken('p', clientCredentialsConfig),
        manager.ensureValidToken('p', clientCredentialsConfig),
        manager.ensureValidToken('p', clientCredentialsConfig),
      ])

      // All should get the same token
      expect(results.every((r) => r.accessToken === 'new-access-token')).toBe(true)
      // But only one HTTP call should have been made
      expect(callCount).toBe(1)
      expect(info).toHaveLength(2)
      expect(info[0]).toEqual({
        payload: { provider: 'p', flow: 'client_credentials' },
        msg: 'oauth.refresh.started',
      })
      expect(info[1]).toMatchObject({
        payload: {
          provider: 'p',
          flow: 'client_credentials',
          joinedRequests: 4,
          durationMs: expect.any(Number),
        },
        msg: 'oauth.refresh.succeeded',
      })
      expect(error).toHaveLength(0)
    })

    it('logs persistence failures with the refresh operation context', async () => {
      const persistError = new Error('disk unavailable')
      const persistence = {
        async load() {
          return {}
        },
        async save() {
          throw persistError
        },
      }
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse({ refresh_token: undefined })),
      })
      const { logger, info, error } = createCapturingLogger()
      const manager = new TokenManager(persistence, mockFetch, logger)
      await manager.load()

      await expect(manager.ensureValidToken('p', clientCredentialsConfig)).rejects.toBe(
        persistError,
      )

      expect(info).toEqual([
        {
          payload: { provider: 'p', flow: 'client_credentials' },
          msg: 'oauth.refresh.started',
        },
      ])
      expect(error).toHaveLength(1)
      expect(error[0]).toMatchObject({
        payload: {
          err: persistError,
          provider: 'p',
          flow: 'client_credentials',
          joinedRequests: 0,
          durationMs: expect.any(Number),
          stage: 'persist',
        },
        msg: 'oauth.refresh.failed',
      })
    })

    it('logs token endpoint failures with refresh_token flow and full error', async () => {
      const endpointError = new Error('network unavailable')
      const persistence = createMemoryPersistence({ p: makeExpiredToken() })
      const mockFetch = vi.fn().mockRejectedValue(endpointError)
      const { logger, info, error } = createCapturingLogger()
      const manager = new TokenManager(persistence, mockFetch, logger)
      await manager.load()

      await expect(manager.ensureValidToken('p', authCodeConfig)).rejects.toThrow(
        'Token refresh failed: Error: network unavailable',
      )

      expect(info).toEqual([
        {
          payload: { provider: 'p', flow: 'refresh_token' },
          msg: 'oauth.refresh.started',
        },
      ])
      expect(error).toHaveLength(1)
      expect(error[0]).toMatchObject({
        payload: {
          err: expect.any(OAuthError),
          provider: 'p',
          flow: 'refresh_token',
          joinedRequests: 0,
          durationMs: expect.any(Number),
          stage: 'token_endpoint',
        },
        msg: 'oauth.refresh.failed',
      })
      expect((error[0]!.payload as { err: Error }).err.cause).toBe(endpointError)
    })

    it('persists refreshed token via persistence', async () => {
      const expiredToken = makeExpiredToken()
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse()),
      })

      const persistence = createMemoryPersistence({ p: expiredToken })
      const manager = new TokenManager(persistence, mockFetch)
      await manager.load()
      await manager.ensureValidToken('p', authCodeConfig)

      // Read directly from persistence to verify
      const stored = await persistence.load()
      expect(stored['p']!.accessToken).toBe('new-access-token')
    })
  })

  // ── fromFile 集成测试（文件系统持久化） ──────────────────────

  describe('TokenManager.fromFile', () => {
    let tempDir: string
    let authFilePath: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'oauth-manager-test-'))
      authFilePath = join(tempDir, 'auth.json')
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    it('load reads from auth.json', async () => {
      const { saveAuthFile, mergeTokenStore } = await import('../../src/oauth/token-store.js')
      const token = makeToken()
      await saveAuthFile(authFilePath, mergeTokenStore({}, { 'my-provider': token }))

      const manager = TokenManager.fromFile(authFilePath)
      await manager.load()

      expect(manager.getStatus('my-provider', authCodeConfig)).toBe('valid')
    })

    it('exchangeCode persists token to auth.json', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse()),
      })

      const manager = TokenManager.fromFile(authFilePath, mockFetch)
      await manager.load()

      const token = await manager.exchangeCode(
        'p',
        authCodeConfig,
        'auth-code-123',
        'http://localhost:8000/oauth/callback',
      )

      expect(token.accessToken).toBe('new-access-token')

      // Verify persisted to file
      const { loadAuthFile, extractTokenStore } = await import('../../src/oauth/token-store.js')
      const data = await loadAuthFile(authFilePath)
      const store = extractTokenStore(data)
      expect(store['p']!.accessToken).toBe('new-access-token')
    })

    it('persists refreshed token to auth.json', async () => {
      const expiredToken = makeExpiredToken()
      const { saveAuthFile, mergeTokenStore } = await import('../../src/oauth/token-store.js')
      await saveAuthFile(authFilePath, mergeTokenStore({}, { p: expiredToken }))

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse()),
      })

      const manager = TokenManager.fromFile(authFilePath, mockFetch)
      await manager.load()
      await manager.ensureValidToken('p', authCodeConfig)

      // Read directly from file to verify persistence
      const { loadAuthFile, extractTokenStore } = await import('../../src/oauth/token-store.js')
      const data = await loadAuthFile(authFilePath)
      const store = extractTokenStore(data)
      expect(store['p']!.accessToken).toBe('new-access-token')
    })

    it('accepts a logger as the final optional argument', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse({ refresh_token: undefined })),
      })
      const { logger, info } = createCapturingLogger()
      const manager = TokenManager.fromFile(authFilePath, mockFetch, logger)
      await manager.load()

      await manager.ensureValidToken('p', clientCredentialsConfig)

      expect(info.map((entry) => entry.msg)).toEqual([
        'oauth.refresh.started',
        'oauth.refresh.succeeded',
      ])
    })

    it('preserves plugin store data when saving tokens concurrently', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse()),
      })
      const manager = TokenManager.fromFile(authFilePath, mockFetch)
      await manager.load()

      const { createPluginStore } = await import('../../src/plugins/store-adapter.js')
      const pluginStore = createPluginStore(authFilePath, 'plugin-a')

      await Promise.all([
        manager.exchangeCode(
          'p',
          authCodeConfig,
          'auth-code-123',
          'http://localhost:8000/oauth/callback',
        ),
        pluginStore.set({ cached: 'plugin-value' }),
      ])

      const { loadAuthFile, extractTokenStore } = await import('../../src/oauth/token-store.js')
      const data = await loadAuthFile(authFilePath)
      expect(extractTokenStore(data)['p']!.accessToken).toBe('new-access-token')
      expect(data._plugins?.['plugin-a']).toEqual({ cached: 'plugin-value' })
    })
  })
})
