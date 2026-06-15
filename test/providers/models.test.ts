import { describe, expect, it } from 'vitest'
import { getModel, listModels } from '../../src/providers/models.js'
import type { Settings } from '../../src/config.js'

function makeSettings(providers: Settings['providers'] = {}, enableFlatModelLookup = false): Settings {
  return {
    service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
    requestTimeoutMs: 30000,
    proxy: null,
    routing: { enableFlatModelLookup },
    plugins: [],
    providers,
  }
}

describe('listModels', () => {
  it('includes limit when configured on a model', () => {
    const settings = makeSettings({
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: {
          chat: {
            upstreamModel: 'openrouter/auto',
            aliases: [],
            headers: {},
            plugins: [],
            limit: { context: 128000, output: 4096 },
          },
          basic: {
            upstreamModel: 'openrouter/basic',
            aliases: [],
            headers: {},
            plugins: [],
          },
        },
      },
    })

    const result = listModels(settings)
    expect(result.data).toEqual([
      { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter', limit: { context: 128000, output: 4096 } },
      { id: 'openrouter/basic', object: 'model', created: 0, owned_by: 'openrouter' },
    ])
  })

  it('omits limit when all fields are undefined', () => {
    const settings = makeSettings({
      provider: {
        type: 'openai-compatible',
        baseURL: 'https://example.com/v1',
        apiKey: 'key',
        headers: {},
        plugins: [],
        models: {
          m: {
            upstreamModel: 'upstream/m',
            aliases: [],
            headers: {},
            plugins: [],
            limit: {},
          },
        },
      },
    })

    const result = listModels(settings)
    expect(result.data[0]).not.toHaveProperty('limit')
  })

  it('includes limit in flat lookup entries', () => {
    const settings = makeSettings(
      {
        openrouter: {
          type: 'openai-compatible',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'secret',
          headers: {},
          plugins: [],
          options: { enableFlatModelLookup: true },
          models: {
            chat: {
              upstreamModel: 'openrouter/auto',
              aliases: ['default'],
              headers: {},
              plugins: [],
              limit: { context: 200000, input: 200000, output: 8192 },
            },
          },
        },
      },
      true,
    )

    const result = listModels(settings)
    const expectedLimit = { context: 200000, input: 200000, output: 8192 }
    expect(result.data).toEqual([
      { id: 'openrouter/chat', object: 'model', created: 0, owned_by: 'openrouter', limit: expectedLimit },
      { id: 'chat', object: 'model', created: 0, owned_by: 'openrouter', limit: expectedLimit },
      { id: 'default', object: 'model', created: 0, owned_by: 'openrouter', limit: expectedLimit },
    ])
  })
})

describe('getModel', () => {
  it('returns limit for provider/modelKey lookup', () => {
    const settings = makeSettings({
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: {
          chat: {
            upstreamModel: 'openrouter/auto',
            aliases: [],
            headers: {},
            plugins: [],
            limit: { context: 128000, output: 4096 },
          },
        },
      },
    })

    const model = getModel(settings, 'openrouter/chat')
    expect(model).toEqual({
      id: 'openrouter/chat',
      object: 'model',
      created: 0,
      owned_by: 'openrouter',
      limit: { context: 128000, output: 4096 },
    })
  })

  it('returns limit for flat lookup by alias', () => {
    const settings = makeSettings(
      {
        openrouter: {
          type: 'openai-compatible',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'secret',
          headers: {},
          plugins: [],
          options: { enableFlatModelLookup: true },
          models: {
            chat: {
              upstreamModel: 'openrouter/auto',
              aliases: ['default'],
              headers: {},
              plugins: [],
              limit: { context: 128000, output: 4096 },
            },
          },
        },
      },
      true,
    )

    const model = getModel(settings, 'default')
    expect(model).toEqual({
      id: 'default',
      object: 'model',
      created: 0,
      owned_by: 'openrouter',
      limit: { context: 128000, output: 4096 },
    })
  })

  it('omits limit when not configured', () => {
    const settings = makeSettings({
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: {
          chat: {
            upstreamModel: 'openrouter/auto',
            aliases: [],
            headers: {},
            plugins: [],
          },
        },
      },
    })

    const model = getModel(settings, 'openrouter/chat')
    expect(model).toEqual({
      id: 'openrouter/chat',
      object: 'model',
      created: 0,
      owned_by: 'openrouter',
    })
    expect(model).not.toHaveProperty('limit')
  })
})
