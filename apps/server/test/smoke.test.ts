import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import type { Settings } from '@llm-proxy/core'
import { createProviderRegistry } from '@llm-proxy/core'

const BASE_URL = process.env.LLM_PROXY_TEST_BASE_URL
const API_KEY = process.env.LLM_PROXY_TEST_API_KEY
const MODEL = process.env.LLM_PROXY_TEST_MODEL
const shouldRunSmoke = Boolean(BASE_URL) && Boolean(API_KEY) && Boolean(MODEL)

describe('smoke test (streaming)', () => {
  it.skipIf(!shouldRunSmoke)(
    'proxies a streaming chat completion to the configured external model',
    { timeout: 30_000 },
    async () => {
      const settings: Settings = {
        service: { name: 'llm-proxy', host: '127.0.0.1', port: 8000 },
        requestTimeoutMs: 30000,
        proxy: null,
        routing: { enableFlatModelLookup: false },
        plugins: [],
        providers: {
          smoke: {
            type: 'openai-compatible',
            baseURL: BASE_URL!,
            apiKey: API_KEY!,
            headers: {},
            plugins: [],
            models: {
              chat: {
                upstreamModel: MODEL!,
                aliases: [],
                headers: {},
                plugins: [],
              },
            },
          },
        },
      }
      const providerRegistry = await createProviderRegistry(settings)
      const app = createApp({ settings, providerRegistry })

      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'smoke/chat',
          stream: true,
          messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
        }),
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')

      const body = await response.text()
      // SSE body should contain data: lines
      const dataLines = body.split('\n').filter((l) => l.startsWith('data: '))
      expect(dataLines.length).toBeGreaterThan(0)

      // Last non-[DONE] chunk should be a valid chat completion chunk
      const chunks = dataLines
        .map((l) => l.slice(6)) // strip "data: "
        .filter((d) => d !== '[DONE]')
        .map((d) => JSON.parse(d))

      // Should have at least one content chunk
      const contentChunks = chunks.filter((c: any) => c.choices?.[0]?.delta?.content)
      expect(contentChunks.length).toBeGreaterThan(0)

      // Full assembled content should be non-empty
      const fullContent = contentChunks.map((c: any) => c.choices[0].delta.content).join('')
      expect(fullContent.length).toBeGreaterThan(0)

      // Should end with [DONE]
      expect(body).toContain('data: [DONE]')
    },
  )
})
