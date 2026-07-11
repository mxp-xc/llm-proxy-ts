import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { makeSettings } from '../helpers/settings.js'
import type { ProviderRegistry } from '../../src/providers/registry.js'

afterEach(() => vi.unstubAllGlobals())

/** openai 上游 + /v1/responses 走 passthrough 直通转发（绕过 AI SDK）。
 *  验证：请求 body 原始保留（仅替换 model，不丢 instructions/service_tier/client_metadata）、
 *  Authorization 注入后端 key、codex 头透传、响应原样 pipe、后端非 2xx 原生透传。 */
describe('openai provider passthrough /v1/responses', () => {
  function makeRegistry(apiKey: string): ProviderRegistry {
    return {
      languageModel() {
        return { model: {} as never }
      },
      selectApiKey() {
        return { apiKey, keySelection: { index: 0, count: 1 } }
      },
      debugProviderConfig() {
        return {} as never
      },
    }
  }

  function makeOpenaiSettings() {
    return makeSettings({
      openai: {
        type: 'openai',
        baseURL: 'http://mock-upstream/v1',
        apiKey: 'sk-test',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
      },
    })
  }

  it('forwards raw body with model replaced, injects auth, pipes upstream SSE', async () => {
    const settings = makeOpenaiSettings()
    let capturedUrl: string | URL | undefined
    let capturedInit: RequestInit | undefined
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      capturedUrl = input
      capturedInit = init
      const sse = 'data: {"type":"response.created"}\n\ndata: {"type":"response.completed"}\n\n'
      return new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })

    const app = createApp({ settings, providerRegistry: makeRegistry('sk-test') })
    const body = JSON.stringify({
      model: 'openai/chat',
      input: 'hi',
      stream: true,
      instructions: 'system-prompt',
      service_tier: 'default',
      client_metadata: { session_id: 's1' },
    })
    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-codex-turn-metadata': 'meta',
        authorization: 'Bearer not-need',
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(String(capturedUrl)).toBe('http://mock-upstream/v1/responses')

    // model 替换为 upstreamModel；原始字段保留（AI SDK round-trip 会丢这些）
    const forwarded = JSON.parse((capturedInit?.body as string) ?? '{}')
    expect(forwarded.model).toBe('gpt-5')
    expect(forwarded.instructions).toBe('system-prompt')
    expect(forwarded.service_tier).toBe('default')
    expect(forwarded.client_metadata).toEqual({ session_id: 's1' })

    // Authorization 注入后端 key（不透传客户端的 not-need）
    const headers = new Headers(capturedInit?.headers as HeadersInit)
    expect(headers.get('authorization')).toBe('Bearer sk-test')
    // codex 客户端头不透传（上游校验 attestation，codex_exec 无 attestation 会被拒 502）
    expect(headers.get('x-codex-turn-metadata')).toBeNull()
    expect(headers.get('originator')).toBeNull()

    // 响应原样 pipe
    const text = await res.text()
    expect(text).toContain('response.created')
    expect(text).toContain('response.completed')
  })

  it('translates upstream non-2xx to native error status+body', async () => {
    const settings = makeOpenaiSettings()
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { type: 'rate_limit', message: 'too many' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const app = createApp({ settings, providerRegistry: makeRegistry('sk-test') })
    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi', stream: true }),
    })
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.error.type).toBe('rate_limit')
  })
})
