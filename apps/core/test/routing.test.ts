import { describe, expect, it } from 'vitest'
import type { Settings } from '@llm-proxy/core'
import { RoutingError, RoutingTable } from '../src/routing.js'

function settings(enableFlatModelLookup = false): Settings {
  return {
    service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
    requestTimeoutMs: 30000,
    proxy: null,
    routing: { enableFlatModelLookup },
    plugins: [],
    providers: {
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: { 'X-Provider': 'provider' },
        plugins: [{ name: 'vendor_sse_error', config: { maxPreviewEvents: 3 }, providers: [] }],
        models: {
          chat: {
            upstreamModel: 'openrouter/chat',
            aliases: ['default'],
            headers: { 'X-Model': 'model' },
            plugins: [{ name: 'vendor_sse_error', config: { maxPreviewEvents: 1 }, providers: [] }],
          },
        },
      },
    },
  }
}

describe('RoutingTable', () => {
  it('resolves provider/model selectors and merged route data', () => {
    const table = RoutingTable.fromSettings(settings())
    const route = table.resolve('openrouter/chat')

    expect(route.providerName).toBe('openrouter')
    expect(route.modelKey).toBe('chat')
    expect(route.upstreamModel).toBe('openrouter/chat')
    expect(route.headers).toEqual({ 'X-Provider': 'provider', 'X-Model': 'model' })
    // Without a PluginRegistry, resolvedPlugins is empty
    expect(route.resolvedPlugins).toEqual([])
  })

  it('resolves aliases inside an explicit provider', () => {
    const table = RoutingTable.fromSettings(settings())
    expect(table.resolve('openrouter/default').modelKey).toBe('chat')
  })

  it('rejects flat lookup when disabled', () => {
    const table = RoutingTable.fromSettings(settings(false))
    expect(() => table.resolve('default')).toThrow(RoutingError)
    try {
      table.resolve('default')
    } catch (error) {
      expect((error as RoutingError).code).toBe('flat_lookup_disabled')
    }
  })

  it('resolves flat aliases when enabled', () => {
    const table = RoutingTable.fromSettings(settings(true))
    expect(table.resolve('default').upstreamModel).toBe('openrouter/chat')
  })

  it('rejects ambiguous flat selectors when enabled', () => {
    const duplicate = settings(true)
    const openrouter = duplicate.providers.openrouter
    if (!openrouter) {
      throw new Error('Expected openrouter provider in test settings')
    }
    openrouter.models.other = {
      upstreamModel: 'openrouter/other',
      aliases: ['default'],
      headers: {},
      plugins: [],
    }

    expect(() => RoutingTable.fromSettings(duplicate)).toThrow("ambiguous flat route 'default'")
  })

  it('resolves flat aliases when enabled per-provider but globally off', () => {
    const s = settings(false)
    s.providers.openrouter!.enableFlatModelLookup = true
    const table = RoutingTable.fromSettings(s)
    expect(table.resolve('default').upstreamModel).toBe('openrouter/chat')
  })

  it('rejects flat lookup when disabled per-provider but globally on', () => {
    const s = settings(true)
    s.providers.openrouter!.enableFlatModelLookup = false
    const table = RoutingTable.fromSettings(s)
    try {
      table.resolve('default')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as RoutingError).code).toBe('flat_lookup_disabled')
    }
  })

  it('allows same flat name across providers when only one has flat lookup enabled', () => {
    const s = settings(false)
    s.providers.openrouter!.enableFlatModelLookup = true
    s.providers.deepseek = {
      type: 'openai-compatible',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'secret',
      headers: {},
      plugins: [],
      models: {
        other: { upstreamModel: 'deepseek/other', aliases: ['default'], headers: {}, plugins: [] },
      },
    }
    // deepseek has no enableFlatModelLookup override and global is false,
    // so its 'default' alias is NOT in flatRoutes — no ambiguity
    const table = RoutingTable.fromSettings(s)
    expect(table.resolve('default').providerName).toBe('openrouter')
  })

  it('rejects ambiguous flat selectors across providers both with flat lookup enabled', () => {
    const s = settings(true)
    s.providers.deepseek = {
      type: 'openai-compatible',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'secret',
      headers: {},
      plugins: [],
      models: {
        other: { upstreamModel: 'deepseek/other', aliases: ['default'], headers: {}, plugins: [] },
      },
    }
    // Both openrouter (inherits global true) and deepseek (inherits global true)
    // have 'default' alias — ambiguous
    expect(() => RoutingTable.fromSettings(s)).toThrow("ambiguous flat route 'default'")
  })

  it('returns flat_lookup_disabled when no provider has flat lookup enabled', () => {
    const s = settings(false)
    s.providers.deepseek = {
      type: 'openai-compatible',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'secret',
      headers: {},
      plugins: [],
      enableFlatModelLookup: false,
      models: { other: { upstreamModel: 'deepseek/other', aliases: [], headers: {}, plugins: [] } },
    }
    const table = RoutingTable.fromSettings(s)
    try {
      table.resolve('anything')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as RoutingError).code).toBe('flat_lookup_disabled')
    }
  })

  it('returns unknown_model for flat selector when some providers have flat lookup enabled but none match', () => {
    const s = settings(false)
    s.providers.openrouter!.enableFlatModelLookup = true
    const table = RoutingTable.fromSettings(s)
    try {
      table.resolve('nonexistent')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as RoutingError).code).toBe('unknown_model')
    }
  })
})
