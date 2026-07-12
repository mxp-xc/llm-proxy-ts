import { createDirectFetch, createProxyFetch } from '../../providers/shared/provider-factory.js'
import type { ModelLimit } from '../../providers/model-types.js'
import type { OpenAIProviderConfig, Settings } from '../../config.js'
import type { DiscoveredModelList } from '../../plugins/types.js'

/** 上游 /models 端点返回的单个模型对象（原始格式） */
export interface UpstreamModelResponse {
  id: string
  /** OpenAI 响应有此字段（'model'）；Anthropic /v1/models 响应不返回 */
  object?: string
  created?: number
  owned_by?: string
  /** 上游扩展字段：总上下文窗口长度（如 OpenRouter） */
  context_length?: number
  /** 上游扩展字段：最大输出 token 数（如 OpenRouter） */
  max_output_tokens?: number
}

/** 从上游扩展字段提取模型限制信息 */
export function extractLimit(
  raw: Pick<UpstreamModelResponse, 'context_length' | 'max_output_tokens'>,
): ModelLimit | undefined {
  const contextLength = raw.context_length
  const maxOutputTokens = raw.max_output_tokens
  if (contextLength == null && maxOutputTokens == null) return undefined

  const limit: ModelLimit = {}
  if (contextLength != null) limit.context = contextLength
  if (maxOutputTokens != null) limit.output = maxOutputTokens
  return limit
}

/** 上游 /models 端点返回的完整响应 */
export interface UpstreamModelList {
  object: 'list'
  data: UpstreamModelResponse[]
  /** Anthropic 分页：是否还有更多页（OpenAI 不返回此字段，单页即终） */
  has_more?: boolean
  /** Anthropic 分页：当前页最后一项 id，用作 after_id 游标 */
  last_id?: string | null
}

export interface DiscoverModelsOptions {
  baseURL: string
  apiKey: string | string[] | null | undefined
  proxySettings: Settings['proxy']
  timeoutMs?: number
  /** 自定义 models API 端点：相对路径拼接到 baseURL，或以 http(s):// 开头的完整 URL */
  modelsEndpoint?: string | undefined
  /** provider 级静态 headers，作为请求基础 headers */
  headers?: Record<string, string> | undefined
  /** 已解析的 OAuth token，优先于 apiKey 设置 Authorization */
  oauthToken?: { tokenType: string; accessToken: string } | undefined
  /** 鉴权方案：'bearer'（OpenAI 系，默认）用 Authorization: Bearer；'anthropic' 用 x-api-key + anthropic-version */
  authMode?: 'bearer' | 'anthropic'
  /** anthropic-version header 值，仅 authMode='anthropic' 时生效，默认 '2023-06-01' */
  anthropicVersion?: string | undefined
  /** OpenAI provider options mirrored by the SDK path. */
  openAIOptions?: Pick<NonNullable<OpenAIProviderConfig['options']>, 'organization' | 'project'>
}

/**
 * 解析 models API 的请求 URL。
 *
 * - modelsEndpoint 未设置 → `{baseURL}/models`
 * - 以 `http://` 或 `https://` 开头 → 作为完整 URL 直接使用
 * - 其他 → 作为相对路径拼接到 baseURL 后
 */
export function resolveModelsUrl(baseURL: string, modelsEndpoint?: string): string {
  if (!modelsEndpoint) {
    return `${baseURL.replace(/\/+$/, '')}/models`
  }
  if (/^https?:\/\//i.test(modelsEndpoint)) {
    return modelsEndpoint
  }
  const base = baseURL.replace(/\/+$/, '')
  const path = modelsEndpoint.startsWith('/') ? modelsEndpoint : `/${modelsEndpoint}`
  return `${base}${path}`
}

/** 给 URL 追加查询参数（用于 Anthropic 分页 after_id 游标） */
function withQueryParam(baseUrl: string, key: string, value: string): string {
  const u = new URL(baseUrl)
  u.searchParams.set(key, value)
  return u.toString()
}

/**
 * 从上游 provider 获取可用模型列表（OpenAI 协议 /models 端点）。
 * 支持 OAuth token、自定义 headers、自定义 models 端点，以及 bearer / anthropic 两种鉴权方案。
 */
export async function fetchUpstreamModels({
  baseURL,
  apiKey,
  proxySettings,
  timeoutMs = 15_000,
  modelsEndpoint,
  headers: providerHeaders,
  oauthToken,
  authMode = 'bearer',
  anthropicVersion,
  openAIOptions,
}: DiscoverModelsOptions): Promise<UpstreamModelResponse[]> {
  const fetchFn = proxySettings
    ? createProxyFetch(proxySettings.url, proxySettings.verify)
    : createDirectFetch()

  // 1. 铺 provider 级静态 headers
  const headers: Record<string, string> = { ...providerHeaders }

  // 2. 鉴权：OAuth token 两方案均走 Authorization: Bearer；否则 apiKey 按 authMode 写入
  if (oauthToken) {
    headers['Authorization'] = `${oauthToken.tokenType} ${oauthToken.accessToken}`
  } else if (apiKey) {
    const key = Array.isArray(apiKey) ? apiKey[0] : apiKey
    if (key) {
      if (authMode === 'anthropic') {
        headers['x-api-key'] = key
      } else {
        headers['Authorization'] = `Bearer ${key}`
      }
    }
  }

  // 3. anthropic 方案需要 anthropic-version header
  if (authMode === 'anthropic') {
    headers['anthropic-version'] = anthropicVersion ?? '2023-06-01'
  }
  if (openAIOptions?.organization !== undefined) {
    headers['OpenAI-Organization'] = openAIOptions.organization
  }
  if (openAIOptions?.project !== undefined) {
    headers['OpenAI-Project'] = openAIOptions.project
  }

  // 4. 拉取模型列表；Anthropic /v1/models 用 has_more + last_id 分页，需循环取全（OpenAI 单页即终）
  const baseUrl = resolveModelsUrl(baseURL, modelsEndpoint)
  const collected: UpstreamModelResponse[] = []
  let afterId: string | null = null
  do {
    const url = afterId ? withQueryParam(baseUrl, 'after_id', afterId) : baseUrl
    const response = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    const body = (await response.json()) as UpstreamModelList

    if (!body.data || !Array.isArray(body.data)) {
      throw new Error('Unexpected response format: missing data array')
    }

    collected.push(...body.data)
    afterId = body.has_more ? (body.last_id ?? null) : null
  } while (afterId)

  return collected.sort((a, b) => a.id.localeCompare(b.id))
}

/** 将 OpenAI 协议的模型列表转换为内部统一的 DiscoveredModel 格式 */
export function openAIToDiscoveredModels(models: UpstreamModelResponse[]): DiscoveredModelList {
  return {
    models: models.map((m) => {
      const limit = extractLimit(m)
      return limit ? { id: m.id, limit } : { id: m.id }
    }),
  }
}
