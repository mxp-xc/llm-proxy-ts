import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Settings } from '../../src/index.js'
import type { ResolvedPlugin, AuthPlugin } from '../../src/plugins/types.js'
import { PluginRegistry, type AuthFetchRegistry } from '../../src/plugins/registry.js'
import { createProviderRegistry } from '../../src/providers/registry.js'
import type { Logger } from '../../src/types.js'
import { makeSettings } from '../helpers/settings.js'
import { noopLogger } from '../helpers/registry.js'
import { createCapturingProviderFactory } from '../helpers/provider-factory.js'

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

const { factory: stubFactory, inputs: capturedFactoryInputs } = createCapturingProviderFactory()

afterEach(() => {
  capturedFactoryInputs.length = 0
})

describe('auth plugin integration with createProviderRegistry', () => {
  it('Provider with auth plugin should use both authFetch and apiKey', async () => {
    const { plugin: mockPlugin } = createMockAuthPlugin()

    const settings = makeSettings(
      {
        'auth-provider': {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'test-api-key',
          headers: {},
          plugins: [],
          models: {},
        },
      },
      {
        plugins: [
          {
            name: 'mock-auth-plugin',
            config: { tokenUrl: 'https://auth.example.com/token' },
            providers: ['auth-provider'],
          },
        ],
      },
    )

    // Manually construct a PluginRegistry with the mock plugin
    const resolvedPlugins: ResolvedPlugin[] = [
      {
        plugin: mockPlugin,
        config: { tokenUrl: 'https://auth.example.com/token' },
        providers: ['auth-provider'],
      },
    ]
    const pluginRegistry: AuthFetchRegistry = {
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
    }

    const registry = await createProviderRegistry(
      settings,
      undefined,
      noopLogger,
      pluginRegistry,
      undefined,
      stubFactory,
    )
    const result = registry.languageModel('auth-provider', 'upstream-model', {})

    // authFetch should be present; apiKey should still be passed (plugin only extends fetch)
    expect(result.model).toBeTruthy()
    expect(capturedFactoryInputs[0]!.selectedApiKey).toBe('test-api-key')
    expect(capturedFactoryInputs[0]!.customFetch).toBeDefined()

    let capturedHeaders: Headers | undefined
    const fetchWithAuth = capturedFactoryInputs[0]!.customFetch!(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response('{}')
    })
    await fetchWithAuth('https://api.example.com/v1/responses', {
      headers: { accept: 'application/json' },
    })

    expect(capturedHeaders?.get('x-auth-plugin')).toBe('mock-for-auth-provider')
  })

  it('Provider without auth/oauth should use apiKey as before', async () => {
    const settings = makeSettings({
      'simple-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'my-api-key',
        headers: {},
        plugins: [],
        models: {},
      },
    })

    const registry = await createProviderRegistry(
      settings,
      undefined,
      noopLogger,
      undefined,
      undefined,
      stubFactory,
    )
    const result = registry.languageModel('simple-provider', 'upstream-model', {})

    expect(result.model).toBeTruthy()
    expect(capturedFactoryInputs[0]!.customFetch).toBeUndefined()
    expect(capturedFactoryInputs[0]!.selectedApiKey).toBe('my-api-key')
  })

  it('Provider with auth plugin targeting different provider should not get authFetch', async () => {
    const { plugin: mockPlugin } = createMockAuthPlugin()

    const settings = makeSettings(
      {
        'auth-provider': {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'fallback-key',
          headers: {},
          plugins: [],
          models: {},
        },
      },
      {
        plugins: [{ name: 'mock-auth-plugin', config: {}, providers: ['other-provider'] }],
      },
    )

    // Plugin targets 'other-provider', not 'auth-provider'
    const resolvedPlugins: ResolvedPlugin[] = [
      { plugin: mockPlugin, config: {}, providers: ['other-provider'] },
    ]
    const pluginRegistry: AuthFetchRegistry = {
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
    }

    const registry = await createProviderRegistry(
      settings,
      undefined,
      noopLogger,
      pluginRegistry,
      undefined,
      stubFactory,
    )
    const result = registry.languageModel('auth-provider', 'upstream-model', {})

    // No authFetch for 'auth-provider' since plugin targets 'other-provider'
    expect(result.model).toBeTruthy()
    expect(capturedFactoryInputs[0]!.customFetch).toBeUndefined()
    expect(capturedFactoryInputs[0]!.selectedApiKey).toBe('fallback-key')
  })
})

