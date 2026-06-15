import type { OAuthToken } from '../../src/oauth/types.js'
import type { OAuthConfig } from '../../src/config.js'
import type { TokenPersistence } from '../../src/oauth/token-manager.js'

export function makeToken(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() / 1000 + 3600,
    tokenType: 'Bearer',
    scope: 'read write',
    ...overrides,
  }
}

export function makeExpiredToken(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return makeToken({ ...overrides, expiresAt: Date.now() / 1000 - 100 })
}

export const authCodeConfig: OAuthConfig = {
  flow: 'authorization_code',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  authorizationUrl: 'https://auth.example.com/oauth2/authorize',
  scopes: ['api.read'],
}

export const clientCredentialsConfig: OAuthConfig = {
  flow: 'client_credentials',
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  scopes: ['api.read'],
}

export function mockTokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'new-access-token',
    expires_in: 3600,
    token_type: 'Bearer',
    refresh_token: 'new-refresh-token',
    scope: 'api.read',
    ...overrides,
  }
}

/**
 * 创建基于内存的 TokenPersistence，用于测试。
 */
export function createMemoryPersistence(
  initialStore: Record<string, OAuthToken> = {},
): TokenPersistence {
  let store = { ...initialStore }
  return {
    async load() {
      return { ...store }
    },
    async save(newStore: Record<string, OAuthToken>) {
      store = { ...newStore }
    },
  }
}
