import { describe, expect, it } from 'vitest'
import { enumerateModelEntries } from '../../src/providers/model-types.js'
import type { Settings } from '../../src/config.js'

function makeSettings(providers: Settings['providers'] = {}, enableFlatModelLookup = false): Settings {
  return {
    service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
    requestTimeoutMs: 30000,
    proxy: null,
    routing: { enableFlatModelLookup },
    plugins: [],
    codex: { templateSlug: 'gpt-5.4', context_window: 200000 },
    providers,
  }
}

describe('enumerateModelEntries', () => {
  it('emits only provider/modelKey when flat lookup disabled', () => {
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
            aliases: ['default'],
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

    const entries = enumerateModelEntries(settings)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.ids)).toEqual([['openrouter/chat'], ['openrouter/basic']])
    // modelKey + providerName populated
    expect(entries[0]!.modelKey).toBe('chat')
    expect(entries[0]!.providerName).toBe('openrouter')
    // flat false → ids only contains the provider/modelKey
    expect(entries[0]!.flat).toBe(false)
    expect(entries[0]!.aliases).toEqual(['default'])
    expect(entries[0]!.upstreamModel).toBe('openrouter/auto')
    expect(entries[0]!.limit).toEqual({ context: 128000, output: 4096 })
    // limit undefined when not configured
    expect(entries[1]!.limit).toBeUndefined()
  })

  it('adds modelKey + each alias to ids when flat lookup enabled globally', () => {
    const settings = makeSettings(
      {
        openrouter: {
          type: 'openai-compatible',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'secret',
          headers: {},
          plugins: [],
          models: {
            chat: {
              upstreamModel: 'openrouter/auto',
              aliases: ['default', 'fast'],
              headers: {},
              plugins: [],
              limit: { context: 200000 },
            },
          },
        },
      },
      true,
    )

    const entries = enumerateModelEntries(settings)
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.flat).toBe(true)
    // ids order: provider/modelKey, modelKey, then each alias in config order
    expect(entry.ids).toEqual(['openrouter/chat', 'chat', 'default', 'fast'])
  })

  it('respects per-provider enableFlatModelLookup override (on while global off)', () => {
    const settings = makeSettings({
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        options: { enableFlatModelLookup: true },
        models: {
          chat: { upstreamModel: 'u', aliases: ['a1'], headers: {}, plugins: [] },
        },
      },
      deepseek: {
        type: 'openai-compatible',
        baseURL: 'https://y',
        apiKey: 'k',
        headers: {},
        plugins: [],
        // no override, global off → flat false
        models: {
          coder: { upstreamModel: 'd', aliases: ['a2'], headers: {}, plugins: [] },
        },
      },
    })

    const entries = enumerateModelEntries(settings)
    // openrouter flat → 3 ids; deepseek not flat → 1 id
    expect(entries.find((e) => e.providerName === 'openrouter')!.ids).toEqual([
      'openrouter/chat',
      'chat',
      'a1',
    ])
    expect(entries.find((e) => e.providerName === 'deepseek')!.ids).toEqual(['deepseek/coder'])
    expect(entries.find((e) => e.providerName === 'deepseek')!.flat).toBe(false)
  })

  it('iterates providers in insertion order and models in insertion order', () => {
    const settings = makeSettings({
      zeta: {
        type: 'openai-compatible',
        baseURL: 'https://z',
        apiKey: 'k',
        headers: {},
        plugins: [],
        models: {
          m2: { upstreamModel: 'u2', aliases: [], headers: {}, plugins: [] },
          m1: { upstreamModel: 'u1', aliases: [], headers: {}, plugins: [] },
        },
      },
      alpha: {
        type: 'openai-compatible',
        baseURL: 'https://a',
        apiKey: 'k',
        headers: {},
        plugins: [],
        models: {
          m3: { upstreamModel: 'u3', aliases: [], headers: {}, plugins: [] },
        },
      },
    })

    const entries = enumerateModelEntries(settings)
    // providers in insertion order (zeta before alpha), models in insertion order (m2 before m1)
    expect(entries.map((e) => `${e.providerName}/${e.modelKey}`)).toEqual([
      'zeta/m2',
      'zeta/m1',
      'alpha/m3',
    ])
  })

  it('returns empty array for empty providers', () => {
    expect(enumerateModelEntries(makeSettings())).toEqual([])
  })

  it('aliases array is the config value (not mutated)', () => {
    const settings = makeSettings({
      p: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        models: {
          m: { upstreamModel: 'u', aliases: ['x', 'y'], headers: {}, plugins: [] },
        },
      },
    })
    const entry = enumerateModelEntries(settings)[0]!
    expect(entry.aliases).toEqual(['x', 'y'])
    expect(entry.aliases).not.toBe(settings.providers.p!.models.m!.aliases) // defensive copy
  })
})
