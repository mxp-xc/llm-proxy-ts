import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createProviderRegistry, TokenManager } from '../../src/index.js'
import { makeSettings } from '../helpers/settings.js'
import {
  authCodeConfig,
  clientCredentialsConfig,
  createMemoryPersistence,
  mockTokenResponse,
} from '../helpers/oauth.js'
import type { ProviderRegistry } from '../../src/providers/registry.js'
import type { AuthFetchRegistry } from '../../src/plugins/registry.js'
import type pino from 'pino'

afterEach(() => vi.unstubAllGlobals())

/** openai 上游 + /v1/responses 走 passthrough 直通转发（绕过 AI SDK）。
 *  验证：请求 body 原始保留（仅替换 model，不丢 instructions/service_tier/client_metadata）、
 *  Authorization 注入后端 key、codex 客户端头不透传、响应原样 pipe、后端非 2xx 原生透传。 */
describe('openai provider passthrough /v1/responses', () => {
  function makeRegistry(apiKey: string): ProviderRegistry {
    return {
      languageModel() {
        return { model: {} as never }
      },
      passthroughTransport() {
        return { fetch: globalThis.fetch, apiKey, keySelection: { index: 0, count: 1 } }
      },
    }
  }

  function makeOpenaiSettings() {
    return makeSettings({
      openai: {
        type: 'openai',
        baseURL: 'http://mock-upstream/v1',
        apiKey: 'sk-test',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
      },
    })
  }

  function makeTestLogger() {
    const error = vi.fn()
    const child = vi.fn()
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error,
      fatal: vi.fn(),
      child,
    } as unknown as pino.Logger
    child.mockReturnValue(logger)
    return { logger, error }
  }

  it('forwards raw body with model replaced, injects auth, pipes upstream SSE', async () => {
    const settings = makeOpenaiSettings()
    settings.providers.openai!.headers = {
      'x-provider': 'provider',
      authorization: 'Bearer wrong-provider',
      'x-api-key': 'wrong-provider-key',
    }
    settings.providers.openai!.options = {
      organization: 'org-test',
      project: 'proj-test',
    }
    settings.providers.openai!.models.chat!.headers = {
      'x-model': 'model',
      'api-key': 'wrong-model-key',
    }
    let capturedUrl: string | URL | undefined
    let capturedInit: RequestInit | undefined
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      capturedUrl = input
      capturedInit = init
      const sse = 'data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\n'
      return new Response(sse, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': '999',
          'x-upstream-request-id': 'upstream-request',
        },
      })
    })

    const app = createApp({ settings, providerRegistry: makeRegistry('sk-test') })
    const body = JSON.stringify({
      model: 'openai/chat',
      input: 'hi',
      stream: true,
      instructions: 'system-prompt',
      service_tier: 'default',
      client_metadata: { session_id: 's1' },
    })
    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-codex-turn-metadata': 'meta',
        authorization: 'Bearer not-need',
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(String(capturedUrl)).toBe('http://mock-upstream/v1/responses')

    // model 替换为 upstreamModel；原始字段保留（AI SDK round-trip 会丢这些）
    const forwarded = JSON.parse((capturedInit?.body as string) ?? '{}')
    expect(forwarded.model).toBe('gpt-5')
    expect(forwarded.instructions).toBe('system-prompt')
    expect(forwarded.service_tier).toBe('default')
    expect(forwarded.client_metadata).toEqual({ session_id: 's1' })

    // Authorization 注入后端 key（不透传客户端的 not-need）
    const headers = new Headers(capturedInit?.headers as HeadersInit)
    expect(headers.get('authorization')).toBe('Bearer sk-test')
    expect(headers.get('OpenAI-Organization')).toBe('org-test')
    expect(headers.get('OpenAI-Project')).toBe('proj-test')
    expect(headers.get('x-provider')).toBe('provider')
    expect(headers.get('x-model')).toBe('model')
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('api-key')).toBeNull()
    // codex 客户端头不透传（上游校验 attestation，codex_exec 无 attestation 会被拒 502）
    expect(headers.get('x-codex-turn-metadata')).toBeNull()
    expect(headers.get('originator')).toBeNull()

    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('x-upstream-request-id')).toBe('upstream-request')

    // 响应原样 pipe
    const text = await res.text()
    expect(text).toContain('response.created')
    expect(text).toContain('response.completed')
  })

  it('keeps top-level null fields in passthrough raw body', async () => {
    const settings = makeOpenaiSettings()
    let capturedInit: RequestInit | undefined
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ id: 'resp_1', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const app = createApp({ settings, providerRegistry: makeRegistry('sk-test') })
    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/chat',
        input: 'hi',
        store: null,
        instructions: null,
        client_metadata: null,
      }),
    })

    expect(res.status).toBe(200)
    const forwarded = JSON.parse((capturedInit?.body as string) ?? '{}')
    expect(forwarded).toMatchObject({
      model: 'gpt-5',
      input: 'hi',
      store: null,
      instructions: null,
      client_metadata: null,
    })
  })

  it('uses registry OAuth transport for passthrough authorization', async () => {
    const settings = makeSettings({
      openai: {
        type: 'openai',
        baseURL: 'http://mock-upstream/v1',
        apiKey: null,
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
        oauth: clientCredentialsConfig,
      },
    })
    let capturedInit: RequestInit | undefined
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === clientCredentialsConfig.tokenUrl) {
        return new Response(JSON.stringify(mockTokenResponse({ access_token: 'oauth-token' })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      capturedInit = init
      return new Response(JSON.stringify({ id: 'resp_1', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const tokenManager = new TokenManager(createMemoryPersistence(), fetchMock as typeof fetch)
    await tokenManager.load()
    const providerRegistry = await createProviderRegistry(settings, tokenManager)
    const app = createApp({ settings, providerRegistry })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi' }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      clientCredentialsConfig.tokenUrl,
      expect.objectContaining({ method: 'POST' }),
    )
    const headers = new Headers(capturedInit?.headers as HeadersInit)
    expect(headers.get('authorization')).toBe('Bearer oauth-token')
  })

  it('returns 503 login body when passthrough OAuth requires login', async () => {
    const settings = makeSettings({
      openai: {
        type: 'openai',
        baseURL: 'http://mock-upstream/v1',
        apiKey: null,
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
        oauth: authCodeConfig,
      },
    })
    const tokenManager = new TokenManager(createMemoryPersistence())
    await tokenManager.load()
    const providerRegistry = await createProviderRegistry(settings, tokenManager)
    const { logger, error } = makeTestLogger()
    const app = createApp({ settings, providerRegistry, logger })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi' }),
    })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toMatchObject({
      type: 'auth_required',
      code: 'oauth_login_needed',
    })
    expect(body.error.loginUrl).toContain('/oauth/login/openai')
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ code: 'auth_required' }),
        provider: 'openai',
        url: 'http://mock-upstream/v1/responses',
      }),
      'passthrough oauth required',
    )
  })

  it('uses auth plugin transport for passthrough requests', async () => {
    const settings = makeOpenaiSettings()
    let capturedInit: RequestInit | undefined
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ id: 'resp_1', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const pluginRegistry: AuthFetchRegistry = {
      async createAuthFetch(providerId: string) {
        if (providerId !== 'openai') return undefined
        return (baseFetch?: typeof fetch) =>
          async (input: string | URL | Request, init?: RequestInit) => {
            const headers = new Headers(init?.headers)
            headers.set('x-auth-plugin', `mock-for-${providerId}`)
            const fetchFn = baseFetch ?? globalThis.fetch
            return fetchFn(input, { ...init, headers })
          }
      },
    }
    const providerRegistry = await createProviderRegistry(
      settings,
      undefined,
      undefined,
      pluginRegistry,
    )
    const app = createApp({ settings, providerRegistry })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi' }),
    })

    expect(res.status).toBe(200)
    const headers = new Headers(capturedInit?.headers as HeadersInit)
    expect(headers.get('authorization')).toBe('Bearer sk-test')
    expect(headers.get('x-auth-plugin')).toBe('mock-for-openai')
  })

  it('logs full passthrough timeout errors before returning 504', async () => {
    const settings = { ...makeOpenaiSettings(), requestTimeoutMs: 5 }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return new Response('{}', { status: 200 })
      }),
    )
    const { logger, error } = makeTestLogger()
    const app = createApp({
      settings,
      providerRegistry: makeRegistry('sk-test'),
      logger,
    })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi' }),
    })

    expect(res.status).toBe(504)
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ name: 'RequestTimeoutError' }),
        provider: 'openai',
        url: 'http://mock-upstream/v1/responses',
      }),
      'passthrough fetch timed out',
    )
  })

  it('translates upstream non-2xx to native error status+body', async () => {
    const settings = makeOpenaiSettings()
    const { logger, error } = makeTestLogger()
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { type: 'rate_limit', message: 'too many' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const app = createApp({ settings, providerRegistry: makeRegistry('sk-test'), logger })
    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi', stream: true }),
    })
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.error.type).toBe('rate_limit')
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: 'Passthrough upstream returned 429' }),
        status: 429,
        provider: 'openai',
        url: 'http://mock-upstream/v1/responses',
        errBody: expect.stringContaining('rate_limit'),
      }),
      'passthrough upstream non-2xx',
    )
  })
})
