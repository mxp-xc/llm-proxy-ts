import { describe, expect, it } from 'vitest'
import type { Settings } from '../src/index.js'
import type { AliasEntry, ModelRouteConfig } from '../src/config.js'
import { RoutingError, RoutingTable } from '../src/routing.js'
import { makeSettings } from './helpers/settings.js'

// Import to register vendor_sse_error as a built-in plugin
import '../src/plugins/builtins/vendor-sse-error.js'

function settings(enableFlatModelLookup = false): Settings {
  return makeSettings(
    {
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: { 'X-Provider': 'provider' },
        plugins: [{ name: 'vendor_sse_error', config: { maxPreviewEvents: 3 }, providers: [] }],
        models: {
          chat: {
            upstreamModel: 'openrouter/chat',
            aliases: [{ name: 'default', flat: false }],
            headers: { 'X-Model': 'model' },
            plugins: [{ name: 'vendor_sse_error', config: { maxPreviewEvents: 1 }, providers: [] }],
          },
        },
      },
    },
    { routing: { enableFlatModelLookup } },
  )
}

describe('RoutingTable', () => {
  it('resolves provider/model selectors and merged route data', () => {
    const table = RoutingTable.fromSettings(settings())
    const route = table.resolve('openrouter/chat')

    expect(route.providerName).toBe('openrouter')
    expect(route.modelKey).toBe('chat')
    expect(route.upstreamModel).toBe('openrouter/chat')
    expect(route.headers).toEqual({ 'X-Provider': 'provider', 'X-Model': 'model' })
    // Without a PluginRegistry, resolveBuiltinPlugins resolves vendor_sse_error
    expect(route.resolvedPlugins).toHaveLength(1)
    expect(route.resolvedPlugins[0]!.plugin.name).toBe('vendor_sse_error')
  })

  it('resolves aliases inside an explicit provider', () => {
    const table = RoutingTable.fromSettings(settings())
    expect(table.resolve('openrouter/default').modelKey).toBe('chat')
  })

  it('resolves flat aliases when enabled (provider-level flat)', () => {
    // openrouter inherits global enableFlatModelLookup=true; alias 'default' flat:false
    // → registered as bare name because modelFlat is true
    const table = RoutingTable.fromSettings(settings(true))
    expect(table.resolve('default').upstreamModel).toBe('openrouter/chat')
  })

  it('resolves flat aliases when enabled per-provider but globally off', () => {
    const s = settings(false)
    s.providers.openrouter!.options = {
      ...s.providers.openrouter!.options,
      enableFlatModelLookup: true,
    }
    const table = RoutingTable.fromSettings(s)
    expect(table.resolve('default').upstreamModel).toBe('openrouter/chat')
  })

  it('returns unknown_model when no flat alias matches (no flat_lookup_disabled)', () => {
    const s = settings(false)
    s.providers.openrouter!.options = {
      ...s.providers.openrouter!.options,
      enableFlatModelLookup: true,
    }
    const table = RoutingTable.fromSettings(s)
    try {
      table.resolve('nonexistent')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as RoutingError).code).toBe('unknown_model')
    }
  })

  it('lets later flat selectors override earlier providers when flat lookup is enabled', () => {
    const s = settings(true)
    s.providers.deepseek = {
      type: 'openai-compatible',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'secret',
      headers: {},
      plugins: [],
      models: {
        other: {
          upstreamModel: 'deepseek/other',
          aliases: [{ name: 'default', flat: false }],
          headers: {},
          plugins: [],
        },
      },
    }
    const table = RoutingTable.fromSettings(s)
    expect(table.resolve('default').providerName).toBe('deepseek')
    expect(table.resolve('default').upstreamModel).toBe('deepseek/other')
  })

  it('model-level plugin overrides provider-level with same name (no PluginRegistry)', () => {
    const table = RoutingTable.fromSettings(settings())
    const route = table.resolve('openrouter/chat')
    // resolveBuiltinPlugins: model's vendor_sse_error config {maxPreviewEvents:1} should win
    // over provider's {maxPreviewEvents:3} because Map.set overwrites on same name
    expect(route.resolvedPlugins).toHaveLength(1)
    expect(route.resolvedPlugins[0]!.config).toEqual({ maxPreviewEvents: 1 })
  })

  it('stores pluginRegistry and uses it in resolve()', () => {
    const mockPluginRegistry = {
      getPipelinePlugins: (_providerId: string, _modelKey?: string) => [
        { plugin: { name: 'test-plugin' }, config: { from: 'registry' }, providers: [] },
      ],
    } as unknown as import('../src/plugins/registry.js').PluginRegistry
    const table = RoutingTable.fromSettings(settings(), mockPluginRegistry)
    const route = table.resolve('openrouter/chat')
    // Should use PluginRegistry instead of resolveBuiltinPlugins
    expect(route.resolvedPlugins).toHaveLength(1)
    expect(route.resolvedPlugins[0]!.config).toEqual({ from: 'registry' })
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

describe('RoutingTable flat/alias resolution', () => {
  it('resolves provider/<alias> prefixed entry without flat', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: false }]) }) })
    expect(RoutingTable.fromSettings(s).resolve('p/a').modelKey).toBe('m')
  })

  it('resolves prefixed model selectors whose model name contains slashes', () => {
    const s = makeSettings({ openai: P({ 'codex/mini': M('up') }, true) })
    const route = RoutingTable.fromSettings(s).resolve('openai/codex/mini')
    expect(route.providerName).toBe('openai')
    expect(route.modelKey).toBe('codex/mini')
    expect(route.upstreamModel).toBe('up')
  })

  it('resolves record alias flat:true naked name without provider flat', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'a', flat: true }]) }) })
    expect(RoutingTable.fromSettings(s).resolve('a').modelKey).toBe('m')
  })

  it('naked name miss returns unknown_model (no flat_lookup_disabled)', () => {
    const s = makeSettings({ p: P({ m: M('up', []) }) })
    try {
      RoutingTable.fromSettings(s).resolve('nope')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as RoutingError).code).toBe('unknown_model')
    }
  })

  it('lets later flat aliases override earlier providers', () => {
    const mk = (flat: boolean) => P({ m: M('up', [{ name: 'shared', flat }]) })
    const s = makeSettings({ p1: mk(true), p2: mk(true) })
    expect(RoutingTable.fromSettings(s).resolve('shared').providerName).toBe('p2')
  })

  it('rejects duplicate prefixed selector: alias name == modelKey', () => {
    const s = makeSettings({ p: P({ m: M('up', [{ name: 'm', flat: false }]) }) })
    expect(() => RoutingTable.fromSettings(s)).toThrow(
      /duplicate model selector 'm' in provider 'p'/,
    )
  })

  it('rejects duplicate prefixed selector: same alias name across models in same provider', () => {
    const s = makeSettings({
      p: P({
        m1: M('up', [{ name: 'fast', flat: false }]),
        m2: M('up', [{ name: 'fast', flat: false }]),
      }),
    })
    expect(() => RoutingTable.fromSettings(s)).toThrow(
      /duplicate model selector 'fast' in provider 'p'/,
    )
  })
})