describe('getPipelinePlugins with model-level plugins', () => {
  it('returns global + provider + model plugins merged with model override', async () => {
    const settings = makeSettings({
      'test-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test',
        headers: {},
        plugins: [{ name: 'vendor_sse_error', config: { maxPreviewEvents: 5 } }],
        models: {
          'model-a': {
            upstreamModel: 'upstream-a',
            aliases: [],
            headers: {},
            plugins: [{ name: 'vendor_sse_error', config: { maxPreviewEvents: 1 } }],
          },
          'model-b': {
            upstreamModel: 'upstream-b',
            aliases: [],
            headers: {},
            plugins: [],
          },
        },
      },
    })
    const registry = await PluginRegistry.fromSettings(settings, '/tmp')
    // model-a: model-level vendor_sse_error should override provider-level
    const pluginsA = registry.getPipelinePlugins('test-provider', 'model-a')
    expect(pluginsA).toHaveLength(1)
    expect(pluginsA[0]!.config).toEqual({ maxPreviewEvents: 1 })
    // model-b: only provider-level plugin
    const pluginsB = registry.getPipelinePlugins('test-provider', 'model-b')
    expect(pluginsB).toHaveLength(1)
    expect(pluginsB[0]!.config).toEqual({ maxPreviewEvents: 5 })
  })

  it('returns provider-level plugins when no modelKey is given', async () => {
    const settings = makeSettings({
      'test-provider': {
        type: 'openai-compatible',
        baseURL: 'https://api.example.com/v1',
        apiKey: 'test',
        headers: {},
        plugins: [{ name: 'vendor_sse_error', config: { maxPreviewEvents: 5 } }],
        models: {
          'model-a': {
            upstreamModel: 'upstream-a',
            aliases: [],
            headers: {},
            plugins: [{ name: 'vendor_sse_error', config: { maxPreviewEvents: 1 } }],
          },
        },
      },
    })
    const registry = await PluginRegistry.fromSettings(settings, '/tmp')
    // Without modelKey, only provider-level plugin
    const plugins = registry.getPipelinePlugins('test-provider')
    expect(plugins).toHaveLength(1)
    expect(plugins[0]!.config).toEqual({ maxPreviewEvents: 5 })
  })

  it('filters global proxy plugins by providers when configured', async () => {
    const settings = makeSettings(
      {
        p1: {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'test',
          headers: {},
          plugins: [],
          models: { m: { upstreamModel: 'm1', aliases: [], headers: {}, plugins: [] } },
        },
        p2: {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'test',
          headers: {},
          plugins: [],
          models: { m: { upstreamModel: 'm2', aliases: [], headers: {}, plugins: [] } },
        },
      },
      {
        plugins: [{ name: 'vendor_sse_error', config: { maxPreviewEvents: 9 }, providers: ['p1'] }],
      },
    )

    const registry = await PluginRegistry.fromSettings(settings, '/tmp')

    expect(registry.getPipelinePlugins('p1', 'm')).toHaveLength(1)
    expect(registry.getPipelinePlugins('p2', 'm')).toHaveLength(0)
  })

  it('applies global proxy plugins to all providers when providers is empty', async () => {
    const settings = makeSettings(
      {
        p1: {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'test',
          headers: {},
          plugins: [],
          models: { m: { upstreamModel: 'm1', aliases: [], headers: {}, plugins: [] } },
        },
        p2: {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'test',
          headers: {},
          plugins: [],
          models: { m: { upstreamModel: 'm2', aliases: [], headers: {}, plugins: [] } },
        },
      },
      { plugins: [{ name: 'vendor_sse_error', config: { maxPreviewEvents: 9 }, providers: [] }] },
    )

    const registry = await PluginRegistry.fromSettings(settings, '/tmp')

    expect(registry.getPipelinePlugins('p1', 'm')).toHaveLength(1)
    expect(registry.getPipelinePlugins('p2', 'm')).toHaveLength(1)
  })
})

