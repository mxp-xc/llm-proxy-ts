import type { ExecutionOverrideInput, ExecutionOverrideConfig } from '../shared/strategy.js'
import {
  ADDITIONAL_TOOLS_ANCHOR_PREFIX,
  AGENT_MESSAGE_ANCHOR_PREFIX,
  type OpenAIResponsesRequest,
} from './protocol.js'
import type { OpenAIResponse, OpenAIResponseStreamEvent, ResponsesEnrichment } from './types.js'
import { renderOpenAIResponsesRawResponse, renderOpenAIResponsesRawSSE } from './renderer.js'

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

function contentIncludesText(content: unknown, text: string): boolean {
  if (typeof content === 'string') return content.includes(text)
  if (Array.isArray(content)) return content.some((part) => contentIncludesText(part, text))
  if (!isRecord(content)) return false

  if (typeof content.text === 'string' && content.text.includes(text)) return true
  if ('content' in content) return contentIncludesText(content.content, text)
  return false
}

function sdkInputAlreadyContainsInstructions(
  sdkBody: Record<string, unknown>,
  instructions: string,
): boolean {
  const input = sdkBody.input
  if (!Array.isArray(input)) return false

  return input.some((item) => {
    if (!isRecord(item)) return false
    const role = item.role
    if (role !== 'developer' && role !== 'system') return false
    return contentIncludesText(item.content, instructions)
  })
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

function isInputItemAnchor(item: unknown, prefix: string): boolean {
  if (
    !isRecord(item) ||
    item.type !== 'message' ||
    item.role !== 'assistant' ||
    item.phase !== 'commentary'
  ) {
    return false
  }
  if (!Array.isArray(item.content) || item.content.length !== 1) {
    return false
  }

  const content = item.content[0]
  if (!isRecord(content) || content.type !== 'output_text' || typeof content.text !== 'string') {
    return false
  }
  const marker = content.text.slice(prefix.length)
  return (
    content.text.startsWith(prefix) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker)
  )
}

function isAdditionalToolsAnchor(item: unknown): boolean {
  return isInputItemAnchor(item, ADDITIONAL_TOOLS_ANCHOR_PREFIX)
}

function isAgentMessageAnchor(item: unknown): boolean {
  return isInputItemAnchor(item, AGENT_MESSAGE_ANCHOR_PREFIX)
}

function restoreMessageItemType(item: unknown): unknown {
  if (!isRecord(item) || 'type' in item || !('content' in item)) return item
  if (
    item.role !== 'system' &&
    item.role !== 'developer' &&
    item.role !== 'user' &&
    item.role !== 'assistant'
  ) {
    return item
  }
  return { type: 'message', ...item }
}

function restoreMessageItemTypes(body: Record<string, unknown>): Record<string, unknown> {
  const input = body.input
  if (!Array.isArray(input)) return body

  let changed = false
  const restoredInput = input.map((item) => {
    const restored = restoreMessageItemType(item)
    if (restored !== item) changed = true
    return restored
  })
  return changed ? { ...body, input: restoredInput } : body
}

function patchAgentMessagesInput(
  sdkBody: Record<string, unknown>,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  const rawInput = rawBody.input
  if (!Array.isArray(rawInput)) return sdkBody

  const rawAgentMessages = rawInput.filter(
    (item): item is Record<string, unknown> => isRecord(item) && item.type === 'agent_message',
  )
  if (rawAgentMessages.length === 0) return sdkBody

  const sdkInput = sdkBody.input
  if (!Array.isArray(sdkInput)) {
    throw new Error('Cannot align agent_message with non-array SDK input')
  }

  const nativeAgentMessageCount = sdkInput.filter(
    (item) => isRecord(item) && item.type === 'agent_message',
  ).length
  if (nativeAgentMessageCount > 0) {
    if (nativeAgentMessageCount !== rawAgentMessages.length) {
      throw new Error(
        `Cannot align agent_message with SDK input: expected ${rawAgentMessages.length} native items, found ${nativeAgentMessageCount}`,
      )
    }
    let agentMessageIndex = 0
    const patchedInput: unknown[] = []
    for (const item of sdkInput) {
      if (isAgentMessageAnchor(item)) continue
      if (isRecord(item) && item.type === 'agent_message') {
        patchedInput.push(rawAgentMessages[agentMessageIndex++])
        continue
      }
      patchedInput.push(item)
    }
    return { ...sdkBody, input: patchedInput }
  }

  const anchorCount = sdkInput.filter(isAgentMessageAnchor).length
  if (anchorCount !== rawAgentMessages.length) {
    throw new Error(
      `Cannot align agent_message with SDK input: expected ${rawAgentMessages.length} anchors, found ${anchorCount}`,
    )
  }

  let agentMessageIndex = 0
  return {
    ...sdkBody,
    input: sdkInput.map((item) =>
      isAgentMessageAnchor(item) ? rawAgentMessages[agentMessageIndex++] : item,
    ),
  }
}

