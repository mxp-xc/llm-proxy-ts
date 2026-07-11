import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../src/index.js'
import { createProviderRegistry } from '../../src/providers/registry.js'
import type { ProviderFactory } from '../../src/providers/registry.js'
import * as providerFactoryModule from '../../src/providers/shared/provider-factory.js'
import { makeSettings } from '../helpers/settings.js'
import { createCapturingLogger } from '../helpers/registry.js'

const { logger: mockLogger, capturedLogs } = createCapturingLogger()

/**
 * Stub factory that captures arguments and returns lightweight model objects,
 * avoiding real AI SDK provider construction.
 *
 * 签名与 `ProviderFactory` 一致（含 `customFetch` / `proxyFetch` 参数），
 * 记录 `proxyFetch` 到 `capturedProxyFetch` 以验证 registry 作用域的共享 fetch
 * 真正透传到 provider 工厂。
 */
const capturedProxyFetch: Array<typeof fetch | undefined> = []
const stubFactory = {
  createOpenAICompatible(
    providerName: string,
    _provider: unknown,
    _modelHeaders: Record<string, string>,
    selectedApiKey: string | undefined,
    _customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
    proxyFetch: typeof fetch | undefined,
  ) {
    capturedProxyFetch.push(proxyFetch)
    return (upstreamModel: string) => ({ upstreamModel, providerName, selectedApiKey })
  },
  createAnthropic(
    providerName: string,
    _provider: unknown,
    _modelHeaders: Record<string, string>,
    selectedApiKey: string | undefined,
    _customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
    proxyFetch: typeof fetch | undefined,
  ) {
    capturedProxyFetch.push(proxyFetch)
    return (upstreamModel: string) => ({ upstreamModel, providerName, selectedApiKey })
  },
  createOpenAI(
    providerName: string,
    _provider: unknown,
    _modelHeaders: Record<string, string>,
    selectedApiKey: string | undefined,
    _customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
    proxyFetch: typeof fetch | undefined,
  ) {
    capturedProxyFetch.push(proxyFetch)
    return (upstreamModel: string) => ({ upstreamModel, providerName, selectedApiKey })
  },
} as unknown as ProviderFactory

const settings = makeSettings(
  {
    openrouter: {
      type: 'openai-compatible',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'secret',
      headers: {
        authorization: 'Bearer wrong',
        'proxy-authorization': 'Basic wrong',
        'x-api-key': 'wrong',
        'api-key': 'wrong',
        apikey: 'wrong',
        api_key: 'wrong',
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
    capturedProxyFetch.length = 0
  })

  it('creates openai-compatible language models and filters auth header overrides', async () => {
    const registry = await createProviderRegistry(
      settings,
      undefined,
      mockLogger,
      undefined,
      undefined,
      stubFactory,
    )
    const result = registry.languageModel('openrouter', 'openrouter/chat', {
      AUTHORIZATION: 'Bearer also-wrong',
      'X-API-Key': 'also-wrong',
    })

    expect(result.model).toBeTruthy()
    expect(registry.debugProviderConfig('openrouter')).toEqual({
      baseURL: 'https://openrouter.ai/api/v1',
      headers: { 'X-Test': 'yes' },
      proxyEnabled: true,
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
})

describe('shared ProxyAgent singleton', () => {
  afterEach(() => {
    capturedProxyFetch.length = 0
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
    expect(capturedProxyFetch).toHaveLength(3)
    expect(capturedProxyFetch.every((f) => f === sharedFetch)).toBe(true)
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
