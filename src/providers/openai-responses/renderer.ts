import { randomUUID } from 'node:crypto'
import { toErrorMessage } from '../protocol-types.js'
import { extractUsageFromFinishPart, hasUsageData } from '../shared/renderer-utils.js'
import type { ProviderMetadata } from 'ai'
import type { SSEOutput } from '../shared/sse-utils.js'
import type { FinishReason, RenderResultInput, NamespaceFlatMap } from '../protocol-types.js'
import type { ProxyStreamPart } from '../shared/aisdk-types.js'
import type {
  ResponseOutputText,
  ResponseOutputMessage,
  ResponseCustomToolCall,
  ResponseWebSearchCall,
  ResponseWebSearchAction,
  ResponseToolSearchCall,
  ResponseReasoningItem,
  ResponseOutputItem,
  ResponseUsage,
  OpenAIResponse,
  OpenAIResponseStreamEvent,
} from './types.js'
import type { ResponsesEnrichment } from './types.js'

export type {
  ResponseOutputText,
  ResponseOutputMessage,
  ResponseFunctionToolCall,
  ResponseCustomToolCall,
  ResponseWebSearchCall,
  ResponseToolSearchCall,
  ResponseReasoningItem,
  ResponseOutputItem,
  ResponseUsage,
  OpenAIResponse,
} from './types.js'

// ─── Status Mapping ───────────────────────────────────────────

function mapResponseStatus(finishReason?: FinishReason): 'completed' | 'incomplete' {
  if (finishReason === 'length' || finishReason === 'content-filter') {
    return 'incomplete'
  }
  return 'completed'
}

/** 判别 custom tool（apply_patch 等 freeform grammar tool）：
 *  优先看请求侧声明的 custom tool name 集合（type:'custom'）；
 *  回退到 toolName === 'apply_patch'（防御：无集合时仍识别 Codex 的 apply_patch）。
 *  AI SDK @3.0.71 不提供 toolCallType 信号，故靠请求侧声明的 name 集合判别。 */
function isCustomToolName(toolName: string, customToolNames?: Set<string>): boolean {
  if (customToolNames?.has(toolName)) return true
  return toolName === 'apply_patch'
}

/** 判别 hosted tool（web_search 等）：AI SDK 把上游 web_search_call 映射成 tool-call(providerExecuted:true)。
 *  providerExecuted 是 hosted tool 的决定性标志（function/custom tool 的 tool-call 不带此字段）。 */
function isHostedToolCall(part: { providerExecuted?: boolean }): boolean {
  return part.providerExecuted === true
}

function isToolSearchShimmed(toolName: string, shimmed: boolean | undefined): boolean {
  return shimmed === true && toolName === 'tool_search'
}

/** 把 GLM 返回的拍平 toolName 拆回 codex 期望的 {name, namespace}。
 *  命中 namespaceFlatMap 且 entry.namespace 非 undefined → 拆回；否则原样（普通工具）。
 *  注意：custom_tool_call（apply_patch）与 tool_search_call 走各自的 isCustom/isTsShimmed 分支，
 *  不进此函数——apply_patch namespace=None 无需拆回，tool_search 是 hosted 不在 flatMap。 */
function resolveNamespacedToolName(
  toolName: string,
  namespaceFlatMap: NamespaceFlatMap | undefined,
  providerMetadata: ProviderMetadata | undefined,
  passthrough?: boolean,
): { name: string; namespace?: string } {
  // openai 上游：namespace 由 SDK 放在 tool-call/done part 的 providerMetadata.openai.namespace。
  // 但 tool-input-start（output_item.added）阶段 providerMetadata 无 namespace（AI SDK v4 设计），
  // 需从请求侧 flatMap 反查补 namespace，使 added 就带 namespace（与原生一致）。
  if (passthrough) {
    const ns = (providerMetadata?.openai as { namespace?: string } | undefined)?.namespace
    if (ns != null) return { name: toolName, namespace: ns }
    if (namespaceFlatMap) {
      for (const entry of namespaceFlatMap.values()) {
        if (entry.name === toolName && entry.namespace !== undefined) {
          return { name: toolName, namespace: entry.namespace }
        }
      }
    }
    return { name: toolName }
  }
  // 非 openai 上游：从请求侧构建的 flatMap 反查拍平 toolName
  const entry = namespaceFlatMap?.get(toolName)
  if (entry && entry.namespace !== undefined) {
    return { name: entry.name, namespace: entry.namespace }
  }
  return { name: toolName }
}

