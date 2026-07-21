import { generateText, type ModelMessage } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() =>
  vi.fn(async () => ({
    statusCode: 202,
    headers: { 'content-type': 'text/plain', 'x-upstream': 'ok' },
    body: 'proxied',
  })),
)

const agentMock = vi.hoisted(() =>
  vi.fn(function Agent(this: { options?: unknown }, options?: unknown) {
    this.options = options
  }),
)
const envHttpProxyAgentMock = vi.hoisted(() =>
  vi.fn(function EnvHttpProxyAgent(this: { options?: unknown }, options?: unknown) {
    this.options = options
  }),
)
vi.mock('undici', () => ({
  Agent: agentMock,
  EnvHttpProxyAgent: envHttpProxyAgentMock,
  request: requestMock,
}))

import {
  applyProviderAuth,
  createDirectFetch,
  createOpenAICompatibleProvider,
  createProxyFetch,
  sanitizeHeaders,
} from '../../src/providers/shared/provider-factory.js'

type RequestMockOptions = {
  method?: string
  body?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
  dispatcher?: unknown
}

function getFirstRequestCall(): [string, RequestMockOptions] {
  expect(requestMock).toHaveBeenCalledTimes(1)
  return requestMock.mock.calls[0] as unknown as [string, RequestMockOptions]
}

