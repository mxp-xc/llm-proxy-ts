import { beforeEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() =>
  vi.fn(async () => ({
    statusCode: 202,
    headers: { 'content-type': 'text/plain', 'x-upstream': 'ok' },
    body: 'proxied',
  })),
)

const proxyAgentMock = vi.hoisted(() =>
  vi.fn(function ProxyAgent(this: { options?: unknown }, options: unknown) {
    this.options = options
  }),
)

vi.mock('undici', () => ({
  ProxyAgent: proxyAgentMock,
  request: requestMock,
}))

import {
  applyProviderAuth,
  createProxyFetch,
  sanitizeHeaders,
} from '../../src/providers/shared/provider-factory.js'

type RequestMockOptions = {
  method?: string
  body?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
}

function getFirstRequestCall(): [string, RequestMockOptions] {
  expect(requestMock).toHaveBeenCalledTimes(1)
  return requestMock.mock.calls[0] as unknown as [string, RequestMockOptions]
}

describe('provider fetch adapters', () => {
  beforeEach(() => {
    requestMock.mockClear()
    proxyAgentMock.mockClear()
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
    expect(proxyAgentMock).toHaveBeenCalledWith({
      uri: 'http://127.0.0.1:7890',
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