/** 把 AI SDK tool-result.output 还原成 Codex 期望的 web_search_call.action。
 *  AI SDK mapWebSearchOutput 把上游 snake_case action.type 转成 camelCase
 *  （open_page→openPage、find_in_page→findInPage；search 不变），Codex 期望 snake_case，这里转回。 */
function mapWebSearchAction(output: unknown): ResponseWebSearchAction | null {
  if (!output || typeof output !== 'object') return null
  const o = output as {
    action?: { type?: string; query?: string; queries?: string[]; url?: string; pattern?: string }
  }
  const a = o.action
  if (!a || typeof a.type !== 'string') return null
  const actionType: ResponseWebSearchAction['type'] =
    a.type === 'openPage'
      ? 'open_page'
      : a.type === 'findInPage'
        ? 'find_in_page'
        : a.type === 'search'
          ? 'search'
          : (a.type as ResponseWebSearchAction['type'])
  const action: ResponseWebSearchAction = { type: actionType }
  if (a.query !== undefined) action.query = a.query
  if (a.queries !== undefined) action.queries = a.queries
  if (a.url !== undefined) action.url = a.url
  if (a.pattern !== undefined) action.pattern = a.pattern
  return action
}

/** JSON.parse 包装：解析失败时原样返回字符串。用于还原 shimmed function 的 arguments。 */
function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 还原 custom_tool_call 的 input：shimmed apply_patch 的 arguments 被 AI SDK 解析成
 * 对象 {input: patchText}（也可能传 JSON 字符串）。统一提取 .input 还原为裸 patch 文本。 */
function decodeCustomToolInput(raw: unknown): string {
  const obj: unknown = typeof raw === 'string' ? tryParseJson(raw) : raw
  if (typeof obj === 'string') return obj
  if (obj != null && typeof obj === 'object' && 'input' in obj) {
    const inputVal = (obj as { input: unknown }).input
    return typeof inputVal === 'string' ? inputVal : JSON.stringify(inputVal ?? '')
  }
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
}

/** 还原 tool_search_call 的 arguments：shimmed tool_search 的 arguments 被 AI SDK 解析成
 * 对象 {query, limit}（也可能传 JSON 字符串）。Codex 期望 arguments 是对象，非 JSON 字符串。 */
function decodeToolSearchInput(raw: unknown): Record<string, unknown> {
  const obj: unknown = typeof raw === 'string' ? tryParseJson(raw) : raw
  if (obj != null && typeof obj === 'object' && !Array.isArray(obj)) {
    return obj as Record<string, unknown>
  }
  return {}
}

// ─── Streaming SSE Renderer ───────────────────────────────────