function stubBunRuntime(): () => void {
  const original = Object.getOwnPropertyDescriptor(process.versions, 'bun')
  Object.defineProperty(process.versions, 'bun', {
    value: '1.3.14',
    configurable: true,
  })

  return () => {
    if (original) {
      Object.defineProperty(process.versions, 'bun', original)
    } else {
      delete (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun
    }
  }
}

describe('provider fetch adapters', () => {
  beforeEach(() => {
    requestMock.mockClear()
    agentMock.mockClear()
    envHttpProxyAgentMock.mockClear()
    vi.unstubAllGlobals()
  })

  it('preserves Request method, body, headers, and signal through createProxyFetch', async () => {
    const proxyFetch = createProxyFetch('http://127.0.0.1:7890', false)
    const controller = new AbortController()
    const request = new Request('https://api.example.com/v1/chat', {
      method: 'POST',
      headers: { 'X-Original': 'kept' },
      body: 'hello',
      signal: controller.signal,
    })

    const response = await proxyFetch(request)

    expect(response.status).toBe(202)
    expect(await response.text()).toBe('proxied')
    expect(envHttpProxyAgentMock).toHaveBeenCalledWith({
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: '',
      requestTls: { rejectUnauthorized: false },
      allowH2: false,
    })
    expect(requestMock).toHaveBeenCalledTimes(1)
    const [url, options] = getFirstRequestCall()
    expect(url).toBe('https://api.example.com/v1/chat')
    expect(options.method).toBe('POST')
    expect(options.body).toBe(request.body)
    expect(options.signal).toBe(request.signal)
    expect(options.headers).toMatchObject({ 'x-original': 'kept' })
  })

  it('uses an explicit direct dispatcher through createDirectFetch', async () => {
    const directFetch = createDirectFetch()

    const response = await directFetch('https://api.example.com/v1/models')

    expect(response.status).toBe(202)
    expect(agentMock).toHaveBeenCalledTimes(1)
    const [url, options] = getFirstRequestCall()
    expect(url).toBe('https://api.example.com/v1/models')
    expect(options.dispatcher).toBe(agentMock.mock.instances[0])
  })

  it('lets init override Request defaults in createProxyFetch', async () => {
    const proxyFetch = createProxyFetch('http://127.0.0.1:7890', true)
    const request = new Request('https://api.example.com/v1/chat', {
      method: 'POST',
      headers: { 'X-Original': 'request', 'X-Request-Only': 'kept' },
      body: 'request-body',
    })

    await proxyFetch(request, {
      method: 'PUT',
      headers: { 'X-Original': 'init', 'X-Init-Only': 'set' },
      body: 'init-body',
    })

    const [, options] = getFirstRequestCall()
    expect(options.method).toBe('PUT')
    expect(options.body).toBe('init-body')
    expect(options.headers).toMatchObject({
      'x-original': 'init',
      'x-request-only': 'kept',
      'x-init-only': 'set',
    })
  })

  it('uses an empty noProxy dispatcher option so environment NO_PROXY does not bypass configured proxy', async () => {
    const proxyFetch = createProxyFetch('http://127.0.0.1:7890', true)

    await proxyFetch('https://api.example.com/v1/chat')

    expect(envHttpProxyAgentMock).toHaveBeenCalledWith({
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      noProxy: '',
      requestTls: { rejectUnauthorized: true },
      allowH2: false,
    })
  })

  it('uses Bun fetch proxy options in Bun runtime', async () => {
    const restoreBunRuntime = stubBunRuntime()
    const response = new Response('bun-proxied', { status: 203 })
    const bunFetch = vi.fn(async () => response)
    vi.stubGlobal('fetch', bunFetch)

    try {
      const proxyFetch = createProxyFetch('http://127.0.0.1:9000', false)

      const actual = await proxyFetch('http://httpbin.org/anything', {
        headers: { 'x-probe': '1' },
      })

      expect(actual).toBe(response)
      expect(requestMock).not.toHaveBeenCalled()
      expect(bunFetch).toHaveBeenCalledWith(
        'http://httpbin.org/anything',
        expect.objectContaining({
          headers: { 'x-probe': '1' },
          proxy: 'http://127.0.0.1:9000',
          tls: { rejectUnauthorized: false },
        }),
      )
    } finally {
      restoreBunRuntime()
    }
  })
})

describe('provider auth option helpers', () => {
  it('removes sensitive headers case-insensitively', () => {
    expect(
      sanitizeHeaders({
        Authorization: 'Bearer secret',
        'x-api-key': 'secret',
        'X-Keep': 'visible',
      }),
    ).toEqual({ 'X-Keep': 'visible' })
  })

  it('sets selected API key without adding custom fetch', () => {
    const options: { apiKey?: string; fetch?: typeof fetch } = {}

    applyProviderAuth(options, 'sk-selected', undefined, undefined)

    expect(options).toEqual({ apiKey: 'sk-selected' })
  })

  it('composes custom fetch with proxy fetch and uses an OAuth placeholder key', () => {
    const proxyFetch = vi.fn() as unknown as typeof fetch
    const composedFetch = vi.fn() as unknown as typeof fetch
    const customFetch = vi.fn(() => composedFetch)
    const options: { apiKey?: string; fetch?: typeof fetch } = {}

    applyProviderAuth(options, undefined, customFetch, proxyFetch)

    expect(options.apiKey).toBe('oauth-placeholder')
    expect(options.fetch).toBe(composedFetch)
    expect(customFetch).toHaveBeenCalledWith(proxyFetch)
  })
})

describe('openai-compatible provider request mapping', () => {
  it('serializes image detail inside image_url and passes remote URLs through', async () => {
    let capturedBody: Record<string, unknown> | undefined
    const upstreamFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({
          id: 'test-response',
          object: 'chat.completion',
          created: 0,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const provider = createOpenAICompatibleProvider({
      providerName: 'test-provider',
      provider: {
        type: 'openai-compatible',
        baseURL: 'http://127.0.0.1:1/v1',
        headers: {},
        plugins: [],
        models: {},
      },
      modelHeaders: {},
      selectedApiKey: 'test-key',
      customFetch: undefined,
      proxyFetch: upstreamFetch,
    })
    const dataUrl = 'data:image/png;base64,AA=='
    const remoteUrl = new URL('https://example.com/image.png')
    const download = vi.fn(async () => [null])
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          {
            type: 'file',
            mediaType: 'image',
            data: dataUrl,
            providerOptions: {
              openaiCompatible: { imageDetail: 'high' },
            },
          },
          {
            type: 'file',
            mediaType: 'image',
            data: remoteUrl,
            providerOptions: {
              openaiCompatible: { imageDetail: 'auto' },
            },
          },
        ],
      },
    ] satisfies ModelMessage[]

    const result = await generateText({
      model: provider('test-model'),
      messages,
      experimental_download: download,
    })

    expect(result.text).toBe('ok')
    expect(download).toHaveBeenCalledWith([{ url: remoteUrl, isUrlSupportedByModel: true }])
    expect(capturedBody?.['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          {
            type: 'image_url',
            image_url: { url: dataUrl, detail: 'high' },
          },
          {
            type: 'image_url',
            image_url: { url: remoteUrl.toString(), detail: 'auto' },
          },
        ],
      },
    ])
  })
})
