import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { ProxyAgent, request } from 'undici'
import type { OpenAICompatibleProviderConfig } from '../../config.js'

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
  providerName: string,
  provider: OpenAICompatibleProviderConfig,
  modelHeaders: Record<string, string>,
  selectedApiKey: string | undefined,
  customFetch: ((baseFetch?: typeof fetch) => typeof fetch) | undefined,
  proxyFetch: typeof fetch | undefined,
) {
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
 * `proxyFetch` 是 registry 作用域预构建的共享 ProxyAgent fetch（per-request 不再 new）;
 * 由调用方经 createProxyFetch 一次性构建后透传。无代理时传 undefined。
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

export function createProxyFetch(proxyUrl: string, verify: boolean): typeof fetch {
  const dispatcher = new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: verify } })

  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const options: Parameters<typeof request>[1] = { dispatcher }

    if (init?.method !== undefined) {
      options.method = init.method
    }

    if (init?.body !== undefined && init.body !== null) {
      // web BodyInit (ReadableStream, Blob, ArrayBuffer, etc.) 与 undici body
      // (string | Buffer | Uint8Array | Readable | null | FormData) 部分重叠；
      // 实际调用路径由 AI SDK 发起，只会传入重叠范围内的值。
      // 两个 FormData 声明（DOM vs undici）Symbol.toStringTag 不同，需经 unknown 桥接。
      options.body = init.body as unknown as NonNullable<typeof options.body>
    }

    if (init?.headers !== undefined) {
      // 将 web HeadersInit (Headers | string[][] | Record<string, string>)
      // 转为 undici 接受的 OutgoingHttpHeaders (Record<string, string | string[] | undefined>)
      if (init.headers instanceof Headers) {
        options.headers = Object.fromEntries(init.headers.entries())
      } else if (Array.isArray(init.headers)) {
        options.headers = Object.fromEntries(init.headers as [string, string][])
      } else {
        options.headers = init.headers as Record<string, string | string[]>
      }
    }

    const response = await request(url, options)

    // 将 undici headers 转为干净的 Headers 对象：
    // undici 内部 headers 携带 Symbol 键（如 Symbol(sensitiveHeaders)），
    // 直接传给 new Response() 会在迭代时触发 ByteString 转换错误。
    const headers = new Headers()
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') {
        headers.append(key, value)
      } else if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v)
      }
    }

    // undici BodyReadable 是 Node.js Readable 子类，Response 构造函数接受 ReadableStream；
    // 两者不重叠但运行时 Node 会将 Readable 适配为 web ReadableStream。
    return new Response(response.body as unknown as ReadableStream, {
      status: response.statusCode,
      headers,
    })
  }
}
