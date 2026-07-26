import { afterEach, describe, expect, it, vi } from 'vitest'
import { APICallError, generateText, streamText, type LanguageModel } from 'ai'
import type { Settings } from '../../src/index.js'
import type { AuthFetchRegistry } from '../../src/plugins/registry.js'
import { createProviderRegistry } from '../../src/providers/registry.js'
import * as providerFactoryModule from '../../src/providers/shared/provider-factory.js'
import { makeSettings } from '../helpers/settings.js'
import { createCapturingLogger } from '../helpers/registry.js'
import { createCapturingProviderFactory } from '../helpers/provider-factory.js'

function retryableError(): APICallError {
  return new APICallError({
    message: 'temporarily unavailable',
    url: 'https://example.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 503,
    responseHeaders: { 'retry-after-ms': '0' },
  })
}

function successfulResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }
}

function failoverFactory(
  calls: string[],
  behavior: (
    key: string,
    operation: 'generate' | 'stream',
  ) => 'fail' | 'in-band-error' | 'transport-error' | 'error-after-output' | 'success',
) {
  const create = (input: providerFactoryModule.ProviderBuildInput) => (modelId: string) => {
    const key = input.selectedApiKey ?? 'none'
    const model = {
      specificationVersion: 'v4',
      provider: 'test',
      modelId,
      supportedUrls: {},
      async doGenerate() {
        calls.push(key)
        if (behavior(key, 'generate') === 'fail') throw retryableError()
        return successfulResult(key)
      },
      async doStream() {
        calls.push(key)
        const streamBehavior = behavior(key, 'stream')
        if (streamBehavior === 'fail') throw retryableError()
        if (streamBehavior === 'transport-error') {
          let pullCount = 0
          return {
            stream: new ReadableStream(
              {
                pull(controller) {
                  if (pullCount++ === 0) {
                    controller.enqueue({ type: 'stream-start', warnings: [] })
                  } else {
                    controller.error(new TypeError('terminated'))
                  }
                },
              },
              { highWaterMark: 0 },
            ),
          }
        }
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.enqueue({ type: 'text-start', id: 'text-0' })
              if (streamBehavior === 'in-band-error') {
                controller.enqueue({
                  type: 'error',
                  error: {
                    type: 'response.failed',
                    response: {
                      error: {
                        type: 'api_error',
                        code: 'service_unavailable',
                        message: 'Service temporarily unavailable',
                      },
                    },
                  },
                })
                controller.close()
                return
              }
              controller.enqueue({ type: 'text-delta', id: 'text-0', delta: key })
              if (streamBehavior === 'error-after-output') {
                controller.enqueue({ type: 'error', error: 'Service temporarily unavailable' })
                controller.close()
                return
              }
              controller.enqueue({ type: 'text-end', id: 'text-0' })
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop' as const, raw: 'stop' },
                usage: successfulResult(key).usage,
              })
              controller.close()
            },
          }),
        }
      },
    }
    return model as LanguageModel
  }
  return {
    createOpenAICompatible: create,
    createAnthropic: create,
    createOpenAI: create,
  }
}

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

  it('uses the next api key within the existing generate retry budget', async () => {
    const calls: string[] = []
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: ['key-0', 'key-1'],
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      failoverFactory(calls, (key) => (key === 'key-0' ? 'fail' : 'success')),
    )

    const result = registry.languageModel('openrouter', 'openrouter/chat', {})
    const generated = await generateText({ model: result.model, prompt: 'hello' })

    expect(generated.text).toBe('key-1')
    expect(calls).toEqual(['key-0', 'key-1'])
  })

  it('uses the next api key when stream setup fails before output', async () => {
    const calls: string[] = []
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: ['key-0', 'key-1'],
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      failoverFactory(calls, (key) => (key === 'key-0' ? 'fail' : 'success')),
    )

    const result = registry.languageModel('openrouter', 'openrouter/chat', {})
    const streamed = streamText({ model: result.model, prompt: 'hello' })

    await expect(streamed.text).resolves.toBe('key-1')
    expect(calls).toEqual(['key-0', 'key-1'])
  })

  it('uses the next api key for a retryable in-band error before the first delta', async () => {
    const calls: string[] = []
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: ['key-0', 'key-1'],
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      failoverFactory(calls, (key, operation) =>
        operation === 'stream' && key === 'key-0' ? 'in-band-error' : 'success',
      ),
    )

    const result = registry.languageModel('openrouter', 'openrouter/chat', {})
    const streamed = streamText({ model: result.model, prompt: 'hello' })

    await expect(streamed.text).resolves.toBe('key-1')
    expect(calls).toEqual(['key-0', 'key-1'])
  })

  it('does not switch api keys after the first output delta', async () => {
    const calls: string[] = []
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: ['key-0', 'key-1'],
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      failoverFactory(calls, (key, operation) =>
        operation === 'stream' && key === 'key-0' ? 'error-after-output' : 'success',
      ),
    )

    const result = registry.languageModel('openrouter', 'openrouter/chat', {})
    const errors: unknown[] = []
    const streamed = streamText({
      model: result.model,
      prompt: 'hello',
      onError: ({ error }) => {
        errors.push(error)
      },
    })

    for await (const _part of streamed.fullStream) {
      // Consume the stream so the in-band error reaches onError.
    }
    expect(errors).toContain('Service temporarily unavailable')
    expect(calls).toEqual(['key-0'])
  })

  it('does not switch api keys for an explicit non-retryable 4xx stream error', async () => {
    const calls: string[] = []
    const factory = failoverFactory(calls, () => 'success')
    factory.createOpenAICompatible = (input) => (modelId) =>
      ({
        specificationVersion: 'v4',
        provider: 'test',
        modelId,
        supportedUrls: {},
        doGenerate: async () => successfulResult('unused'),
        async doStream() {
          calls.push(input.selectedApiKey ?? 'none')
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] })
                controller.enqueue({
                  type: 'error',
                  error: {
                    statusCode: 400,
                    code: 'invalid_request_error',
                    message: 'upstream request failed validation',
                  },
                })
                controller.close()
              },
            }),
          }
        },
      }) as LanguageModel
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: ['key-0', 'key-1'],
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      factory,
    )

    const result = registry.languageModel('openrouter', 'openrouter/chat', {})
    const streamed = streamText({ model: result.model, prompt: 'hello' })
    for await (const _part of streamed.fullStream) {
      // Consume the stream to run the provider error path.
    }

    expect(calls).toEqual(['key-0'])
  })

  it('does not switch api keys for an ambiguous validation error string', async () => {
    const calls: string[] = []
    const factory = failoverFactory(calls, () => 'success')
    factory.createOpenAICompatible = (input) => (modelId) =>
      ({
        specificationVersion: 'v4',
        provider: 'test',
        modelId,
        supportedUrls: {},
        doGenerate: async () => successfulResult('unused'),
        async doStream() {
          calls.push(input.selectedApiKey ?? 'none')
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'stream-start', warnings: [] })
                controller.enqueue({ type: 'error', error: 'upstream request failed validation' })
                controller.close()
              },
            }),
          }
        },
      }) as LanguageModel
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: ['key-0', 'key-1'],
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      factory,
    )

    const result = registry.languageModel('openrouter', 'openrouter/chat', {})
    const streamed = streamText({ model: result.model, prompt: 'hello' })
    for await (const _part of streamed.fullStream) {
      // Consume the stream to run the provider error path.
    }

    expect(calls).toEqual(['key-0'])
  })

  it('switches api keys for a transport failure before the first output', async () => {
    const calls: string[] = []
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: ['key-0', 'key-1'],
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      failoverFactory(calls, (key, operation) =>
        operation === 'stream' && key === 'key-0' ? 'transport-error' : 'success',
      ),
    )

    const result = registry.languageModel('openrouter', 'openrouter/chat', {})
    const streamed = streamText({ model: result.model, prompt: 'hello' })

    await expect(streamed.text).resolves.toBe('key-1')
    expect(calls).toEqual(['key-0', 'key-1'])
  })

  it('does not multiply the retry budget by the number of api keys', async () => {
    const calls: string[] = []
    const registry = await createProviderRegistry(
      {
        ...settings,
        providers: {
          openrouter: {
            ...settings.providers.openrouter!,
            apiKey: ['key-0', 'key-1', 'key-2'],
          },
        },
      },
      undefined,
      mockLogger,
      undefined,
      undefined,
      failoverFactory(calls, () => 'fail'),
    )

    const result = registry.languageModel('openrouter', 'openrouter/chat', {})

    await expect(generateText({ model: result.model, prompt: 'hello' })).rejects.toThrow()
    expect(calls).toEqual(['key-0', 'key-1', 'key-2'])
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

  it('does not compose auth fetch while creating language model factories', async () => {
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
  })

  it('composes request-scoped fetch inside auth fetch for language models', async () => {
    const calls: string[] = []
    let capturedHeaders: Headers | undefined
    let capturedBody: BodyInit | null | undefined
    const authFetch = ((baseFetch?: typeof fetch) => {
      return async (input, init) => {
        calls.push('auth')
        const headers = new Headers(init?.headers)
        headers.set('x-auth-plugin', 'yes')
        const fetchFn = baseFetch ?? globalThis.fetch
        return fetchFn(input, { ...init, headers })
      }
    }) satisfies (baseFetch?: typeof fetch) => typeof fetch
    const requestFetch = ((baseFetch?: typeof fetch) => {
      return async (input, init) => {
        calls.push('request')
        const headers = new Headers(init?.headers)
        expect(headers.get('x-auth-plugin')).toBe('yes')
        const fetchFn = baseFetch ?? globalThis.fetch
        return fetchFn(input, { ...init, body: 'request-body' })
      }
    }) satisfies (baseFetch?: typeof fetch) => typeof fetch
    const baseFetch = (async (_input, init) => {
      calls.push('base')
      capturedHeaders = new Headers(init?.headers)
      capturedBody = init?.body
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }) satisfies typeof fetch
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

    const first = registry.languageModel(
      'openrouter',
      'openrouter/chat',
      {},
      {
        customFetch: requestFetch,
      },
    )
    const second = registry.languageModel(
      'openrouter',
      'openrouter/chat',
      {},
      {
        customFetch: requestFetch,
      },
    )

    expect(first.keySelection).toEqual({ index: 0, count: 1 })
    expect(second.keySelection).toEqual({ index: 0, count: 1 })
    const composed = capturedFactoryInputs[0]!.customFetch?.(baseFetch)
    await composed?.('https://example.test/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'sdk-body',
    })

    expect(calls).toEqual(['auth', 'request', 'base'])
    expect(capturedHeaders?.get('x-auth-plugin')).toBe('yes')
    expect(capturedBody).toBe('request-body')
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

    const settingsWithoutProxy = makeSettings({
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
      settingsWithoutProxy,
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
