import { createProxyFetch } from '../providers/openai/provider.js'
import type { Settings } from '../config.js'
import type { DiscoveredModelList } from '../plugins/types.js'

/** OpenAI /models 端点返回的单个模型对象 */
export interface OpenAIModel {
  id: string
  object: string
  created?: number
  owned_by?: string
}

/** OpenAI /models 端点返回的完整响应 */
export interface OpenAIModelList {
  object: 'list'
  data: OpenAIModel[]
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

/**
 * 从上游 OpenAI-compatible provider 获取可用模型列表。
 * 支持 OAuth token、自定义 headers 和自定义 models 端点。
 */
export async function fetchUpstreamModels({
  baseURL,
  apiKey,
  proxySettings,
  timeoutMs = 15_000,
  modelsEndpoint,
  headers: providerHeaders,
  oauthToken,
}: DiscoverModelsOptions): Promise<OpenAIModel[]> {
  const fetchFn = proxySettings
    ? createProxyFetch(proxySettings.url, proxySettings.verify)
    : globalThis.fetch

  // 1. 铺 provider 级静态 headers
  const headers: Record<string, string> = { ...providerHeaders }

  // 2. 显式鉴权优先于静态 headers 中的 Authorization
  if (oauthToken) {
    headers['Authorization'] = `${oauthToken.tokenType} ${oauthToken.accessToken}`
  } else if (apiKey) {
    const key = Array.isArray(apiKey) ? apiKey[0] : apiKey
    if (key) {
      headers['Authorization'] = `Bearer ${key}`
    }
  }

  const url = resolveModelsUrl(baseURL, modelsEndpoint)
  const response = await fetchFn(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const body = (await response.json()) as OpenAIModelList

  if (!body.data || !Array.isArray(body.data)) {
    throw new Error('Unexpected response format: missing data array')
  }

  return body.data.sort((a, b) => a.id.localeCompare(b.id))
}

/** 将 OpenAI 协议的模型列表转换为内部统一的 DiscoveredModel 格式 */
export function openAIToDiscoveredModels(models: OpenAIModel[]): DiscoveredModelList {
  return {
    models: models.map((m) => ({ id: m.id })),
  }
}