function patchAdditionalToolsInput(
  sdkBody: Record<string, unknown>,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  const rawInput = rawBody.input
  if (!Array.isArray(rawInput)) return sdkBody
  if (!rawInput.some((item) => isRecord(item) && item.type === 'additional_tools')) {
    return sdkBody
  }

  const sdkInput = sdkBody.input
  if (!Array.isArray(sdkInput)) {
    throw new Error('Cannot align additional_tools with non-array SDK input')
  }
  if (sdkInput.some((item) => isRecord(item) && item.type === 'additional_tools')) {
    if (!sdkInput.some(isAdditionalToolsAnchor)) return sdkBody
    return { ...sdkBody, input: sdkInput.filter((item) => !isAdditionalToolsAnchor(item)) }
  }

  const rawAdditionalTools = rawInput.filter(
    (item): item is Record<string, unknown> => isRecord(item) && item.type === 'additional_tools',
  )
  const anchorCount = sdkInput.filter(isAdditionalToolsAnchor).length
  let patchedInput: unknown[]
  if (anchorCount > 0) {
    if (anchorCount !== rawAdditionalTools.length) {
      throw new Error('Cannot align additional_tools with SDK input: anchor count mismatch')
    }
    let additionalIndex = 0
    patchedInput = sdkInput.map((item) =>
      isAdditionalToolsAnchor(item) ? rawAdditionalTools[additionalIndex++] : item,
    )
  } else {
    patchedInput = []
    let sdkIndex = 0
    for (const rawItem of rawInput) {
      if (isRecord(rawItem) && rawItem.type === 'additional_tools') {
        patchedInput.push(rawItem)
        continue
      }
      if (isRecord(rawItem) && rawItem.type === 'web_search_call') continue
      if (sdkIndex >= sdkInput.length) {
        throw new Error('Cannot align additional_tools with SDK input: missing SDK item')
      }
      patchedInput.push(sdkInput[sdkIndex])
      sdkIndex += 1
    }
    if (sdkIndex !== sdkInput.length) {
      throw new Error('Cannot align additional_tools with SDK input: unused SDK items')
    }
  }

  const patched: Record<string, unknown> = {
    ...sdkBody,
    input: patchedInput,
  }
  if (Array.isArray(rawBody.tools)) patched.tools = rawBody.tools
  else delete patched.tools
  return patched
}

export function mergeOpenAIResponsesRequestBody(
  sdkBody: Record<string, unknown>,
  rawBody: unknown,
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
  const restoredMessages = restoreMessageItemTypes(merged)
  const patchedAgentMessages = patchAgentMessagesInput(restoredMessages, rawBody)
  return patchAdditionalToolsInput(patchedAgentMessages, rawBody)
}

export function createOpenAIResponsesRequestBodyMergeFetch(
  rawBody: unknown,
  state?: OpenAIResponsesPassthroughFetchState,
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

      const mergedBody = mergeOpenAIResponsesRequestBody(sdkBody, rawBody)
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
      customFetch: createOpenAIResponsesRequestBodyMergeFetch(input.rawBody, fetchState),
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