describe('auth plugin provider context', () => {
  it('uses the same provider context shape for createFetch and discoverModels', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-plugin-context-'))
    const sink: Array<Record<string, unknown>> = []
    const globals = globalThis as unknown as { __pluginCtxSink?: typeof sink }
    globals.__pluginCtxSink = sink
    try {
      const pluginPath = join(tempDir, 'context-auth.mjs')
      await writeFile(
        pluginPath,
        `export default {
          name: 'context-auth',
          async createFetch(ctx) {
            globalThis.__pluginCtxSink.push({
              hook: 'createFetch',
              id: ctx.id,
              config: ctx.config,
              providerType: ctx.provider.type,
              hasStore: Boolean(ctx.store),
              hasLog: Boolean(ctx.log),
            })
            return (baseFetch) => baseFetch ?? globalThis.fetch
          },
          async discoverModels(ctx) {
            globalThis.__pluginCtxSink.push({
              hook: 'discoverModels',
              id: ctx.id,
              config: ctx.config,
              providerType: ctx.provider.type,
              hasStore: Boolean(ctx.store),
              hasLog: Boolean(ctx.log),
            })
            return { models: [{ id: 'model-a' }] }
          }
        }`,
        'utf8',
      )
      const settings = makeSettings(
        {
          p1: {
            type: 'openai-compatible',
            baseURL: 'https://api.example.com/v1',
            apiKey: 'test',
            headers: {},
            plugins: [],
            models: { m: { upstreamModel: 'm1', aliases: [], headers: {}, plugins: [] } },
          },
        },
        { plugins: [{ module: pluginPath, config: { token: 'cfg' }, providers: ['p1'] }] },
      )
      const registry = await PluginRegistry.fromSettings(settings, tempDir)

      await registry.createAuthFetch('p1', noopLogger, join(tempDir, 'auth.json'))
      await registry.discoverModels('p1', noopLogger, join(tempDir, 'auth.json'))

      expect(sink).toEqual([
        {
          hook: 'createFetch',
          id: 'p1',
          config: { token: 'cfg' },
          providerType: 'openai-compatible',
          hasStore: true,
          hasLog: true,
        },
        {
          hook: 'discoverModels',
          id: 'p1',
          config: { token: 'cfg' },
          providerType: 'openai-compatible',
          hasStore: true,
          hasLog: true,
        },
      ])
    } finally {
      delete globals.__pluginCtxSink
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('plugin lifecycle', () => {
  it('logs init errors with err and does not reject remaining plugin initialization', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-plugin-init-'))
    try {
      const failingPluginPath = join(tempDir, 'failing-init.mjs')
      const healthyPluginPath = join(tempDir, 'healthy-init.mjs')
      await writeFile(
        failingPluginPath,
        `export default {
          name: 'failing-init',
          async init() {
            throw new Error('init boom')
          }
        }`,
        'utf8',
      )
      await writeFile(
        healthyPluginPath,
        `export default {
          name: 'healthy-init',
          async init() {}
        }`,
        'utf8',
      )

      const settings = makeSettings(
        {},
        {
          plugins: [
            { module: failingPluginPath, config: {}, providers: [] },
            { module: healthyPluginPath, config: {}, providers: [] },
          ],
        },
      )
      const registry = await PluginRegistry.fromSettings(settings, tempDir)
      const infoLogs: Array<{ payload: unknown; msg: string | undefined }> = []
      const errorLogs: Array<{ payload: unknown; msg: string | undefined }> = []
      const logger: Logger = {
        info(payload, msg) {
          infoLogs.push({ payload, msg })
        },
        warn() {},
        error(payload, msg) {
          errorLogs.push({ payload, msg })
        },
        fatal() {},
        child() {
          return logger
        },
      }

      await expect(registry.initAll(logger)).resolves.toBeUndefined()

      expect(infoLogs).toContainEqual({
        payload: { plugin: 'healthy-init' },
        msg: 'plugin initialized',
      })
      expect(errorLogs).toHaveLength(1)
      expect(errorLogs[0]?.msg).toBe('plugin init failed')
      expect(errorLogs[0]?.payload).toMatchObject({ err: expect.any(Error) })
      expect((errorLogs[0]?.payload as { err: Error }).err.message).toBe('init boom')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('logs beforeServerStart errors with plugin name and still rejects startup', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-plugin-before-start-'))
    try {
      const failingPluginPath = join(tempDir, 'failing-before.mjs')
      await writeFile(
        failingPluginPath,
        `export default {
          name: 'failing-before',
          async beforeServerStart() {
            throw new Error('before boom')
          }
        }`,
        'utf8',
      )

      const settings = makeSettings(
        {},
        { plugins: [{ module: failingPluginPath, config: {}, providers: [] }] },
      )
      const registry = await PluginRegistry.fromSettings(settings, tempDir)
      const errorLogs: Array<{ payload: unknown; msg: string | undefined }> = []
      const logger: Logger = {
        info() {},
        warn() {},
        error(payload, msg) {
          errorLogs.push({ payload, msg })
        },
        fatal() {},
        child() {
          return logger
        },
      }

      await expect(registry.beforeServerStartAll(logger)).rejects.toThrow('before boom')

      expect(errorLogs).toHaveLength(1)
      expect(errorLogs[0]?.msg).toBe('plugin beforeServerStart failed')
      expect(errorLogs[0]?.payload).toMatchObject({
        err: expect.any(Error),
        plugin: 'failing-before',
      })
      expect((errorLogs[0]?.payload as { err: Error }).err.message).toBe('before boom')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('logs afterServerStart errors with plugin name while other plugins continue', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-plugin-after-start-'))
    try {
      const markerPath = join(tempDir, 'after-start-marker.txt')
      const failingPluginPath = join(tempDir, 'failing-after.mjs')
      const healthyPluginPath = join(tempDir, 'healthy-after.mjs')
      await writeFile(
        failingPluginPath,
        `export default {
          name: 'failing-after',
          async afterServerStart() {
            throw new Error('after boom')
          }
        }`,
        'utf8',
      )
      await writeFile(
        healthyPluginPath,
        `import { appendFile } from 'node:fs/promises'
        export default {
          name: 'healthy-after',
          async afterServerStart() {
            await appendFile(${JSON.stringify(markerPath)}, 'healthy-after\\n', 'utf8')
          }
        }`,
        'utf8',
      )

      const settings = makeSettings(
        {},
        {
          plugins: [
            { module: failingPluginPath, config: {}, providers: [] },
            { module: healthyPluginPath, config: {}, providers: [] },
          ],
        },
      )
      const registry = await PluginRegistry.fromSettings(settings, tempDir)
      const errorLogs: Array<{ payload: unknown; msg: string | undefined }> = []
      const logger: Logger = {
        info() {},
        warn() {},
        error(payload, msg) {
          errorLogs.push({ payload, msg })
        },
        fatal() {},
        child() {
          return logger
        },
      }

      await expect(registry.afterServerStartAll(logger)).resolves.toBeUndefined()

      await expect(readFile(markerPath, 'utf8')).resolves.toBe('healthy-after\n')
      expect(errorLogs).toHaveLength(1)
      expect(errorLogs[0]?.msg).toBe('plugin afterServerStart failed')
      expect(errorLogs[0]?.payload).toMatchObject({
        err: expect.any(Error),
        plugin: 'failing-after',
      })
      expect((errorLogs[0]?.payload as { err: Error }).err.message).toBe('after boom')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
