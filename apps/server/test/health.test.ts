import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import type { Settings, ProviderRegistry } from '@llm-proxy/core'

const stubRegistry: ProviderRegistry = {
  languageModel() {
    return { model: {} as never }
  },
  debugProviderConfig() {
    return {} as never
  },
}

describe('health endpoint', () => {
  it('returns local service status without providers', async () => {
    const app = createApp({
      settings: {
        service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
        requestTimeoutMs: 30000,
        proxy: null,
        routing: { enableFlatModelLookup: false },
        plugins: [],
        providers: {},
      },
      providerRegistry: stubRegistry,
    })

    const response = await app.request('/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'llm-proxy',
      providersConfigured: 0,
    })
  })
})
