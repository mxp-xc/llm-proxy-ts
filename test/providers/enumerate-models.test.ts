import { describe, expect, it } from 'vitest'
import { enumerateModelEntries } from '../../src/providers/model-types.js'
import type { AliasEntry, ModelRouteConfig, Settings } from '../../src/config.js'

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
    codex: {
      models_catalog: { templateSlug: 'gpt-5.4', context_window: 200000 },
      install: {
        providerId: 'llm-proxy',
        providerName: 'LLM Proxy',
        requiresOpenaiAuth: false,
        checkForUpdateOnStartup: false,
      },
    },
    errorLogging: { enabled: true, maxBodyLength: 262144 },
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
            aliases: [{ name: 'default', flat: false }],
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
    // flat off: provider/modelKey + prefixed alias entries (no bare names)
    expect(entries.map((e) => e.ids)).toEqual([
      ['openrouter/chat', 'openrouter/default'],
      ['openrouter/basic'],
    ])
    // modelKey + providerName populated
    expect(entries[0]!.modelKey).toBe('chat')
    expect(entries[0]!.providerName).toBe('openrouter')
    // flat false → ids only contains the provider/modelKey (+ prefixed alias entries)
    expect(entries[0]!.modelFlat).toBe(false)
    expect(entries[0]!.aliases).toEqual([{ name: 'default', flat: false }])
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
              aliases: [
                { name: 'default', flat: false },
                { name: 'fast', flat: false },
              ],
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
    expect(entry.modelFlat).toBe(true)
    // ids order: provider/modelKey, modelKey, then each alias as [provider/name, name]
    expect(entry.ids).toEqual([
      'openrouter/chat',
      'chat',
      'openrouter/default',
      'default',
      'openrouter/fast',
      'fast',
    ])
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
          chat: {
            upstreamModel: 'u',
            aliases: [{ name: 'a1', flat: false }],
            headers: {},
            plugins: [],
          },
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
          coder: {
            upstreamModel: 'd',
            aliases: [{ name: 'a2', flat: false }],
            headers: {},
            plugins: [],
          },
        },
      },
    })

    const entries = enumerateModelEntries(settings)
    // openrouter flat → [p/m, m, p/a1, a1]; deepseek not flat → [p/coder, p/a2]
    expect(entries.find((e) => e.providerName === 'openrouter')!.ids).toEqual([
      'openrouter/chat',
      'chat',
      'openrouter/a1',
      'a1',
    ])
    expect(entries.find((e) => e.providerName === 'deepseek')!.ids).toEqual([
      'deepseek/coder',
      'deepseek/a2',
    ])
    expect(entries.find((e) => e.providerName === 'deepseek')!.modelFlat).toBe(false)
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
          m: {
            upstreamModel: 'u',
            aliases: [
              { name: 'x', flat: false },
              { name: 'y', flat: false },
            ],
            headers: {},
            plugins: [],
          },
        },
      },
    })
    const entry = enumerateModelEntries(settings)[0]!
    expect(entry.aliases).toEqual([
      { name: 'x', flat: false },
      { name: 'y', flat: false },
    ])
    expect(entry.aliases).not.toBe(settings.providers.p!.models.m!.aliases) // defensive copy
  })
})

const P = (models: Record<string, ModelRouteConfig>, flat = false) => ({
  type: 'openai-compatible' as const,
  baseURL: 'http://x',
  apiKey: 'k',
  headers: {},
  plugins: [],
  options: flat ? { enableFlatModelLookup: true } : undefined,
  models,
})
const M = (upstreamModel: string, aliases: AliasEntry[] = [], flat = false): ModelRouteConfig => ({
  upstreamModel,
  aliases,
  flat,
  headers: {},
  plugins: [],
})

describe('enumerateModelEntries ids (new semantics)', () => {
  it('flat off + 1 string alias → [p/m, p/a]', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: false }]) }) })
    const e = enumerateModelEntries(s).find((x) => x.modelKey === 'm')!
    expect(e.ids).toEqual(['p/m', 'p/a'])
    expect(e.modelFlat).toBe(false)
  })

  it('flat on + 2 string alias → [p/m, m, p/a1, a1, p/a2, a2]', () => {
    const s = makeSettings({
      p: P(
        {
          m: M('up', [
            { name: 'a1', flat: false },
            { name: 'a2', flat: false },
          ]),
        },
        true,
      ),
    })
    const e = enumerateModelEntries(s).find((x) => x.modelKey === 'm')!
    expect(e.ids).toEqual(['p/m', 'm', 'p/a1', 'a1', 'p/a2', 'a2'])
    expect(e.modelFlat).toBe(true)
  })

  it('flat off + record alias {flat:true} → [p/m, p/a, a]', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: true }]) }) })
    const e = enumerateModelEntries(s).find((x) => x.modelKey === 'm')!
    expect(e.ids).toEqual(['p/m', 'p/a', 'a'])
    expect(e.modelFlat).toBe(false)
  })

  it('model.flat=true (provider flat off) → [p/m, m, p/a, a]', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: false }], true) }) })
    const e = enumerateModelEntries(s).find((x) => x.modelKey === 'm')!
    expect(e.ids).toEqual(['p/m', 'm', 'p/a', 'a'])
    expect(e.modelFlat).toBe(true)
  })
})
