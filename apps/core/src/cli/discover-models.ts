import { createProxyFetch } from '../openai-compatible.js';
import type { Settings } from '../config.js';

/** OpenAI /models 端点返回的单个模型对象 */
export interface OpenAIModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

/** OpenAI /models 端点返回的完整响应 */
export interface OpenAIModelList {
  object: 'list';
  data: OpenAIModel[];
}

export interface DiscoverModelsOptions {
  baseURL: string;
  apiKey: string | string[] | null | undefined;
  proxySettings: Settings['proxy'];
  timeoutMs?: number;
}

/**
 * 从上游 OpenAI-compatible provider 获取可用模型列表。
 * 调用 GET {baseURL}/models，复用项目的代理配置。
 */
export async function fetchUpstreamModels({
  baseURL,
  apiKey,
  proxySettings,
  timeoutMs = 15_000,
}: DiscoverModelsOptions): Promise<OpenAIModel[]> {
  const fetchFn = proxySettings
    ? createProxyFetch(proxySettings.url, proxySettings.verify)
    : globalThis.fetch;

  const headers: Record<string, string> = {};
  if (apiKey) {
    const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    if (key) {
      headers['Authorization'] = `Bearer ${key}`;
    }
  }

  const url = `${baseURL.replace(/\/+$/, '')}/models`;
  const response = await fetchFn(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as OpenAIModelList;

  if (!body.data || !Array.isArray(body.data)) {
    throw new Error('Unexpected response format: missing data array');
  }

  return body.data.sort((a, b) => a.id.localeCompare(b.id));
}
