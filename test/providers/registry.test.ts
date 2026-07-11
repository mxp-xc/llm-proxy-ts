import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../src/index.js'
import type { AuthFetchRegistry } from '../../src/plugins/registry.js'
import { createProviderRegistry } from '../../src/providers/registry.js'
import * as providerFactoryModule from '../../src/providers/shared/provider-factory.js'
import { makeSettings } from '../helpers/settings.js'
import { createCapturingLogger } from '../helpers/registry.js'
import { createCapturingProviderFactory } from '../helpers/provider-factory.js'

const { logger: mockLogger, capturedLogs } = createCapturingLogger()
const { factory: stubFactory, inputs: capturedFactoryInputs } = createCapturingProviderFactory()

const settings = makeSettings(
  {
    openrouter: {
      type: 'openai-compatible',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'secret',
      headers: {
        'X-Test': 'yes',
      },
      plugins: [],
      models: { chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] } },
    },
  },
  { proxy: { url: 'http://127.0.0.1:7890', verify: false } },
)

describe('provider registry', () => {
  afterEach(() => {
    capturedLogs.length = 0
    capturedFactoryInputs.length = 0
  })

  it('creates openai-compatible language models through the provider factory', async () => {
    const registry = await createProviderRegistry(
      settings,
      undefined,
      mockLogger,
      undefined,
      undefined,
      stubFactory,
    )
    const result = registry.languageModel('openrouter', 'openrouter/chat', {
      'X-Request': 'yes',
    })

    expect(result.model).toBeTruthy()
    expect(capturedFactoryInputs[0]).toMatchObject({
      providerName: 'openrouter',
      modelHeaders: { 'X-Request': 'yes' },
      selectedApiKey: 'secret',
    })
  })

  it('rotates api key arrays per provider across requests', async () => {
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: ['secret-token-1', 'secret-token-2'],
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      stubFactory,
    )
    // createProviderRegistry 启动时发 proxy configured 日志，与 key-selection 日志无关，清空后只校验后者
    capturedLogs.length = 0

    const r1 = registry.languageModel('openrouter', 'openrouter/chat', {})
    const r2 = registry.languageModel('openrouter', 'openrouter/chat', {})
    const r3 = registry.languageModel('openrouter', 'openrouter/chat', {})

    expect(r1.keySelection).toEqual({ index: 0, count: 2 })
    expect(r2.keySelection).toEqual({ index: 1, count: 2 })
    expect(r3.keySelection).toEqual({ index: 0, count: 2 })
    // registry should NOT emit separate key-selection logs
    expect(capturedLogs).toEqual([])
  })

  it('does not log api keys', async () => {
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: ['key-1', '12345678'],
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      stubFactory,
    )

    const r1 = registry.languageModel('openrouter', 'openrouter/chat', {})
    const r2 = registry.languageModel('openrouter', 'openrouter/chat', {})

    expect(r1.keySelection).toEqual({ index: 0, count: 2 })
    expect(r2.keySelection).toEqual({ index: 1, count: 2 })
    // No logs should contain the actual key values
    const logs = JSON.stringify(capturedLogs)
    expect(logs).not.toContain('key-1')
    expect(logs).not.toContain('12345678')
  })

  it('does not return keySelection for unkeyed providers', async () => {
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: null,
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      stubFactory,
    )

    const result = registry.languageModel('openrouter', 'openrouter/chat', {})
    expect(result.keySelection).toBeUndefined()
  })

  it.each(['openai-compatible' as const, 'anthropic' as const, 'openai' as const])(
    'dispatches %s providers to the matching factory adapter',
    async (providerType) => {
      const provider =
        providerType === 'openai'
          ? {
              type: 'openai' as const,
              apiKey: 'secret',
              headers: {},
              plugins: [],
              models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
            }
          : providerType === 'anthropic'
            ? {
                type: 'anthropic' as const,
                baseURL: 'https://api.anthropic.com/v1',
                apiKey: 'secret',
                headers: {},
                plugins: [],
                models: {
                  chat: {
                    upstreamModel: 'claude-sonnet-4-5',
                    aliases: [],
                    headers: {},
                    plugins: [],
                  },
                },
              }
            : {
                type: 'openai-compatible' as const,
                baseURL: 'https://api.example.com/v1',
                apiKey: 'secret',
                headers: {},
                plugins: [],
                models: { chat: { upstreamModel: 'model', aliases: [], headers: {}, plugins: [] } },
              }
      const registry = await createProviderRegistry(
        makeSettings({ provider }),
        undefined,
        mockLogger,
        undefined,
        undefined,
        stubFactory,
      )

      registry.languageModel('provider', provider.models.chat!.upstreamModel, {})

      expect(capturedFactoryInputs[0]!.kind).toBe(providerType)
    },
  )

  it('does not compose auth fetch until the passthrough transport seam needs fetch', async () => {
    let composeCalls = 0
    const authFetch = ((baseFetch?: typeof fetch) => {
      composeCalls += 1
      return baseFetch ?? globalThis.fetch
    }) satisfies (baseFetch?: typeof fetch) => typeof fetch
    const pluginRegistry: AuthFetchRegistry = {
      async createAuthFetch(providerId) {
        return providerId === 'openrouter' ? authFetch : undefined
      },
    }
    const registry = await createProviderRegistry(
      settings,
      undefined,
      mockLogger,
      pluginRegistry,
      undefined,
      stubFactory,
    )

    registry.languageModel('openrouter', 'openrouter/chat', {})

    expect(composeCalls).toBe(0)
    expect(capturedFactoryInputs[0]!.customFetch).toBe(authFetch)

    const transport = registry.passthroughTransport('openrouter')

    expect(composeCalls).toBe(1)
    expect(transport.fetch).toBeDefined()
    expect(transport.apiKey).toBe('secret')
  })
})

