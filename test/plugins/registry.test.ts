import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Settings } from '../../src/index.js'
import {
  PluginHookError,
  type ResolvedPlugin,
  type AuthPlugin,
  type ProxyPlugin,
} from '../../src/plugins/types.js'
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

  it('wraps auth hook failures with plugin, provider, hook, and cause', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-plugin-hook-error-'))
    try {
      const pluginPath = join(tempDir, 'failing-auth.mjs')
      await writeFile(
        pluginPath,
        `export default {
          name: 'failing-auth',
          async createFetch() {
            throw new Error('create fetch boom')
          },
          async discoverModels() {
            throw new Error('discover models boom')
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
            models: {},
          },
        },
        { plugins: [{ module: pluginPath, config: {}, providers: ['p1'] }] },
      )
      const registry = await PluginRegistry.fromSettings(settings, tempDir)

      for (const [hook, call] of [
        ['createFetch', () => registry.createAuthFetch('p1', noopLogger)],
        ['discoverModels', () => registry.discoverModels('p1', noopLogger)],
      ] as const) {
        try {
          await call()
          expect.unreachable(`${hook} should have thrown`)
        } catch (error) {
          expect(error).toBeInstanceOf(PluginHookError)
          expect(error).toMatchObject({
            plugin: 'failing-auth',
            provider: 'p1',
            hook,
            cause: expect.any(Error),
          })
        }
      }
    } finally {
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
      expect(errorLogs[0]?.payload).toMatchObject({ plugin: 'failing-init' })
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

  it('excludes a failed plugin instance from every later hook across scopes', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-plugin-unavailable-'))
    const calls: string[] = []
    const globals = globalThis as unknown as { __pluginUnavailableCalls?: string[] }
    globals.__pluginUnavailableCalls = calls
    try {
      const proxyPluginPath = join(tempDir, 'failing-proxy.mjs')
      const authPluginPath = join(tempDir, 'failing-auth.mjs')
      await writeFile(
        proxyPluginPath,
        `export default {
          name: 'failing-proxy',
          async init() {
            globalThis.__pluginUnavailableCalls.push('proxy:init')
            throw new Error('proxy init boom')
          },
          async beforeServerStart() {
            globalThis.__pluginUnavailableCalls.push('proxy:before')
          },
          async afterServerStart() {
            globalThis.__pluginUnavailableCalls.push('proxy:after')
          },
          async inspectStreamChunk() {
            globalThis.__pluginUnavailableCalls.push('proxy:pipeline')
          },
          async dispose() {
            globalThis.__pluginUnavailableCalls.push('proxy:dispose')
          }
        }`,
        'utf8',
      )
      await writeFile(
        authPluginPath,
        `export default {
          name: 'failing-auth',
          async init() {
            globalThis.__pluginUnavailableCalls.push('auth:init')
            throw new Error('auth init boom')
          },
          async createFetch() {
            globalThis.__pluginUnavailableCalls.push('auth:createFetch')
            return (baseFetch) => baseFetch ?? globalThis.fetch
          },
          async discoverModels() {
            globalThis.__pluginUnavailableCalls.push('auth:discoverModels')
            return { models: [] }
          },
          async dispose() {
            globalThis.__pluginUnavailableCalls.push('auth:dispose')
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
            plugins: [{ module: proxyPluginPath, config: {} }],
            models: {
              m1: {
                upstreamModel: 'm1',
                aliases: [],
                headers: {},
                plugins: [{ module: proxyPluginPath, config: {} }],
              },
            },
          },
        },
        {
          plugins: [
            { module: proxyPluginPath, config: {}, providers: ['p1'] },
            { module: authPluginPath, config: {}, providers: ['p1'] },
          ],
        },
      )
      const registry = await PluginRegistry.fromSettings(settings, tempDir)
      const errors: Array<{ payload: unknown; message?: string }> = []
      const logger: Logger = {
        info() {},
        warn() {},
        error(payload, message) {
          errors.push({ payload, ...(message === undefined ? {} : { message }) })
        },
        fatal() {},
        child() {
          return logger
        },
      }

      await registry.initAll(logger)
      await registry.beforeServerStartAll(logger)
      await registry.afterServerStartAll(logger)

      expect(registry.getPipelinePlugins('p1', 'm1')).toEqual([])
      await expect(registry.createAuthFetch('p1', logger)).resolves.toBeUndefined()
      await expect(registry.discoverModels('p1', logger)).resolves.toBeUndefined()
      await registry.disposeAll(logger)

      expect(calls).toEqual(['proxy:init', 'auth:init', 'auth:dispose', 'proxy:dispose'])
      expect(errors).toHaveLength(2)
      for (const entry of errors) {
        expect(entry.message).toBe('plugin init failed')
        expect(entry.payload).toMatchObject({ err: expect.any(Error), plugin: expect.any(String) })
        expect((entry.payload as { err: Error }).err.stack).toBeTruthy()
      }
    } finally {
      delete globals.__pluginUnavailableCalls
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps a plugin without init available and disposes it once', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-plugin-no-init-'))
    const calls: string[] = []
    const globals = globalThis as unknown as { __pluginNoInitCalls?: string[] }
    globals.__pluginNoInitCalls = calls
    try {
      const pluginPath = join(tempDir, 'no-init.mjs')
      await writeFile(
        pluginPath,
        `export default {
          name: 'no-init',
          async beforeServerStart() {
            globalThis.__pluginNoInitCalls.push('before')
          },
          async afterServerStart() {
            globalThis.__pluginNoInitCalls.push('after')
          },
          async inspectStreamChunk() {
            globalThis.__pluginNoInitCalls.push('pipeline')
          },
          async createFetch() {
            globalThis.__pluginNoInitCalls.push('createFetch')
            return (baseFetch) => baseFetch ?? globalThis.fetch
          },
          async discoverModels() {
            globalThis.__pluginNoInitCalls.push('discoverModels')
            return { models: [{ id: 'm1' }] }
          },
          async dispose() {
            globalThis.__pluginNoInitCalls.push('dispose')
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
            models: { m1: { upstreamModel: 'm1', aliases: [], headers: {}, plugins: [] } },
          },
        },
        { plugins: [{ module: pluginPath, config: {}, providers: ['p1'] }] },
      )
      const registry = await PluginRegistry.fromSettings(settings, tempDir)

      await registry.initAll(noopLogger)
      await registry.beforeServerStartAll(noopLogger)
      await registry.afterServerStartAll(noopLogger)
      const pipeline = registry.getPipelinePlugins('p1', 'm1')
      expect(pipeline).toHaveLength(1)
      await (pipeline[0]!.plugin as ProxyPlugin).inspectStreamChunk?.({
        requestId: 'request-1',
        settings,
        provider: { id: 'p1', provider: settings.providers.p1! },
        config: pipeline[0]!.config,
        chunk: {},
      })
      await registry.createAuthFetch('p1', noopLogger)
      await expect(registry.discoverModels('p1', noopLogger)).resolves.toEqual({
        models: [{ id: 'm1' }],
      })
      await registry.disposeAll(noopLogger)
      await registry.disposeAll(noopLogger)

      expect(() => registry.initAll(noopLogger)).toThrow('plugin registry is disposed')
      await expect(registry.beforeServerStartAll(noopLogger)).rejects.toThrow(
        'plugin registry is disposed',
      )
      await expect(registry.afterServerStartAll(noopLogger)).rejects.toThrow(
        'plugin registry is disposed',
      )
      await expect(registry.createAuthFetch('p1', noopLogger)).rejects.toThrow(
        'plugin registry is disposed',
      )
      await expect(registry.discoverModels('p1', noopLogger)).rejects.toThrow(
        'plugin registry is disposed',
      )
      expect(() => registry.getPipelinePlugins('p1', 'm1')).toThrow('plugin registry is disposed')

      expect(calls).toEqual([
        'before',
        'after',
        'pipeline',
        'createFetch',
        'discoverModels',
        'dispose',
      ])
    } finally {
      delete globals.__pluginNoInitCalls
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('disposes plugin instances once in reverse order and aggregates failures', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-plugin-dispose-'))
    const calls: string[] = []
    const globals = globalThis as unknown as { __pluginDisposeCalls?: string[] }
    globals.__pluginDisposeCalls = calls
    try {
      const pluginPaths: string[] = []
      for (const name of ['first', 'second', 'third']) {
        const pluginPath = join(tempDir, `${name}.mjs`)
        pluginPaths.push(pluginPath)
        await writeFile(
          pluginPath,
          `export default {
            name: '${name}',
            async init() {
              globalThis.__pluginDisposeCalls.push('init:${name}')
            },
            async dispose() {
              globalThis.__pluginDisposeCalls.push('dispose:${name}')
              ${name !== 'third' ? `throw new Error('dispose ${name} boom')` : ''}
            }
          }`,
          'utf8',
        )
      }
      const settings = makeSettings(
        {},
        {
          plugins: pluginPaths.map((module) => ({ module, config: {}, providers: [] })),
        },
      )
      const registry = await PluginRegistry.fromSettings(settings, tempDir)
      const errors: Array<{ payload: unknown; message?: string }> = []
      const logger: Logger = {
        info() {},
        warn() {},
        error(payload, message) {
          errors.push({ payload, ...(message === undefined ? {} : { message }) })
        },
        fatal() {},
        child() {
          return logger
        },
      }

      await registry.initAll(logger)
      let disposeError: unknown
      try {
        await registry.disposeAll(logger)
      } catch (err) {
        disposeError = err
      }
      await expect(registry.disposeAll(logger)).rejects.toBe(disposeError)
      expect(() => registry.initAll(logger)).toThrow('plugin registry is disposed')

      expect(calls).toEqual([
        'init:first',
        'init:second',
        'init:third',
        'dispose:third',
        'dispose:second',
        'dispose:first',
      ])
      expect(disposeError).toBeInstanceOf(AggregateError)
      expect((disposeError as AggregateError).errors).toEqual([
        expect.objectContaining({ message: 'dispose second boom' }),
        expect.objectContaining({ message: 'dispose first boom' }),
      ])
      expect(errors).toHaveLength(2)
      expect(
        errors.map(({ message, payload }) => ({
          message,
          plugin: (payload as { plugin: string }).plugin,
          error: (payload as { err: Error }).err.message,
        })),
      ).toEqual([
        { message: 'plugin dispose failed', plugin: 'second', error: 'dispose second boom' },
        { message: 'plugin dispose failed', plugin: 'first', error: 'dispose first boom' },
      ])
      for (const entry of errors) {
        expect((entry.payload as { err: Error }).err.stack).toBeTruthy()
      }
    } finally {
      delete globals.__pluginDisposeCalls
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('deduplicates concurrent init and blocks hooks while dispose waits for init', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-plugin-init-dispose-race-'))
    const calls: string[] = []
    let markInitStarted!: () => void
    const initStarted = new Promise<void>((resolve) => {
      markInitStarted = resolve
    })
    const globals = globalThis as unknown as {
      __pluginRaceCalls?: string[]
      __pluginRaceInitStarted?: () => void
      __finishPluginRaceInit?: () => void
    }
    globals.__pluginRaceCalls = calls
    globals.__pluginRaceInitStarted = markInitStarted
    try {
      const pluginPath = join(tempDir, 'race.mjs')
      await writeFile(
        pluginPath,
        `export default {
          name: 'race',
          async init() {
            globalThis.__pluginRaceCalls.push('init:start')
            globalThis.__pluginRaceInitStarted()
            await new Promise((resolve) => {
              globalThis.__finishPluginRaceInit = resolve
            })
            globalThis.__pluginRaceCalls.push('init:end')
          },
          async beforeServerStart() {
            globalThis.__pluginRaceCalls.push('before')
          },
          async dispose() {
            globalThis.__pluginRaceCalls.push('dispose')
          }
        }`,
        'utf8',
      )
      const settings = makeSettings(
        {},
        { plugins: [{ module: pluginPath, config: {}, providers: [] }] },
      )
      const registry = await PluginRegistry.fromSettings(settings, tempDir)

      const firstInit = registry.initAll(noopLogger)
      const secondInit = registry.initAll(noopLogger)
      expect(secondInit).toBe(firstInit)
      await initStarted

      const dispose = registry.disposeAll(noopLogger)
      expect(() => registry.initAll(noopLogger)).toThrow('plugin registry is disposing')
      await expect(registry.beforeServerStartAll(noopLogger)).rejects.toThrow(
        'plugin registry is disposing',
      )
      expect(calls).toEqual(['init:start'])

      globals.__finishPluginRaceInit?.()
      await Promise.all([firstInit, dispose])

      expect(calls).toEqual(['init:start', 'init:end', 'dispose'])
    } finally {
      globals.__finishPluginRaceInit?.()
      delete globals.__pluginRaceCalls
      delete globals.__pluginRaceInitStarted
      delete globals.__finishPluginRaceInit
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('passes the abort signal to dispose, stops the reverse chain, and observes late rejection', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-plugin-dispose-abort-'))
    const calls: string[] = []
    let markDisposeStarted!: () => void
    const disposeStarted = new Promise<void>((resolve) => {
      markDisposeStarted = resolve
    })
    const globals = globalThis as unknown as {
      __pluginAbortCalls?: string[]
      __pluginAbortSignal?: AbortSignal
      __pluginAbortDisposeStarted?: () => void
      __rejectPluginAbortDispose?: (reason: unknown) => void
    }
    globals.__pluginAbortCalls = calls
    globals.__pluginAbortDisposeStarted = markDisposeStarted
    try {
      const firstPluginPath = join(tempDir, 'first.mjs')
      const hangingPluginPath = join(tempDir, 'hanging.mjs')
      await writeFile(
        firstPluginPath,
        `export default {
          name: 'first',
          async dispose() {
            globalThis.__pluginAbortCalls.push('dispose:first')
          }
        }`,
        'utf8',
      )
      await writeFile(
        hangingPluginPath,
        `export default {
          name: 'hanging',
          async dispose(signal) {
            globalThis.__pluginAbortCalls.push('dispose:hanging')
            globalThis.__pluginAbortSignal = signal
            globalThis.__pluginAbortDisposeStarted()
            await new Promise((_resolve, reject) => {
              globalThis.__rejectPluginAbortDispose = reject
            })
          }
        }`,
        'utf8',
      )
      const settings = makeSettings(
        {},
        {
          plugins: [
            { module: firstPluginPath, config: {}, providers: [] },
            { module: hangingPluginPath, config: {}, providers: [] },
          ],
        },
      )
      const registry = await PluginRegistry.fromSettings(settings, tempDir)
      await registry.initAll(noopLogger)
      const errors: Array<{ payload: unknown; message?: string }> = []
      const logger: Logger = {
        info() {},
        warn() {},
        error(payload, message) {
          errors.push({ payload, ...(message === undefined ? {} : { message }) })
        },
        fatal() {},
        child() {
          return logger
        },
      }
      const abortController = new AbortController()

      const dispose = registry.disposeAll(logger, abortController.signal)
      await disposeStarted
      const abortReason = new Error('dispose deadline reached')
      abortController.abort(abortReason)

      await expect(dispose).rejects.toMatchObject({
        errors: expect.arrayContaining([abortReason]),
      })
      expect(globals.__pluginAbortSignal).toBe(abortController.signal)
      expect(calls).toEqual(['dispose:hanging'])

      const lateError = new Error('late dispose failure')
      globals.__rejectPluginAbortDispose?.(lateError)
      await Promise.resolve()
      await Promise.resolve()
      expect(errors).toContainEqual(
        expect.objectContaining({
          payload: { err: lateError, plugin: 'hanging' },
          message: 'plugin dispose failed',
        }),
      )
      expect(() => registry.getPipelinePlugins('missing')).toThrow('plugin registry is disposed')
    } finally {
      globals.__rejectPluginAbortDispose?.(new Error('test cleanup'))
      delete globals.__pluginAbortCalls
      delete globals.__pluginAbortSignal
      delete globals.__pluginAbortDisposeStarted
      delete globals.__rejectPluginAbortDispose
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
