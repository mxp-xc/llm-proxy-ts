import { sanitizeHeaders, createProxyFetch } from '../shared/provider-factory.js'
import { openAIErrorFormat } from '../shared/error-format.js'
import { withRequestTimeout, RequestTimeoutError } from '../../server/stream-utils.js'
import type { Settings } from '../../config.js'
import type { PassthroughInput } from '../shared/strategy.js'
import type { OpenAIResponsesRequest } from './protocol.js'

/** 响应头中需剔除的：content-encoding/length 由 Response 重新计算，
 *  透传会导致客户端重复解压或长度不匹配。 */
const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
])

/** settings.proxy 不可变（无 hot-reload），module-level 缓存 ProxyAgent fetch，
 *  避免 per-request new ProxyAgent。 */
const proxyFetchCache = new Map<string, typeof fetch>()

function getPassthroughFetch(settings: Settings): typeof fetch {
  if (!settings.proxy) return globalThis.fetch
  const key = `${settings.proxy.url}|${settings.proxy.verify}`
  let fetchFn = proxyFetchCache.get(key)
  if (!fetchFn) {
    fetchFn = createProxyFetch(settings.proxy.url, settings.proxy.verify)
    proxyFetchCache.set(key, fetchFn)
  }
  return fetchFn
}

/**
 * 构造上游请求头：仅 content-type + accept + provider/model 配置头 + Authorization。
 *
 * **不透传客户端（codex）请求头**（originator、user-agent、x-codex-*、x-oai-attestation、
 * session-id、thread-id 等）：上游后端会校验 codex 客户端头（attestation），
 * codex CLI（codex_exec）不生成 attestation，透传这些头会被上游拒绝（502）。
 * 这与 AI SDK 路径行为一致（AI SDK 仅发 provider 配置头 + Authorization），
 * 也与脚本直连后端的原生基准一致（脚本不带 codex 客户端头）。
 */
function buildUpstreamHeaders(
  routeHeaders: Record<string, string>,
  apiKey: string | undefined,
  isStream: boolean,
): Headers {
  const headers = new Headers()
  headers.set('content-type', 'application/json')
  if (isStream) headers.set('accept', 'text/event-stream')
  // provider/model 配置头（sanitize 去敏感：authorization/api-key 等）
  for (const [key, value] of Object.entries(sanitizeHeaders(routeHeaders))) {
    headers.set(key, value)
  }
  // authorization：后端真实 key（不透传客户端的 "Bearer not-need"）
  if (apiKey !== undefined) {
    headers.set('authorization', `Bearer ${apiKey}`)
  }
  return headers
}

function filterResponseHeaders(headers: Headers): Headers {
  const filtered = new Headers()
  for (const [key, value] of headers.entries()) {
    if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
    filtered.set(key, value)
  }
  return filtered
}

/** 日志安全 URL：保留 protocol://host/path，剥离可能的 query 敏感参数。 */
function safeUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return url
  }
}

/**
 * openai-responses + openai 上游 passthrough 直通转发：
 * 请求原始 JSON（仅替换 model + Authorization）直接 POST 到 {baseURL}/responses，
 * 响应 SSE/JSON 直接 pipe，绕过 AI SDK 序列化/解析，实现出入参字节级一致。
 *
 * 非 openai 上游（openai-compatible/anthropic）返回 undefined，回退 AI SDK 矩阵转换路径。
 * 后端非 2xx：原生错误格式透传（status + body），客户端拿到与直连一致的错误。
 */
export async function passthroughOpenAIResponses(
  input: PassthroughInput<OpenAIResponsesRequest>,
): Promise<Response | undefined> {
  const { c, route, rawBody, upstreamModel, settings, selectApiKey, abortController } = input

  if (route.provider.type !== 'openai') return undefined

  const provider = route.provider
  const baseURL = provider.baseURL ?? 'https://api.openai.com/v1'
  const url = `${baseURL.replace(/\/+$/, '')}/responses`

  // body：原始 JSON 副本，仅替换 model。保留 instructions/service_tier/client_metadata
  // 及 input 子项原貌（schema 虽 passthrough，但子 schema 会 strip；故必须用原始 body）。
  const bodyObj =
    rawBody != null && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {}
  const body = JSON.stringify({ ...bodyObj, model: upstreamModel })

  const { apiKey, keySelection } = selectApiKey(route.providerName)
  if (keySelection) c.set('keySelection', keySelection)

  const headers = buildUpstreamHeaders(route.headers, apiKey, input.request.stream ?? false)
  const fetchFn = getPassthroughFetch(settings)
  const logger = c.get('logger')

  try {
    const upstream = await withRequestTimeout(
      fetchFn(url, {
        method: 'POST',
        headers,
        body,
        signal: abortController.signal,
      }),
      settings.requestTimeoutMs,
      abortController,
    )

    // 后端非 2xx：原生错误格式透传（status + body），codex 拿到与直连一致的错误
    if (!upstream.ok) {
      const errBody = await upstream.text()
      logger.error(
        {
          status: upstream.status,
          provider: route.providerName,
          url: safeUrl(url),
          errBody: errBody.slice(0, 1000),
        },
        'passthrough upstream non-2xx',
      )
      return new Response(errBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: filterResponseHeaders(upstream.headers),
      })
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: filterResponseHeaders(upstream.headers),
    })
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      const { body: errBody, status } = openAIErrorFormat.timeout()
      return c.json(errBody, status as 504)
    }
    logger.error(
      { err: error, provider: route.providerName, url: safeUrl(url) },
      'passthrough fetch failed',
    )
    const { body: errBody, status } = openAIErrorFormat.upstream()
    return c.json(errBody, status as 502)
  }
}