export async function* renderOpenAIResponseSSE(
  input: {
    model: string
    stream: AsyncIterable<ProxyStreamPart>
  } & ResponsesEnrichment,
): AsyncIterable<SSEOutput<OpenAIResponseStreamEvent>> {
  const responseId = `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  let currentMsgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

  function newMsgId(): string {
    currentMsgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    return currentMsgId
  }

  let sequenceNumber = 0
  let fullText = ''
  let currentText = ''
  let nextOutputIndex = 0
  let currentOutputIndex: number | undefined
  let responseStarted = false
  let textItemStarted = false
  let reasoningItemStarted = false
  let fullReasoning = ''
  let reasoningItemId = ''
  let reasoningEncryptedContent: string | undefined
  const completedOutput: Array<ResponseOutputItem | undefined> = []

  const toolCallFcIds = new Map<string, string>()
  const toolCallToolNames = new Map<string, string>()
  const toolCallOutputIndices = new Map<string, number>()
  const toolCallsWithArgumentDeltas = new Set<string>()
  const toolCallStartEmitted = new Set<string>()
  const hostedToolCallIds = new Set<string>()
  const customToolNames = input.customToolNames
  const customToolShimmed = input.customToolShimmed
  const toolSearchShimmed = input.toolSearchShimmed
  const namespaceFlatMap = input.namespaceFlatMap
  const namespacePassthrough = input.namespacePassthrough

  function nextSeq(): number {
    return ++sequenceNumber
  }

  function reserveOutputIndex(): number {
    const outputIndex = nextOutputIndex
    nextOutputIndex++
    return outputIndex
  }

  function failedResponse(error: unknown): OpenAIResponse {
    return {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: input.model,
      status: 'failed',
      output: [],
      output_text: '',
      error: { message: toErrorMessage(error) },
      instructions: null,
      temperature: null,
      top_p: null,
      tool_choice: null,
      tools: [],
      parallel_tool_calls: true,
      truncation: 'disabled',
    }
  }

  function* emitFailedResponse(error: unknown): Generator<SSEOutput<OpenAIResponseStreamEvent>> {
    yield {
      event: 'response.failed',
      data: {
        type: 'response.failed',
        sequence_number: nextSeq(),
        response: failedResponse(error),
      },
    }
  }

  /** Close the in-progress text message item and retain it at its reserved output index. */
  function* closeCurrentTextMessage(): Generator<SSEOutput<OpenAIResponseStreamEvent>> {
    if (!textItemStarted) return
    const outputIndex = currentOutputIndex!
    yield {
      event: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        sequence_number: nextSeq(),
        item_id: currentMsgId,
        output_index: outputIndex,
        content_index: 0,
        text: currentText,
      },
    }
    yield {
      event: 'response.content_part.done',
      data: {
        type: 'response.content_part.done',
        sequence_number: nextSeq(),
        item_id: currentMsgId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: currentText, annotations: [] },
      },
    }
    const message: ResponseOutputMessage = {
      id: currentMsgId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: currentText, annotations: [] }],
    }
    yield {
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item: message,
      },
    }
    completedOutput[outputIndex] = message
    textItemStarted = false
    currentText = ''
    currentOutputIndex = undefined
  }

  function* startReasoningItem(): Generator<SSEOutput<OpenAIResponseStreamEvent>> {
    if (reasoningItemStarted) return
    yield* closeCurrentTextMessage()
    reasoningItemStarted = true
    currentOutputIndex = reserveOutputIndex()
    reasoningItemId = `rs_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    yield {
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        sequence_number: nextSeq(),
        output_index: currentOutputIndex,
        item: { id: reasoningItemId, type: 'reasoning', summary: [] },
      },
    }
  }

  function* finishReasoningItem(): Generator<SSEOutput<OpenAIResponseStreamEvent>> {
    if (!reasoningItemStarted) return
    const outputIndex = currentOutputIndex!
    const reasoningItem: ResponseReasoningItem = {
      id: reasoningItemId,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: fullReasoning }],
      ...(reasoningEncryptedContent ? { encrypted_content: reasoningEncryptedContent } : {}),
    }
    yield {
      event: 'response.reasoning_summary_text.done',
      data: {
        type: 'response.reasoning_summary_text.done',
        sequence_number: nextSeq(),
        item_id: reasoningItemId,
        output_index: outputIndex,
        text: fullReasoning,
      },
    }
    yield {
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        sequence_number: nextSeq(),
        output_index: outputIndex,
        item: reasoningItem,
      },
    }
    completedOutput[outputIndex] = reasoningItem
    reasoningItemStarted = false
    fullReasoning = ''
    reasoningEncryptedContent = undefined
    currentOutputIndex = undefined
  }

  try {
    for await (const part of input.stream) {
      // Start response on first part
      if (!responseStarted) {
        responseStarted = true
        yield {
          event: 'response.created',
          data: {
            type: 'response.created',
            sequence_number: nextSeq(),
            response: {
              id: responseId,
              object: 'response',
              created_at: Math.floor(Date.now() / 1000),
              model: input.model,
              status: 'in_progress',
              output: [],
            },
          },
        }
        yield {
          event: 'response.in_progress',
          data: {
            type: 'response.in_progress',
            sequence_number: nextSeq(),
            response: { id: responseId, object: 'response', status: 'in_progress', output: [] },
          },
        }
      }

      if (part.type === 'text-delta') {
        const delta = part.text

        if (!textItemStarted) {
          textItemStarted = true
          currentOutputIndex = reserveOutputIndex()
          const msgId = newMsgId()
          yield {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              sequence_number: nextSeq(),
              output_index: currentOutputIndex,
              item: {
                id: msgId,
                type: 'message',
                status: 'in_progress',
                role: 'assistant',
                content: [],
              },
            },
          }
          yield {
            event: 'response.content_part.added',
            data: {
              type: 'response.content_part.added',
              sequence_number: nextSeq(),
              item_id: msgId,
              output_index: currentOutputIndex,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] },
            },
          }
        }

        fullText += delta
        currentText += delta
        yield {
          event: 'response.output_text.delta',
          data: {
            type: 'response.output_text.delta',
            sequence_number: nextSeq(),
            item_id: currentMsgId,
            output_index: currentOutputIndex!,
            content_index: 0,
            delta,
          },
        }
      }

      if (part.type === 'reasoning-start') {
        const enc = part.providerMetadata?.openai?.reasoningEncryptedContent
        if (typeof enc === 'string') reasoningEncryptedContent = enc
        yield* startReasoningItem()
      }

      if (part.type === 'reasoning-delta') {
        const delta = part.text
        const enc = part.providerMetadata?.openai?.reasoningEncryptedContent
        if (typeof enc === 'string') reasoningEncryptedContent = enc

        yield* startReasoningItem()

        fullReasoning += delta
        yield {
          event: 'response.reasoning_summary_text.delta',
          data: {
            type: 'response.reasoning_summary_text.delta',
            sequence_number: nextSeq(),
            item_id: reasoningItemId,
            output_index: currentOutputIndex!,
            delta,
          },
        }
      }

      if (part.type === 'reasoning-end') {
        if (reasoningItemStarted) {
          const enc = part.providerMetadata?.openai?.reasoningEncryptedContent
          if (typeof enc === 'string') reasoningEncryptedContent = enc
        }
        yield* finishReasoningItem()
      }

      if (part.type === 'tool-input-start') {
        const toolCallId = part.id
        const toolName = part.toolName
        yield* closeCurrentTextMessage()

        const outputIndex = reserveOutputIndex()
        toolCallOutputIndices.set(toolCallId, outputIndex)
        if (isHostedToolCall(part)) {
          hostedToolCallIds.add(toolCallId)
          yield {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              sequence_number: nextSeq(),
              output_index: outputIndex,
              item: {
                id: toolCallId,
                type: 'web_search_call',
                status: 'in_progress',
                action: null,
              },
            },
          }
          toolCallStartEmitted.add(toolCallId)
          continue
        }
        const fcId = `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        toolCallFcIds.set(toolCallId, fcId)
        toolCallToolNames.set(toolCallId, toolName)

        const isCustom = isCustomToolName(toolName, customToolNames)
        const isTsShimmed = isToolSearchShimmed(toolName, toolSearchShimmed)
        const nsResolved = resolveNamespacedToolName(
          toolName,
          namespaceFlatMap,
          part.providerMetadata,
          namespacePassthrough,
        )
        const addedItem = isCustom
          ? {
              id: fcId,
              type: 'custom_tool_call' as const,
              status: 'in_progress' as const,
              call_id: toolCallId,
              name: toolName,
              input: '',
            }
          : isTsShimmed
            ? {
                id: fcId,
                type: 'tool_search_call' as const,
                status: 'in_progress' as const,
                call_id: toolCallId,
                execution: 'client' as const,
                arguments: {},
              }
            : {
                id: fcId,
                type: 'function_call' as const,
                status: 'in_progress' as const,
                call_id: toolCallId,
                ...nsResolved,
                arguments: '',
              }
        yield {
          event: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: addedItem,
          },
        }
        toolCallStartEmitted.add(toolCallId)
      }

      if (part.type === 'tool-input-delta') {
        const toolCallId = part.id
        const argsDelta = part.delta
        if (toolCallId != null && hostedToolCallIds.has(toolCallId)) continue
        if (toolCallId == null || argsDelta == null) continue

        const toolName = toolCallToolNames.get(toolCallId) ?? ''
        if (customToolShimmed && isCustomToolName(toolName, customToolNames)) continue
        if (toolSearchShimmed && isToolSearchShimmed(toolName, toolSearchShimmed)) continue

        toolCallsWithArgumentDeltas.add(toolCallId)
        const fcId =
          toolCallFcIds.get(toolCallId) ?? `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const outputIndex = toolCallOutputIndices.get(toolCallId)
        if (outputIndex === undefined) continue

        if (isCustomToolName(toolName, customToolNames)) {
          yield {
            event: 'response.custom_tool_call_input.delta',
            data: {
              type: 'response.custom_tool_call_input.delta',
              sequence_number: nextSeq(),
              item_id: fcId,
              output_index: outputIndex,
              delta: argsDelta,
            },
          }
        } else {
          yield {
            event: 'response.function_call_arguments.delta',
            data: {
              type: 'response.function_call_arguments.delta',
              sequence_number: nextSeq(),
              item_id: fcId,
              output_index: outputIndex,
              delta: argsDelta,
            },
          }
        }
      }

      if (part.type === 'tool-call') {
        const toolCallId = part.toolCallId
        const toolName = part.toolName

        if (isHostedToolCall(part)) {
          // web_search 等 hosted tool：AI SDK 把上游 web_search_call 拆成 tool-call + tool-result 对。
          // tool-input-start 已经预留 index；缺少 start 时由 tool-result 补发 added。
          hostedToolCallIds.add(toolCallId)
          continue
        }

        const fcId =
          toolCallFcIds.get(toolCallId) ?? `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const isCustom = isCustomToolName(toolName, customToolNames)
        const isTsShimmed = isToolSearchShimmed(toolName, toolSearchShimmed)
        const nsResolved = resolveNamespacedToolName(
          toolName,
          namespaceFlatMap,
          part.providerMetadata,
          namespacePassthrough,
        )

        yield* closeCurrentTextMessage()

        let outputIndex = toolCallOutputIndices.get(toolCallId)
        if (outputIndex === undefined) {
          outputIndex = reserveOutputIndex()
          toolCallOutputIndices.set(toolCallId, outputIndex)
        }

        const rawArgs = part.input ?? {}
        // tool_search 的 arguments 是对象（codex 期望），在下方 isTsShimmed 分支用
        // decodeToolSearchInput 单独计算；custom/function 用字符串 args。
        const args = isCustom
          ? decodeCustomToolInput(rawArgs)
          : typeof rawArgs === 'string'
            ? rawArgs
            : JSON.stringify(rawArgs)

        if (!toolCallStartEmitted.has(toolCallId)) {
          const addedItem = isCustom
            ? {
                id: fcId,
                type: 'custom_tool_call' as const,
                status: 'in_progress' as const,
                call_id: toolCallId,
                name: toolName,
                input: '',
              }
            : isTsShimmed
              ? {
                  id: fcId,
                  type: 'tool_search_call' as const,
                  status: 'in_progress' as const,
                  call_id: toolCallId,
                  execution: 'client' as const,
                  arguments: {},
                }
              : {
                  id: fcId,
                  type: 'function_call' as const,
                  status: 'in_progress' as const,
                  call_id: toolCallId,
                  ...nsResolved,
                  arguments: '',
                }
          yield {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              sequence_number: nextSeq(),
              output_index: outputIndex,
              item: addedItem,
            },
          }
        }

        if (!toolCallsWithArgumentDeltas.has(toolCallId)) {
          if (isCustom) {
            yield {
              event: 'response.custom_tool_call_input.delta',
              data: {
                type: 'response.custom_tool_call_input.delta',
                sequence_number: nextSeq(),
                item_id: fcId,
                output_index: outputIndex,
                delta: args,
              },
            }
          } else if (!isTsShimmed) {
            yield {
              event: 'response.function_call_arguments.delta',
              data: {
                type: 'response.function_call_arguments.delta',
                sequence_number: nextSeq(),
                item_id: fcId,
                output_index: outputIndex,
                delta: args,
              },
            }
          }
        }

        if (isCustom) {
          const doneCustomToolCall: ResponseCustomToolCall = {
            id: fcId,
            type: 'custom_tool_call',
            status: 'completed',
            call_id: toolCallId,
            name: toolName,
            input: args,
          }
          yield {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              sequence_number: nextSeq(),
              output_index: outputIndex,
              item: doneCustomToolCall,
            },
          }
          completedOutput[outputIndex] = doneCustomToolCall
        } else if (isTsShimmed) {
          const doneToolSearchCall: ResponseToolSearchCall = {
            id: fcId,
            type: 'tool_search_call',
            status: 'completed',
            call_id: toolCallId,
            execution: 'client',
            arguments: decodeToolSearchInput(rawArgs),
          }
          yield {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              sequence_number: nextSeq(),
              output_index: outputIndex,
              item: doneToolSearchCall,
            },
          }
          completedOutput[outputIndex] = doneToolSearchCall
        } else {
          yield {
            event: 'response.function_call_arguments.done',
            data: {
              type: 'response.function_call_arguments.done',
              sequence_number: nextSeq(),
              item_id: fcId,
              output_index: outputIndex,
              arguments: args,
            },
          }
          const doneFunctionCall = {
            id: fcId,
            type: 'function_call' as const,
            status: 'completed' as const,
            call_id: toolCallId,
            ...nsResolved,
            arguments: args,
          }
          yield {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              sequence_number: nextSeq(),
              output_index: outputIndex,
              item: doneFunctionCall,
            },
          }
          completedOutput[outputIndex] = doneFunctionCall
        }
        toolCallOutputIndices.delete(toolCallId)
      }

      if (part.type === 'tool-result' && hostedToolCallIds.has(part.toolCallId)) {
        // hosted tool 结果使用 tool-input-start 时预留的稳定 index。
        yield* closeCurrentTextMessage()
        let outputIndex = toolCallOutputIndices.get(part.toolCallId)
        if (outputIndex === undefined) {
          outputIndex = reserveOutputIndex()
          toolCallOutputIndices.set(part.toolCallId, outputIndex)
        }
        const action = mapWebSearchAction(part.output)
        if (!toolCallStartEmitted.has(part.toolCallId)) {
          yield {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              sequence_number: nextSeq(),
              output_index: outputIndex,
              item: {
                id: part.toolCallId,
                type: 'web_search_call',
                status: 'in_progress',
                action: null,
              },
            },
          }
        }
        const wsCall: ResponseWebSearchCall = {
          id: part.toolCallId,
          type: 'web_search_call',
          status: 'completed',
          action,
        }
        yield {
          event: 'response.output_item.done',
          data: {
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: wsCall,
          },
        }
        completedOutput[outputIndex] = wsCall
        hostedToolCallIds.delete(part.toolCallId)
        toolCallOutputIndices.delete(part.toolCallId)
      }

      if (part.type === 'finish') {
        yield* finishReasoningItem()
        yield* closeCurrentTextMessage()

        const finishReason = part.finishReason
        const status = mapResponseStatus(finishReason)
        const usage = extractUsageFromFinishPart(part)
        const finishResponse = part.response

        const completedResponse: OpenAIResponse = {
          id: finishResponse?.id ?? responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: input.model,
          status,
          output: completedOutput.filter((item): item is ResponseOutputItem => item !== undefined),
          output_text: fullText,
          instructions: null,
          temperature: null,
          top_p: null,
          tool_choice: null,
          tools: [],
          parallel_tool_calls: true,
          truncation: 'disabled',
        }

        if (usage && hasUsageData(usage)) {
          const promptTokens = usage.inputTokens ?? 0
          const completionTokens = usage.outputTokens ?? 0
          completedResponse.usage = {
            input_tokens: promptTokens,
            output_tokens: completionTokens,
            total_tokens: usage.totalTokens ?? promptTokens + completionTokens,
            input_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
            output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
          }
        }

        yield {
          event: 'response.completed',
          data: {
            type: 'response.completed',
            sequence_number: nextSeq(),
            response: completedResponse,
          },
        }
      }

      if (part.type === 'error') {
        yield* emitFailedResponse(part.error)
        return
      }

      if (part.type === 'openai-error') {
        yield* emitFailedResponse(part.body)
        return
      }
    }
  } catch (error) {
    yield* emitFailedResponse(error)
    return
  }
}

// ─── Non-Streaming Renderer ───────────────────────────────────

export function renderOpenAIResponse(
  input: RenderResultInput & ResponsesEnrichment,
): OpenAIResponse {
  const output: ResponseOutputItem[] = []
  const customToolNames = input.customToolNames
  const customToolShimmed = input.customToolShimmed
  const toolSearchShimmed = input.toolSearchShimmed
  const namespaceFlatMap = input.namespaceFlatMap
  const namespacePassthrough = input.namespacePassthrough

  if (input.reasoningText) {
    output.push({
      id: `rs_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: input.reasoningText }],
    })
  }

  if (input.text != null) {
    output.push({
      id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      status: mapResponseStatus(input.finishReason),
      role: 'assistant',
      content: [{ type: 'output_text', text: input.text, annotations: [] }],
    })
  }

  if (input.toolCalls?.length) {
    for (const call of input.toolCalls) {
      if (call.providerExecuted === true) {
        output.push({
          id: call.toolCallId,
          type: 'web_search_call',
          status: 'completed',
          action: null, // 非流式 generateText 无 tool-result 配对，action 未知
        })
      } else if (isCustomToolName(call.toolName, customToolNames)) {
        output.push({
          id: `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'custom_tool_call',
          status: 'completed',
          call_id: call.toolCallId,
          name: call.toolName,
          input: decodeCustomToolInput(call.input),
        })
      } else if (isToolSearchShimmed(call.toolName, toolSearchShimmed)) {
        output.push({
          id: `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'tool_search_call',
          status: 'completed',
          call_id: call.toolCallId,
          execution: 'client',
          arguments: decodeToolSearchInput(call.input),
        })
      } else {
        const args = typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {})
        const nsResolved = resolveNamespacedToolName(
          call.toolName,
          namespaceFlatMap,
          call.providerMetadata,
          namespacePassthrough,
        )
        output.push({
          id: `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function_call',
          status: 'completed',
          call_id: call.toolCallId,
          ...nsResolved,
          arguments: args,
        })
      }
    }
  }

  const response: OpenAIResponse = {
    id: input.response?.id ?? `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'response',
    created_at: Math.floor((input.response?.timestamp?.getTime() ?? Date.now()) / 1000),
    model: input.model,
    status: mapResponseStatus(input.finishReason),
    output,
    output_text: input.text ?? '',
    instructions: null,
    temperature: null,
    top_p: null,
    tool_choice: null,
    tools: [],
    parallel_tool_calls: true,
    truncation: 'disabled',
  }

  if (input.usage && hasUsageData(input.usage)) {
    response.usage = {
      input_tokens: input.usage.inputTokens ?? 0,
      output_tokens: input.usage.outputTokens ?? 0,
      total_tokens:
        input.usage.totalTokens ?? (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0),
      input_tokens_details: { cached_tokens: input.usage.cacheReadTokens ?? 0 },
      output_tokens_details: { reasoning_tokens: input.usage.reasoningTokens ?? 0 },
    }
  }

  return response
}

export function renderOpenAIResponsesRawResponse(
  input: RenderResultInput & ResponsesEnrichment,
): OpenAIResponse {
  if (input.response && 'body' in input.response && input.response.body !== undefined) {
    return input.response.body as OpenAIResponse
  }
  return renderOpenAIResponse(input)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isResponseFailedFrame(value: unknown): value is OpenAIResponseStreamEvent {
  return isRecord(value) && value.type === 'response.failed'
}

export function tryExtractOpenAIResponsesFailedFrame(
  error: unknown,
): OpenAIResponseStreamEvent | undefined {
  const seen = new Set<unknown>()
  const stack: unknown[] = [error]

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || seen.has(current)) continue
    seen.add(current)

    if (isResponseFailedFrame(current)) return current
    if (!isRecord(current)) continue

    const data = current.data
    if (isResponseFailedFrame(data)) return data

    const responseBody = current.responseBody
    if (typeof responseBody === 'string') {
      try {
        const parsed = JSON.parse(responseBody) as unknown
        if (isResponseFailedFrame(parsed)) return parsed
      } catch {
        // responseBody is best-effort error metadata; fall through to generic handling.
      }
    }

    if ('lastError' in current) stack.push(current.lastError)
    if ('cause' in current) stack.push(current.cause)
  }

  return undefined
}

function rawEventName(rawValue: unknown): string | undefined {
  return isRecord(rawValue) && typeof rawValue.type === 'string' ? rawValue.type : undefined
}

function rawFailedFrame(
  model: string,
  error: unknown,
  sequenceNumber: number,
  responseId?: string,
): OpenAIResponseStreamEvent {
  return (
    tryExtractOpenAIResponsesFailedFrame(error) ?? {
      type: 'response.failed',
      sequence_number: sequenceNumber,
      response: {
        id: responseId ?? `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model,
        status: 'failed',
        output: [],
        output_text: '',
        error: { message: toErrorMessage(error) },
        instructions: null,
        temperature: null,
        top_p: null,
        tool_choice: null,
        tools: [],
        parallel_tool_calls: true,
        truncation: 'disabled',
      },
    }
  )
}

async function* renderOpenAIResponsesRawSSEStream(input: {
  model: string
  stream: AsyncIterable<ProxyStreamPart>
}): AsyncIterable<SSEOutput<OpenAIResponseStreamEvent>> {
  let nextSequenceNumber = 0
  let responseId: string | undefined
  let terminalSeen = false
  try {
    for await (const part of input.stream) {
      if (terminalSeen) continue

      if (part.type === 'raw') {
        const event = rawEventName(part.rawValue)
        if (isRecord(part.rawValue)) {
          if (
            typeof part.rawValue.sequence_number === 'number' &&
            Number.isFinite(part.rawValue.sequence_number)
          ) {
            nextSequenceNumber = Math.max(nextSequenceNumber, part.rawValue.sequence_number + 1)
          }
          if (isRecord(part.rawValue.response) && typeof part.rawValue.response.id === 'string') {
            responseId = part.rawValue.response.id
          }
        }
        const frame: SSEOutput<OpenAIResponseStreamEvent> =
          event !== undefined
            ? { event, data: part.rawValue as OpenAIResponseStreamEvent }
            : { data: part.rawValue as OpenAIResponseStreamEvent }
        yield frame
        if (
          event === 'response.completed' ||
          event === 'response.incomplete' ||
          event === 'response.failed'
        ) {
          terminalSeen = true
        }
        continue
      }

      if (part.type === 'error') {
        yield {
          event: 'response.failed',
          data: rawFailedFrame(input.model, part.error, nextSequenceNumber, responseId),
        }
        return
      }

      if (part.type === 'openai-error') {
        yield {
          event: 'response.failed',
          data: rawFailedFrame(input.model, part.body, nextSequenceNumber, responseId),
        }
        return
      }
    }
    if (!terminalSeen) {
      yield {
        event: 'response.failed',
        data: rawFailedFrame(
          input.model,
          new Error('Incomplete stream: upstream ended before a terminal response event'),
          nextSequenceNumber,
          responseId,
        ),
      }
    }
  } catch (error) {
    if (terminalSeen) return
    yield {
      event: 'response.failed',
      data: rawFailedFrame(input.model, error, nextSequenceNumber, responseId),
    }
  }
}

type RawStreamTerminalObservation =
  { terminalPart: 'finish' } | { terminalPart: 'error'; error: Error }

export const renderOpenAIResponsesRawSSE = Object.assign(renderOpenAIResponsesRawSSEStream, {
  observeTerminalPart(part: ProxyStreamPart): RawStreamTerminalObservation | undefined {
    if (part.type !== 'raw') return undefined
    const event = rawEventName(part.rawValue)
    if (event === 'response.completed' || event === 'response.incomplete') {
      return { terminalPart: 'finish' }
    }
    if (event === 'response.failed') {
      return { terminalPart: 'error', error: new Error('Upstream response failed') }
    }
    return undefined
  },
})