describe('RoutingTable prefixed route cache', () => {
  it('caches prefixed routes — resolve returns same RouteMatch instance for repeated selectors', () => {
    const s = makeSettings({
      prov: P({ model: M('up', [{ name: 'aliasName', flat: false }]) }),
    })
    const table = RoutingTable.fromSettings(s)
    const a = table.resolve('prov/model')
    const b = table.resolve('prov/model')
    expect(a).toBe(b) // 同一缓存实例,无 per-request buildRoute

    const aliasHit = table.resolve('prov/aliasName')
    expect(aliasHit.modelKey).toBe('model')
    expect(aliasHit.modelSelector).toBe('prov/aliasName')
  })

  it('returns unknown_provider for prefixed selector with unconfigured provider (not in cache)', () => {
    const s = makeSettings({ prov: P({ model: M('up', []) }) })
    const table = RoutingTable.fromSettings(s)
    try {
      table.resolve('other/model')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as RoutingError).code).toBe('unknown_provider')
    }
  })

  it('returns unknown_model for prefixed selector with configured provider but unknown model', () => {
    const s = makeSettings({ prov: P({ model: M('up', []) }) })
    const table = RoutingTable.fromSettings(s)
    try {
      table.resolve('prov/nonexistent')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as RoutingError).code).toBe('unknown_model')
    }
  })
})
