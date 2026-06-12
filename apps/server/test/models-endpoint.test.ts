import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import type { Settings, ProviderRegistry } from '@llm-proxy/core'

const stubRegistry: ProviderRegistry = {
  languageModel() {
    return { model: {} as never }
  },
  debugProviderConfig() {
    return {} as never
  },
}

function makeSettings(
  providers: Settings['providers'] = {},
  enableFlatModelLookup = false,
): Settings {
  return {
    service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
    requestTimeoutMs: 30000,
    proxy: null,
    routing: { enableFlatModelLookup },
    plugins: [],
    providers,
  }
}

const singleProvider: Settings['providers'] = {
  openrouter: {
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'secret',
    headers: {},
    plugins: [],
    models: {
      chat: {
        upstreamModel: 'openrouter/auto',
        aliases: ['default'],
        headers: {},
        plugins: [],
      },
    },
  },
}

const multiProvider: Settings['providers'] = {
  openrouter: {
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'secret',
    headers: {},
    plugins: [],
    models: {
      chat: { upstreamModel: 'openrouter/auto', aliases: [], headers: {}, plugins: [] },
      code: { upstreamModel: 'openrouter/code', aliases: [], headers: {}, plugins: [] },
    },
  },
  deepseek: {
    type: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'secret',
    headers: {},
    plugins: [],
    models: {
      reasoner: { upstreamModel: 'deepseek-reasoner', aliases: [], headers: {}, plugins: [] },
    },
  },
}

describe('GET /v1/models', () => {
  it('returns empty list when no providers configured', async () => {
    const app = createApp({ settings: makeSettings(), providerRegistry: stubRegistry })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      object: 'list',
      data: [],
    })
  })

  it('returns models from a single provider', async () => {
    const app = createApp({
      settings: makeSettings(singleProvider),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.object).toBe('list')
    expect(body.data).toEqual([
      { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter' },
    ])
  })

  it('returns models from multiple providers', async () => {
    const app = createApp({ settings: makeSettings(multiProvider), providerRegistry: stubRegistry })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.object).toBe('list')
    expect(body.data).toHaveLength(3)
    expect(body.data).toEqual(
      expect.arrayContaining([
        { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter' },
        { id: 'openrouter/code', object: 'model', created: 0, owned_by: 'openrouter' },
        { id: 'deepseek/reasoner', object: 'model', created: 0, owned_by: 'deepseek' },
      ]),
    )
  })

  it('includes flat model names and aliases when enableFlatModelLookup is on', async () => {
    const app = createApp({
      settings: makeSettings(singleProvider, true),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toEqual([
      { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter' },
      { id: 'chat', object: 'model', created: 0, owned_by: 'openrouter' },
      { id: 'default', object: 'model', created: 0, owned_by: 'openrouter' },
    ])
  })

  it('excludes flat names when enableFlatModelLookup is off', async () => {
    const app = createApp({
      settings: makeSettings(singleProvider, false),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toEqual([
      { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter' },
    ])
  })
})

describe('GET /v1/models/:id', () => {
  it('returns a single model by id', async () => {
    const app = createApp({
      settings: makeSettings(singleProvider),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/openrouter/chat')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: 'openrouter/chat',
      object: 'model',
      created: 0,
      owned_by: 'openrouter',
    })
  })

  it('returns 404 for unknown model', async () => {
    const app = createApp({
      settings: makeSettings(singleProvider),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/openrouter/nonexistent')

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('returns 404 for unknown provider', async () => {
    const app = createApp({
      settings: makeSettings(singleProvider),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/unknown/model')

    expect(response.status).toBe(404)
  })

  it('returns 400 when model id is empty', async () => {
    const app = createApp({
      settings: makeSettings(singleProvider),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/')

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error.type).toBe('invalid_request_error')
  })

  it('resolves flat model name when enableFlatModelLookup is on', async () => {
    const app = createApp({
      settings: makeSettings(singleProvider, true),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/chat')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: 'chat',
      object: 'model',
      created: 0,
      owned_by: 'openrouter',
    })
  })

  it('resolves alias when enableFlatModelLookup is on', async () => {
    const app = createApp({
      settings: makeSettings(singleProvider, true),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/default')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      id: 'default',
      object: 'model',
      created: 0,
      owned_by: 'openrouter',
    })
  })

  it('returns 404 for flat name when enableFlatModelLookup is off', async () => {
    const app = createApp({
      settings: makeSettings(singleProvider, false),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models/chat')

    expect(response.status).toBe(404)
  })

  it('includes flat names only for providers with flat lookup enabled', async () => {
    const providers: Settings['providers'] = {
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        enableFlatModelLookup: true,
        models: {
          chat: {
            upstreamModel: 'openrouter/auto',
            aliases: ['default'],
            headers: {},
            plugins: [],
          },
        },
      },
      deepseek: {
        type: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: {
          reasoner: { upstreamModel: 'deepseek-reasoner', aliases: [], headers: {}, plugins: [] },
        },
      },
    }
    const app = createApp({
      settings: makeSettings(providers, false),
      providerRegistry: stubRegistry,
    })
    const response = await app.request('/v1/models')

    expect(response.status).toBe(200)
    const body = await response.json()
    // openrouter gets flat names (chat + default alias), deepseek does not
    expect(body.data).toEqual([
      { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter' },
      { id: 'chat', object: 'model', created: 0, owned_by: 'openrouter' },
      { id: 'default', object: 'model', created: 0, owned_by: 'openrouter' },
      { id: 'deepseek/reasoner', object: 'model', created: 0, owned_by: 'deepseek' },
    ])
  })

  it('resolves flat name only for provider with flat lookup enabled', async () => {
    const providers: Settings['providers'] = {
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        enableFlatModelLookup: true,
        models: {
          chat: { upstreamModel: 'openrouter/auto', aliases: [], headers: {}, plugins: [] },
        },
      },
      deepseek: {
        type: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: {
          reasoner: { upstreamModel: 'deepseek-reasoner', aliases: [], headers: {}, plugins: [] },
        },
      },
    }
    const app = createApp({
      settings: makeSettings(providers, false),
      providerRegistry: stubRegistry,
    })

    // 'chat' resolves via openrouter's flat lookup
    const chatResponse = await app.request('/v1/models/chat')
    expect(chatResponse.status).toBe(200)

    // 'reasoner' does NOT resolve because deepseek has flat lookup disabled
    const reasonerResponse = await app.request('/v1/models/reasoner')
    expect(reasonerResponse.status).toBe(404)
  })
})