describe('shared ProxyAgent singleton', () => {
  afterEach(() => {
    capturedFactoryInputs.length = 0
    vi.restoreAllMocks()
  })

  it('createProxyFetch is called once at registry scope, shared across multiple languageModel calls', async () => {
    // settings 已配置 proxy(见上方 settings);spy createProxyFetch 验证 registry 作用域只调用一次。
    const sharedFetch = (() => Promise.resolve(new Response())) as typeof fetch
    const createProxyFetchSpy = vi
      .spyOn(providerFactoryModule, 'createProxyFetch')
      .mockReturnValue(sharedFetch)

    // createProviderRegistry 内部调用 createProxyFetch 一次构建 sharedProxyFetch
    const registry = await createProviderRegistry(
      settings,
      undefined,
      mockLogger,
      undefined,
      undefined,
      stubFactory,
    )

    // 多次 languageModel 调用,不应再触发 createProxyFetch
    registry.languageModel('openrouter', 'openrouter/chat', {})
    registry.languageModel('openrouter', 'openrouter/chat', {})
    registry.languageModel('openrouter', 'openrouter/chat', {})

    expect(createProxyFetchSpy).toHaveBeenCalledTimes(1)
    expect(createProxyFetchSpy).toHaveBeenCalledWith('http://127.0.0.1:7890', false)
    // sharedProxyFetch 真正透传到 provider 工厂：每次 languageModel 都注入同一引用
    expect(capturedFactoryInputs).toHaveLength(3)
    expect(capturedFactoryInputs.every((input) => input.proxyFetch === sharedFetch)).toBe(true)
  })

  it('createProxyFetch is not called when no proxy is configured', async () => {
    const createProxyFetchSpy = vi
      .spyOn(providerFactoryModule, 'createProxyFetch')
      .mockReturnValue((() => Promise.resolve(new Response())) as typeof fetch)

    const noProxySettings = makeSettings({
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: {
          chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] },
        },
      },
    })

    const registry = await createProviderRegistry(
      noProxySettings,
      undefined,
      mockLogger,
      undefined,
      undefined,
      stubFactory,
    )
    registry.languageModel('openrouter', 'openrouter/chat', {})

    expect(createProxyFetchSpy).not.toHaveBeenCalled()
  })
})
