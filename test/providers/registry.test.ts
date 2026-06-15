import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Settings, Logger } from '../../src/index.js'
import { createProviderRegistry } from '../../src/providers/registry.js'

const capturedLogs: unknown[] = []

const mockLogger: Logger = {
  info(payload: unknown) {
    capturedLogs.push(payload)
  },
  warn() {},
  error() {},
  fatal() {},
  child() {
    return mockLogger
  },
}

vi.mock('../../src/providers/shared/provider-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/providers/shared/provider-factory.js')>()
  return {
    ...original,
    createOpenAICompatibleProvider(
      providerName: string,
      provider: unknown,
      settings: unknown,
      modelHeaders: unknown,
      selectedApiKey: string | undefined,
    ) {
      return (upstreamModel: string) => ({ upstreamModel, providerName, selectedApiKey })
    },
    sanitizeHeaders(headers: Record<string, string>) {
      const sensitiveHeaders = new Set([
        'authorization',
        'proxy-authorization',
        'x-api-key',
        'api-key',
        'apikey',
        'api_key',
      ])
      return Object.fromEntries(
        Object.entries(headers).filter(([key]) => !sensitiveHeaders.has(key.toLowerCase())),
      )
    },
  }
})

const settings: Settings = {
  service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
  requestTimeoutMs: 30000,
  proxy: { url: 'http://127.0.0.1:7890', verify: false },
  routing: { enableFlatModelLookup: false },
  plugins: [],
  providers: {
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
}

describe('provider registry', () => {
  afterEach(() => {
    capturedLogs.length = 0
  })

  it('creates openai-compatible language models and filters auth header overrides', async () => {
    const registry = await createProviderRegistry(settings, undefined, mockLogger)
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
    )

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
    )

    const result = registry.languageModel('openrouter', 'openrouter/chat', {})
    expect(result.keySelection).toBeUndefined()
  })
})
