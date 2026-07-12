import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { Agent, EnvHttpProxyAgent, request } from 'undici'
import type { Dispatcher } from 'undici'
import type { OpenAICompatibleProviderConfig, ProviderConfig } from '../../config.js'

export interface ProviderBuildInput<TProvider extends ProviderConfig = ProviderConfig> {
  providerName: string
  provider: TProvider
  modelHeaders: Record<string, string>
  selectedApiKey: string | undefined
  customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined
  proxyFetch: typeof fetch | undefined
}

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
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
}

export function createOpenAICompatibleProvider(
  input: ProviderBuildInput<OpenAICompatibleProviderConfig>,
) {
  const { providerName, provider, modelHeaders, selectedApiKey, customFetch, proxyFetch } = input
  const headers = sanitizeHeaders({ ...provider.headers, ...modelHeaders })
  const options: Parameters<typeof createOpenAICompatible>[0] = {
    name: providerName,
    baseURL: provider.baseURL,
    headers,
    // 让上游在流式响应中返回 usage（stream_options: { include_usage: true }）
    // 可在 provider 配置中设 includeUsage: false 禁用（适用于不支持 stream_options 的上游）
    includeUsage: provider.options?.includeUsage ?? true,
  }

  applyProviderAuth(options, selectedApiKey, customFetch, proxyFetch)

  return createOpenAICompatible(options)
}

/**
 * Apply provider authentication and fetch composition to SDK provider options.
 * Centralizes the pattern shared by openai, anthropic, and openai-compatible providers:
 * 1. Set apiKey if provided
 * 2. Set oauth-placeholder if customFetch is present but no apiKey (bypasses loadApiKey)
 * 3. Compose customFetch with proxy fetch if applicable
 *
 * `proxyFetch` 是 registry 作用域预构建的共享 transport fetch（per-request 不再 new）；
 * 有代理时由 createProxyFetch 构建，无代理时由 createDirectFetch 构建，避免隐式环境代理。
 */
export function applyProviderAuth(
  options: { apiKey?: string; fetch?: typeof fetch },
  selectedApiKey: string | undefined,
  customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
  proxyFetch: typeof fetch | undefined,
): void {
  if (selectedApiKey !== undefined) {
    options.apiKey = selectedApiKey
  }

  // OAuth/auth-plugin 路径下，customFetch 管理认证，占位 apiKey 仅绕过 loadApiKey()
  if (selectedApiKey === undefined && customFetch) {
    options.apiKey = 'oauth-placeholder'
  }

  if (customFetch) {
    options.fetch = proxyFetch ? customFetch(proxyFetch) : customFetch()
  } else if (proxyFetch) {
    options.fetch = proxyFetch
  }
}

type RequestOptions = NonNullable<Parameters<typeof request>[1]>
type BunRequestInit = RequestInit & {
  proxy?: string
  tls?: {
    rejectUnauthorized?: boolean
  }
}

export function createDirectFetch(): typeof fetch {
  return createUndiciFetch(new Agent())
}

export function createProxyFetch(proxyUrl: string, verify: boolean): typeof fetch {
  if (isBunRuntime()) {
    return createBunProxyFetch(proxyUrl, verify)
  }

  // undici 8 默认 allowH2: true（lib/core/connect.js），经 CONNECT 隧道连 HTTPS 上游会 ALPN 协商 h2。
  // 实测经 HTTP 代理连上游时，大流式响应偶发 NGHTTP2_FLOW_CONTROL_ERROR（ERR_HTTP2_STREAM_ERROR；
  // undici h2 client 走 node:http2 的 ClientHttp2Stream）。强制 HTTP/1.1 规避 HTTP/2 流控问题。
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: proxyUrl,
    httpsProxy: proxyUrl,
    noProxy: '',
    requestTls: { rejectUnauthorized: verify },
    allowH2: false,
  })

  return createUndiciFetch(dispatcher)
}

function isBunRuntime(): boolean {
  return typeof (process.versions as NodeJS.ProcessVersions & { bun?: unknown }).bun === 'string'
}

function createBunProxyFetch(proxyUrl: string, verify: boolean): typeof fetch {
  return async (input, init) => {
    const bunInit = init as BunRequestInit | undefined
    const proxiedInit: BunRequestInit = {
      ...bunInit,
      proxy: proxyUrl,
      tls: {
        ...bunInit?.tls,
        rejectUnauthorized: verify,
      },
    }

    return globalThis.fetch(input, proxiedInit as RequestInit)
  }
}

function getFetchUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

function createUndiciFetch(dispatcher: Dispatcher): typeof fetch {
  return async (input, init) => {
    const requestInput = input instanceof Request ? input : undefined
    const url = getFetchUrl(input)
    const options: RequestOptions = { dispatcher }
    const method = init?.method ?? requestInput?.method
    const body = init?.body ?? requestInput?.body
    const requestHeaders = mergeFetchHeaders(requestInput?.headers, init?.headers)
    const signal = init?.signal ?? requestInput?.signal

    if (method !== undefined) {
      options.method = method
    }

    if (body !== undefined && body !== null) {
      // web BodyInit (ReadableStream, Blob, ArrayBuffer, etc.) 与 undici body
      // (string | Buffer | Uint8Array | Readable | null | FormData) 部分重叠；
      // 实际调用路径由 AI SDK 发起，只会传入重叠范围内的值。
      // 两个 FormData 声明（DOM vs undici）Symbol.toStringTag 不同，需经 unknown 桥接。
      options.body = body as unknown as NonNullable<typeof options.body>
    }

    if (requestHeaders !== undefined) {
      // 将 web HeadersInit (Headers | string[][] | Record<string, string>)
      // 转为 undici 接受的 OutgoingHttpHeaders (Record<string, string | string[] | undefined>)
      options.headers = Object.fromEntries(requestHeaders.entries())
    }

    // 透传 AbortSignal：客户端断开 / 请求超时时中断上游 undici request，
    // 释放 socket、停止上游计费（undici request 原生支持 signal）。
    if (signal !== undefined) {
      options.signal = signal
    }

    const response = await request(url, options)

    // 将 undici headers 转为干净的 Headers 对象：
    // undici 内部 headers 携带 Symbol 键（如 Symbol(sensitiveHeaders)），
    // 直接传给 new Response() 会在迭代时触发 ByteString 转换错误。
    const responseHeaders = new Headers()
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') {
        responseHeaders.append(key, value)
      } else if (Array.isArray(value)) {
        for (const v of value) responseHeaders.append(key, v)
      }
    }

    // undici BodyReadable 是 Node.js Readable 子类，Response 构造函数接受 ReadableStream；
    // 两者不重叠但运行时 Node 会将 Readable 适配为 web ReadableStream。
    return new Response(response.body as unknown as ReadableStream, {
      status: response.statusCode,
      headers: responseHeaders,
    })
  }
}

function mergeFetchHeaders(base?: Headers, override?: HeadersInit): Headers | undefined {
  if (!base && override === undefined) return undefined
  const headers = new Headers(base)
  if (override !== undefined) {
    for (const [key, value] of new Headers(override)) {
      headers.set(key, value)
    }
  }
  return headers
}
