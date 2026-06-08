import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { Settings, OAuthConfig } from '@llm-proxy/core'
import { TokenManager } from '@llm-proxy/core'
import { validateOAuthStatus } from '../src/oauth/startup.js'

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
  scopes: [],
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

describe('OAuth startup validation', () => {
  let tempDir: string
  let authFilePath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oauth-startup-test-'))
    authFilePath = join(tempDir, 'auth.json')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty array when no providers have OAuth', async () => {
    const settings = makeSettings({
      plain: {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'key',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'm', aliases: [], headers: {}, plugins: [] } },
      },
    })

    const tokenManager = new TokenManager(authFilePath)
    await tokenManager.load()

    const results = await validateOAuthStatus(settings, tokenManager)
    expect(results).toEqual([])
  })

  it('returns needs_login for auth_code provider without token', async () => {
    const settings = makeSettings({
      'oauth-p': {
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

    const results = await validateOAuthStatus(settings, tokenManager)
    expect(results).toHaveLength(1)
    expect(results[0]!.provider).toBe('oauth-p')
    expect(results[0]!.status).toBe('needs_login')
    expect(results[0]!.loginUrl).toContain('/oauth/login/oauth-p')
  })

  it('returns valid for provider with valid token', async () => {
    const settings = makeSettings({
      'oauth-p': {
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
    // Simulate valid token by exchanging a code
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'valid-token',
            expires_in: 3600,
            token_type: 'Bearer',
            refresh_token: 'refresh',
          }),
      }),
    )
    await tokenManager.exchangeCode(
      'oauth-p',
      authCodeConfig,
      'code',
      'http://localhost:8000/oauth/callback',
    )

    const results = await validateOAuthStatus(settings, tokenManager)
    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('valid')
  })

  it('auto-refreshes client_credentials token', async () => {
    const settings = makeSettings({
      'cc-p': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: null,
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'm', aliases: [], headers: {}, plugins: [] } },
        oauth: clientCredentialsConfig,
      },
    })

    const tokenManager = new TokenManager(authFilePath)
    await tokenManager.load()

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'cc-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
      }),
    )

    const results = await validateOAuthStatus(settings, tokenManager)
    expect(results).toHaveLength(1)
    expect(results[0]!.status).toBe('valid')
  })
})
