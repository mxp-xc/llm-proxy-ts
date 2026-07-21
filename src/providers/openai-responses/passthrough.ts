import type { ExecutionOverrideInput, ExecutionOverrideConfig } from '../shared/strategy.js'
import { renderOpenAIResponsesRawResponse, renderOpenAIResponsesRawSSE } from './renderer.js'
import {
  patchOpenAIResponsesPassthroughInput,
  sdkInputAlreadyContainsInstructions,
} from './passthrough-input.js'
import type { OpenAIResponse, OpenAIResponseStreamEvent, ResponsesEnrichment } from './types.js'

/** 响应头中需剔除的：content-encoding/length 由 Response 重新计算。 */
const SKIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
])

type FetchWrapper = (baseFetch?: typeof fetch) => typeof fetch
export interface OpenAIResponsesPassthroughFetchState {
  responseHeaders?: Headers
}
export interface OpenAIResponsesRequestBodyMergeOptions {
  restoreFilteredInputItems?: boolean
}
const WEB_SEARCH_RAW_ONLY_FIELDS = ['search_content_types', 'index_gated_web_access'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isResponsesUrl(input: RequestInfo | URL): boolean {
  const url = input instanceof Request ? input.url : input.toString()
  try {
    return new URL(url).pathname.replace(/\/+$/, '').endsWith('/responses')
  } catch {
    return false
  }
}

function patchWebSearchTools(
  sdkTools: unknown,
  rawTools: unknown,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(sdkTools) || !Array.isArray(rawTools)) return undefined

  const rawWebSearchTools = rawTools.filter(
    (tool): tool is Record<string, unknown> => isRecord(tool) && tool.type === 'web_search',
  )
  if (rawWebSearchTools.length === 0) return undefined

  let rawIndex = 0
  let changed = false
  const patchedTools = sdkTools.map((tool) => {
    if (!isRecord(tool) || tool.type !== 'web_search') return tool

    const rawTool = rawWebSearchTools[rawIndex]
    rawIndex += 1
    if (!rawTool) return tool

    const patchedTool: Record<string, unknown> = { ...tool }
    for (const key of WEB_SEARCH_RAW_ONLY_FIELDS) {
      if (key in rawTool && !(key in patchedTool)) {
        patchedTool[key] = rawTool[key]
        changed = true
      }
    }
    return patchedTool
  })

  return changed ? patchedTools : undefined
}

function mergeRequestHeadersForBody(
  headers: HeadersInit | undefined,
  mergedBody: Record<string, unknown>,
): HeadersInit | undefined {
  if (mergedBody.stream !== true) return headers

  const mergedHeaders = new Headers(headers)
  mergedHeaders.set('accept', 'text/event-stream')
  return mergedHeaders
}

export function mergeOpenAIResponsesRequestBody(
  sdkBody: Record<string, unknown>,
  rawBody: unknown,
  options: OpenAIResponsesRequestBodyMergeOptions = {},
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...sdkBody }
  if (!isRecord(rawBody)) return merged

  if (Array.isArray(rawBody.include)) {
    merged.include = rawBody.include
  }

  const patchedTools = patchWebSearchTools(merged.tools, rawBody.tools)
  if (patchedTools !== undefined) {
    merged.tools = patchedTools
  }

  for (const [key, value] of Object.entries(rawBody)) {
    if (
      key === 'instructions' &&
      typeof value === 'string' &&
      sdkInputAlreadyContainsInstructions(merged, value)
    ) {
      continue
    }
    if (!(key in merged)) {
      merged[key] = value
    }
  }
  return patchOpenAIResponsesPassthroughInput(
    merged,
    rawBody,
    options.restoreFilteredInputItems === true,
  )
}

export function createOpenAIResponsesRequestBodyMergeFetch(
  rawBody: unknown,
  state?: OpenAIResponsesPassthroughFetchState,
  options: OpenAIResponsesRequestBodyMergeOptions = {},
): FetchWrapper {
  return (baseFetch) => {
    const fetchFn = baseFetch ?? globalThis.fetch
    return async (input, init) => {
      if (!isResponsesUrl(input)) {
        return fetchFn(input, init)
      }

      const sendResponsesRequest = async (
        requestInput: RequestInfo | URL,
        requestInit: RequestInit | undefined,
      ) => {
        const response = await fetchFn(requestInput, requestInit)
        if (state !== undefined) {
          state.responseHeaders = new Headers(response.headers)
        }
        return response
      }

      const sdkBody = parseJsonObject(init?.body)
      if (!sdkBody) {
        return sendResponsesRequest(input, init)
      }

      const mergedBody = mergeOpenAIResponsesRequestBody(sdkBody, rawBody, options)
      const mergedInit: RequestInit = { ...init, body: JSON.stringify(mergedBody) }
      const mergedHeaders = mergeRequestHeadersForBody(init?.headers, mergedBody)
      if (mergedHeaders !== undefined) mergedInit.headers = mergedHeaders
      return sendResponsesRequest(input, mergedInit)
    }
  }
}

export function filterOpenAIResponsesResponseHeaders(headers: unknown): Headers | undefined {
  if (headers === undefined || headers === null) return undefined
  const source = headers instanceof Headers ? headers : new Headers(headers as HeadersInit)
  const filtered = new Headers()
  for (const [key, value] of source.entries()) {
    if (SKIP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
    filtered.set(key, value)
    if (key.toLowerCase() === 'x-request-id' && !filtered.has('x-upstream-request-id')) {
      filtered.set('x-upstream-request-id', value)
    }
  }
  return filtered
}

export function prepareOpenAIResponsesPassthroughExecution(
  input: ExecutionOverrideInput,
):
  | ExecutionOverrideConfig<OpenAIResponseStreamEvent, OpenAIResponse, ResponsesEnrichment>
  | undefined {
  if (input.providerType !== 'openai') return undefined

  const fetchState: OpenAIResponsesPassthroughFetchState = {}

  return {
    languageModelOptions: {
      customFetch: createOpenAIResponsesRequestBodyMergeFetch(input.rawBody, fetchState, {
        restoreFilteredInputItems: input.rawBodyWasTransformed,
      }),
    },
    generateOptions: {
      include: { requestBody: true, responseBody: true },
    },
    streamOptions: {
      include: { requestBody: true, rawChunks: true },
    },
    renderResult: renderOpenAIResponsesRawResponse,
    renderStreamSSE: renderOpenAIResponsesRawSSE,
    responseHeaders(renderInput) {
      return filterOpenAIResponsesResponseHeaders(
        renderInput.response?.headers ?? fetchState.responseHeaders,
      )
    },
    streamResponseHeaders() {
      return filterOpenAIResponsesResponseHeaders(fetchState.responseHeaders)
    },
  }
}
