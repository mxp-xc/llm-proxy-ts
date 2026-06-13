import { describe, expect, it, vi } from 'vitest'
import type { Settings, Logger } from '@llm-proxy/core'
import type { ResolvedPlugin, AuthPlugin } from '../src/plugins/types.js'
import { PluginRegistry } from '../src/plugins/registry.js'
import { createProviderRegistry } from '../src/providers/registry.js'

const noopLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return noopLogger
  },
}

/**
 * Create a mock AuthPlugin that tracks calls and returns a fetch wrapper
 * that injects a known header.
 */
function createMockAuthPlugin() {
  const calls: { providerName: string; input: string }[] = []

  const plugin: AuthPlugin = {
    name: 'mock-auth-plugin',
    async createFetch(ctx) {
      return (baseFetch) => async (input, init) => {
        calls.push({ providerName: ctx.id, input: String(input) })
        const headers = new Headers(init?.headers)
        headers.set('X-Auth-Plugin', `mock-for-${ctx.id}`)
        const fetchFn = baseFetch ?? globalThis.fetch
        return fetchFn(input, { ...init, headers })
      }
    },
  }

  return { plugin, calls }
}

// Mock createOpenAICompatibleProvider to avoid needing real AI SDK setup
vi.mock('../src/providers/shared/provider-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/shared/provider-factory.js')>()
  return {
    ...original,
    createOpenAICompatibleProvider(
      providerName: string,
      provider: unknown,
      settings: unknown,
      modelHeaders: unknown,
      selectedApiKey: string | undefined,
      customFetch?: (baseFetch?: typeof fetch) => typeof fetch,
    ) {
      return (upstreamModel: string) => ({
        upstreamModel,
        providerName,
        selectedApiKey,
        customFetch: customFetch ? 'present' : 'absent',
      })
    },
    sanitizeHeaders(headers: Record<string, string>) {
      return original.sanitizeHeaders(headers)
    },
  }
})

describe('auth plugin integration with createProviderRegistry', () => {
  it('Provider with auth plugin should use both authFetch and apiKey', async () => {
    const { plugin: mockPlugin } = createMockAuthPlugin()

    const settings: Settings = {
      service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
      requestTimeoutMs: 30000,
      proxy: null,
      routing: { enableFlatModelLookup: false },
      plugins: [
        {
          name: 'mock-auth-plugin',
          config: { tokenUrl: 'https://auth.example.com/token' },
          providers: ['auth-provider'],
        },
      ],
      providers: {
        'auth-provider': {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'test-api-key',
          headers: {},
          plugins: [],
          models: {},
        },
      },
    }

    // Manually construct a PluginRegistry with the mock plugin
    const resolvedPlugins: ResolvedPlugin[] = [
      {
        plugin: mockPlugin,
        config: { tokenUrl: 'https://auth.example.com/token' },
        providers: ['auth-provider'],
      },
    ]
    const pluginRegistry = {
      createAuthFetch: async (providerId: string) => {
        if (resolvedPlugins[0]!.providers.includes(providerId)) {
          const ctx = {
            id: providerId,
            provider: settings.providers[providerId]!,
            config: resolvedPlugins[0]!.config,
            store: {
              async get() {
                return {}
              },
              async set() {},
            },
            log: noopLogger,
          }
          return mockPlugin.createFetch(ctx)
        }
        return undefined
      },
    } as unknown as import('../src/plugins/registry.js').PluginRegistry

    const registry = await createProviderRegistry(settings, undefined, noopLogger, pluginRegistry)
    const result = registry.languageModel(
      'auth-provider',
      'upstream-model',
      {},
    )
    const model = result.model as unknown as Record<string, unknown>

    // authFetch should be present; apiKey should still be passed (plugin only extends fetch)
    expect(model.customFetch).toBe('present')
    expect(model.selectedApiKey).toBe('test-api-key')
  })

  it('Provider without auth/oauth should use apiKey as before', async () => {
    const settings: Settings = {
      service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
      requestTimeoutMs: 30000,
      proxy: null,
      routing: { enableFlatModelLookup: false },
      plugins: [],
      providers: {
        'simple-provider': {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'my-api-key',
          headers: {},
          plugins: [],
          models: {},
        },
      },
    }

    const registry = await createProviderRegistry(settings, undefined, noopLogger)
    const result = registry.languageModel(
      'simple-provider',
      'upstream-model',
      {},
    )
    const model = result.model as unknown as Record<string, unknown>

    expect(model.customFetch).toBe('absent')
    expect(model.selectedApiKey).toBe('my-api-key')
  })

  it('Provider with auth plugin targeting different provider should not get authFetch', async () => {
    const { plugin: mockPlugin } = createMockAuthPlugin()

    const settings: Settings = {
      service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
      requestTimeoutMs: 30000,
      proxy: null,
      routing: { enableFlatModelLookup: false },
      plugins: [{ name: 'mock-auth-plugin', config: {}, providers: ['other-provider'] }],
      providers: {
        'auth-provider': {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'fallback-key',
          headers: {},
          plugins: [],
          models: {},
        },
      },
    }

    // Plugin targets 'other-provider', not 'auth-provider'
    const resolvedPlugins: ResolvedPlugin[] = [
      { plugin: mockPlugin, config: {}, providers: ['other-provider'] },
    ]
    const pluginRegistry = {
      createAuthFetch: async (providerId: string) => {
        for (const rp of resolvedPlugins) {
          if (rp.providers.includes(providerId)) {
            const ctx = {
              id: providerId,
              provider: settings.providers[providerId]!,
              config: rp.config,
              store: {
              async get() {
                return {}
              },
              async set() {},
            },
              log: noopLogger,
            }
            return (rp.plugin as AuthPlugin).createFetch(ctx)
          }
        }
        return undefined
      },
    } as unknown as import('../src/plugins/registry.js').PluginRegistry

    const registry = await createProviderRegistry(settings, undefined, noopLogger, pluginRegistry)
    const result = registry.languageModel(
      'auth-provider',
      'upstream-model',
      {},
    )
    const model = result.model as unknown as Record<string, unknown>

    // No authFetch for 'auth-provider' since plugin targets 'other-provider'
    expect(model.customFetch).toBe('absent')
    expect(model.selectedApiKey).toBe('fallback-key')
  })
})
