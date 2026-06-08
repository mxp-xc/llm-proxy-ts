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
} from '../src/oauth/token-manager.js'
import type { OAuthConfig } from '../src/config.js'
import type { OAuthToken } from '../src/oauth/types.js'
import { OAuthError } from '../src/oauth/types.js'

function makeToken(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() / 1000 + 3600,
    tokenType: 'Bearer',
    scope: 'read write',
    ...overrides,
  }
}

function makeExpiredToken(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return makeToken({ expiresAt: Date.now() / 1000 - 100, ...overrides })
}

const authCodeConfig: OAuthConfig = {
  flow: 'authorization_code',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  authorizationUrl: 'https://auth.example.com/oauth2/authorize',
  scopes: ['api.read'],
}

const clientCredentialsConfig: OAuthConfig = {
  flow: 'client_credentials',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  scopes: ['api.read'],
}

function mockTokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'new-access-token',
    expires_in: 3600,
    token_type: 'Bearer',
    refresh_token: 'new-refresh-token',
    scope: 'api.read',
    ...overrides,
  }
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
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('sends refresh_token grant and returns new token', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse()),
      })
      vi.stubGlobal('fetch', mockFetch)

      const token = await refreshAccessToken(authCodeConfig, 'existing-refresh-token')

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
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          text: () => Promise.resolve('bad request'),
        }),
      )

      await expect(refreshAccessToken(authCodeConfig, 'rt')).rejects.toThrow(OAuthError)
      try {
        await refreshAccessToken(authCodeConfig, 'rt')
      } catch (error) {
        expect(error).toBeInstanceOf(OAuthError)
        expect((error as OAuthError).code).toBe('refresh_failed')
      }
    })

    it('throws OAuthError on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))

      await expect(refreshAccessToken(authCodeConfig, 'rt')).rejects.toThrow(OAuthError)
    })
  })

  describe('fetchClientCredentialsToken', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('sends client_credentials grant', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse({ refresh_token: undefined })),
      })
      vi.stubGlobal('fetch', mockFetch)

      const token = await fetchClientCredentialsToken(clientCredentialsConfig)

      expect(token.accessToken).toBe('new-access-token')
      expect(token.refreshToken).toBeUndefined()

      const [, init] = mockFetch.mock.calls[0]!
      expect(init.body).toContain('grant_type=client_credentials')
    })
  })

  describe('exchangeAuthorizationCode', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('sends authorization_code grant with redirect_uri', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse()),
      })
      vi.stubGlobal('fetch', mockFetch)

      const token = await exchangeAuthorizationCode(
        authCodeConfig,
        'auth-code-123',
        'http://localhost:8000/oauth/callback',
      )

      expect(token.accessToken).toBe('new-access-token')

      const [, init] = mockFetch.mock.calls[0]!
      expect(init.body).toContain('grant_type=authorization_code')
      expect(init.body).toContain('code=auth-code-123')
      expect(init.body).toContain('redirect_uri=')
    })

    it('throws OAuthError on exchange failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: () => Promise.resolve('unauthorized'),
        }),
      )

      await expect(
        exchangeAuthorizationCode(
          authCodeConfig,
          'bad-code',
          'http://localhost:8000/oauth/callback',
        ),
      ).rejects.toThrow(OAuthError)
    })
  })

  describe('TokenManager', () => {
    let tempDir: string
    let authFilePath: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'oauth-manager-test-'))
      authFilePath = join(tempDir, 'auth.json')
    })

    afterEach(async () => {
      vi.restoreAllMocks()
      await rm(tempDir, { recursive: true, force: true })
    })

    it('load reads from auth.json', async () => {
      const { saveTokenStore } = await import('../src/oauth/token-store.js')
      const token = makeToken()
      await saveTokenStore(authFilePath, { 'my-provider': token })

      const manager = new TokenManager(authFilePath)
      await manager.load()

      expect(manager.getStatus('my-provider', authCodeConfig)).toBe('valid')
    })

    it('ensureValidToken returns cached valid token', async () => {
      const token = makeToken()
      const { saveTokenStore } = await import('../src/oauth/token-store.js')
      await saveTokenStore(authFilePath, { p: token })

      const manager = new TokenManager(authFilePath)
      await manager.load()

      const result = await manager.ensureValidToken('p', authCodeConfig)
      expect(result.accessToken).toBe(token.accessToken)
    })

    it('ensureValidToken refreshes expired token with refreshToken', async () => {
      const expiredToken = makeExpiredToken()
      const { saveTokenStore } = await import('../src/oauth/token-store.js')
      await saveTokenStore(authFilePath, { p: expiredToken })

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse()),
        }),
      )

      const manager = new TokenManager(authFilePath)
      await manager.load()

      const result = await manager.ensureValidToken('p', authCodeConfig)
      expect(result.accessToken).toBe('new-access-token')
    })

    it('ensureValidToken fetches new token for client_credentials', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse({ refresh_token: undefined })),
        }),
      )

      const manager = new TokenManager(authFilePath)
      await manager.load()

      const result = await manager.ensureValidToken('p', clientCredentialsConfig)
      expect(result.accessToken).toBe('new-access-token')
      expect(result.refreshToken).toBeUndefined()
    })

    it('ensureValidToken throws OAuthError for auth_code without token', async () => {
      const manager = new TokenManager(authFilePath)
      await manager.load()

      try {
        await manager.ensureValidToken('p', authCodeConfig)
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(OAuthError)
        expect((error as OAuthError).code).toBe('auth_required')
      }
    })

    it('exchangeCode persists token to auth.json', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse()),
        }),
      )

      const manager = new TokenManager(authFilePath)
      await manager.load()

      const token = await manager.exchangeCode(
        'p',
        authCodeConfig,
        'auth-code-123',
        'http://localhost:8000/oauth/callback',
      )

      expect(token.accessToken).toBe('new-access-token')

      // Verify persisted
      const { loadTokenStore } = await import('../src/oauth/token-store.js')
      const store = await loadTokenStore(authFilePath)
      expect(store['p']!.accessToken).toBe('new-access-token')
    })

    it('deduplicates concurrent ensureValidToken calls', async () => {
      let callCount = 0
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => {
          callCount++
          // Simulate slow response
          await new Promise((r) => setTimeout(r, 50))
          return {
            ok: true,
            json: () => Promise.resolve(mockTokenResponse()),
          }
        }),
      )

      const manager = new TokenManager(authFilePath)
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
    })

    it('persists refreshed token to auth.json', async () => {
      const expiredToken = makeExpiredToken()
      const { saveTokenStore } = await import('../src/oauth/token-store.js')
      await saveTokenStore(authFilePath, { p: expiredToken })

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTokenResponse()),
        }),
      )

      const manager = new TokenManager(authFilePath)
      await manager.load()
      await manager.ensureValidToken('p', authCodeConfig)

      // Read directly from file to verify persistence
      const { loadTokenStore } = await import('../src/oauth/token-store.js')
      const store = await loadTokenStore(authFilePath)
      expect(store['p']!.accessToken).toBe('new-access-token')
    })
  })
})
