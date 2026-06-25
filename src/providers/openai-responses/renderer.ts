import { randomUUID } from 'node:crypto'
import { toErrorMessage } from '../protocol-types.js'
import { extractUsageFromFinishPart, hasUsageData } from '../shared/renderer-utils.js'
import type { SSEOutput } from '../shared/sse-utils.js'
import type { FinishReason, RenderResultInput } from '../protocol-types.js'
import type { ProxyStreamPart } from '../shared/aisdk-types.js'
import type {
  ResponseOutputText,
  ResponseOutputMessage,
  ResponseFunctionToolCall,
  ResponseCustomToolCall,
  ResponseWebSearchCall,
  ResponseWebSearchAction,
  ResponseOutputItem,
  ResponseUsage,
  OpenAIResponse,
  OpenAIResponseStreamEvent,
} from './types.js'

export type {
  ResponseOutputText,
  ResponseOutputMessage,
  ResponseFunctionToolCall,
  ResponseCustomToolCall,
  ResponseWebSearchCall,
  ResponseOutputItem,
  ResponseUsage,
  OpenAIResponse,
} from './types.js'

// ─── Status Mapping ───────────────────────────────────────────

function mapResponseStatus(
  finishReason?: FinishReason,
  toolCalls?: unknown[],
): 'completed' | 'incomplete' {
  if (toolCalls?.length) return 'incomplete'
  if (
    finishReason === 'length' ||
    finishReason === 'content-filter' ||
    finishReason === 'tool-calls'
  ) {
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

/** 把 AI SDK tool-result.output 还原成 Codex 期望的 web_search_call.action。
 *  AI SDK mapWebSearchOutput 把上游 snake_case action.type 转成 camelCase
 *  （open_page→openPage、find_in_page→findInPage；search 不变），Codex 期望 snake_case，这里转回。 */
function mapWebSearchAction(output: unknown): ResponseWebSearchAction | null {
  if (!output || typeof output !== 'object') return null
  const o = output as { action?: { type?: string; query?: string; queries?: string[]; url?: string; pattern?: string } }
  const a = o.action
  if (!a || typeof a.type !== 'string') return null
  const actionType: ResponseWebSearchAction['type'] =
    a.type === 'openPage' ? 'open_page'
    : a.type === 'findInPage' ? 'find_in_page'
    : a.type === 'search' ? 'search'
    : a.type as ResponseWebSearchAction['type']
  const action: ResponseWebSearchAction = { type: actionType }
  if (a.query !== undefined) action.query = a.query
  if (a.queries !== undefined) action.queries = a.queries
  if (a.url !== undefined) action.url = a.url
  if (a.pattern !== undefined) action.pattern = a.pattern
  return action
}

/** 还原 custom_tool_call 的 input：AI SDK 对 custom_tool_call.input 做 JSON.stringify
 * (裸 patch 文本 → JSON 字符串)，这里 JSON.parse 还原为裸文本。 */
function decodeCustomToolInput(raw: unknown): string {
  if (typeof raw !== 'string') return JSON.stringify(raw ?? '')
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed : raw
  } catch {
    return raw
  }
}

// ─── Streaming SSE Renderer ───────────────────────────────────

export async function* renderOpenAIResponseSSE(input: {
  model: string
  stream: AsyncIterable<ProxyStreamPart>
  customToolNames?: Set<string>
}): AsyncIterable<SSEOutput<OpenAIResponseStreamEvent>> {
  const responseId = `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  let currentMsgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

  function newMsgId(): string {
    currentMsgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    return currentMsgId
  }

  let sequenceNumber = 0
  let fullText = ''
  let outputIndex = 0
  let responseStarted = false
  let outputItemStarted = false
  let contentPartStarted = false
  let reasoningItemStarted = false
  let fullReasoning = ''
  let reasoningItemId = ''
  let reasoningEncryptedContent: string | undefined
  const streamedToolCalls: Array<ResponseFunctionToolCall | ResponseCustomToolCall> = []
  // hosted web_search_call items: tracked separately so they appear in the final
  // output array but do NOT trigger 'incomplete' status (Fix 1). Hosted tools are
  // executed inline by the upstream and do not pause the Codex agent loop.
  const streamedHostedCalls: ResponseWebSearchCall[] = []

  const toolCallFcIds = new Map<string, string>()
  const toolCallToolNames = new Map<string, string>()
  const toolCallsWithArgumentDeltas = new Set<string>()
  const toolCallStartEmitted = new Set<string>()
  const hostedToolCallIds = new Set<string>()
  const customToolNames = input.customToolNames

  function nextSeq(): number {
    return ++sequenceNumber
  }

  /** Close the in-progress text message item: emit output_text.done +
   *  content_part.done + output_item.done, reset outputItemStarted/
   *  contentPartStarted, and advance outputIndex. No-op when no text
   *  content part is open. Replaces ~4 duplicated close-text blocks. */
  function* closeCurrentTextMessage(): Generator<SSEOutput<OpenAIResponseStreamEvent>> {
    if (!contentPartStarted) return
    yield { event: 'response.output_text.done', data: {
      type: 'response.output_text.done',
      sequence_number: nextSeq(),
      item_id: currentMsgId, output_index: outputIndex, content_index: 0,
      text: fullText,
    } }
    yield { event: 'response.content_part.done', data: {
      type: 'response.content_part.done',
      sequence_number: nextSeq(),
      item_id: currentMsgId, output_index: outputIndex, content_index: 0,
      part: { type: 'output_text', text: fullText, annotations: [] },
    } }
    yield { event: 'response.output_item.done', data: {
      type: 'response.output_item.done',
      sequence_number: nextSeq(), output_index: outputIndex,
      item: { id: currentMsgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] },
    } }
    outputIndex++
    outputItemStarted = false
    contentPartStarted = false
  }

  try {
    for await (const part of input.stream) {
      // Start response on first part
      if (!responseStarted) {
        responseStarted = true
        yield { event: 'response.created', data: {
          type: 'response.created',
          sequence_number: nextSeq(),
          response: { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: input.model, status: 'in_progress', output: [] },
        } }
        yield { event: 'response.in_progress', data: {
          type: 'response.in_progress',
          sequence_number: nextSeq(),
          response: { id: responseId, object: 'response', status: 'in_progress', output: [] },
        } }
      }

      if (part.type === 'text-delta') {
        const delta = part.text

        if (!outputItemStarted) {
          outputItemStarted = true
          const msgId = newMsgId()
          yield { event: 'response.output_item.added', data: {
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          } }
          yield { event: 'response.content_part.added', data: {
            type: 'response.content_part.added',
            sequence_number: nextSeq(),
            item_id: msgId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          } }
          contentPartStarted = true
        }

        fullText += delta
        yield { event: 'response.output_text.delta', data: {
          type: 'response.output_text.delta',
          sequence_number: nextSeq(),
          item_id: currentMsgId,
          output_index: outputIndex,
          content_index: 0,
          delta,
        } }
      }

      if (part.type === 'reasoning-start') {
        const enc = part.providerMetadata?.openai?.reasoningEncryptedContent
        if (typeof enc === 'string') reasoningEncryptedContent = enc
        if (!reasoningItemStarted) {
          reasoningItemStarted = true
          reasoningItemId = `rs_${randomUUID().replace(/-/g, '').slice(0, 24)}`
          yield { event: 'response.output_item.added', data: {
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { id: reasoningItemId, type: 'reasoning', summary: [] },
          } }
        }
      }

      if (part.type === 'reasoning-delta') {
        const delta = part.text
        const enc = part.providerMetadata?.openai?.reasoningEncryptedContent
        if (typeof enc === 'string') reasoningEncryptedContent = enc

        if (!reasoningItemStarted) {
          reasoningItemStarted = true
          reasoningItemId = `rs_${randomUUID().replace(/-/g, '').slice(0, 24)}`
          yield { event: 'response.output_item.added', data: {
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { id: reasoningItemId, type: 'reasoning', summary: [] },
          } }
        }

        fullReasoning += delta
        yield { event: 'response.reasoning_summary_text.delta', data: {
          type: 'response.reasoning_summary_text.delta',
          sequence_number: nextSeq(),
          item_id: reasoningItemId,
          output_index: outputIndex,
          delta,
        } }
      }

      if (part.type === 'reasoning-end') {
        if (reasoningItemStarted) {
          yield { event: 'response.reasoning_summary_text.done', data: {
            type: 'response.reasoning_summary_text.done',
            sequence_number: nextSeq(),
            item_id: reasoningItemId,
            output_index: outputIndex,
            text: fullReasoning,
          } }
          yield { event: 'response.output_item.done', data: {
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: {
              id: reasoningItemId,
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: fullReasoning }],
              ...(reasoningEncryptedContent ? { encrypted_content: reasoningEncryptedContent } : {}),
            },
          } }
          outputIndex++
          reasoningItemStarted = false
          fullReasoning = ''
          reasoningEncryptedContent = undefined
        }
      }

      if (part.type === 'tool-input-start') {
        const toolCallId = part.id
        const toolName = part.toolName
        if (isHostedToolCall(part)) {
          hostedToolCallIds.add(toolCallId)
          continue
        }
        const fcId = `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        toolCallFcIds.set(toolCallId, fcId)
        toolCallToolNames.set(toolCallId, toolName)

        yield* closeCurrentTextMessage()

        const isCustom = isCustomToolName(toolName, customToolNames)
        const addedItem = isCustom
          ? { id: fcId, type: 'custom_tool_call' as const, status: 'in_progress' as const, call_id: toolCallId, name: toolName, input: '' }
          : { id: fcId, type: 'function_call' as const, status: 'in_progress' as const, call_id: toolCallId, name: toolName, arguments: '' }
        yield { event: 'response.output_item.added', data: {
          type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex,
          item: addedItem,
        } }
        toolCallStartEmitted.add(toolCallId)
      }

      if (part.type === 'tool-input-delta') {
        const toolCallId = part.id
        const argsDelta = part.delta
        if (toolCallId != null && hostedToolCallIds.has(toolCallId)) continue
        if (toolCallId == null || argsDelta == null) continue

        toolCallsWithArgumentDeltas.add(toolCallId)
        const fcId = toolCallFcIds.get(toolCallId) ?? `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const toolName = toolCallToolNames.get(toolCallId) ?? ''

        if (isCustomToolName(toolName, customToolNames)) {
          yield { event: 'response.custom_tool_call_input.delta', data: {
            type: 'response.custom_tool_call_input.delta', sequence_number: nextSeq(),
            item_id: fcId, output_index: outputIndex, delta: argsDelta,
          } }
        } else {
          yield { event: 'response.function_call_arguments.delta', data: {
            type: 'response.function_call_arguments.delta', sequence_number: nextSeq(),
            item_id: fcId, output_index: outputIndex, delta: argsDelta,
          } }
        }
      }

      if (part.type === 'tool-call') {
        const toolCallId = part.toolCallId
        const toolName = part.toolName

        if (isHostedToolCall(part)) {
          // web_search 等 hosted tool：AI SDK 把上游 web_search_call 拆成 tool-call + tool-result 对。
          // Fix 2: tool-call 只记录 id，不占用 outputIndex；added+done 都在 tool-result 分支同步发出，
          // 避免在 tool-call 与 tool-result 之间 outputIndex 被 in-flight web_search_call 占据
          // （若其间到达 text-delta 会在同一 outputIndex 开新 message item 覆盖）。
          hostedToolCallIds.add(toolCallId)
          continue
        }

        const fcId = toolCallFcIds.get(toolCallId) ?? `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        const isCustom = isCustomToolName(toolName, customToolNames)

        yield* closeCurrentTextMessage()

        const rawArgs = part.input ?? {}
        // custom_tool_call: input 是 JSON.stringify(裸文本)，还原为裸文本；function_call: 保持原样
        const args = isCustom
          ? decodeCustomToolInput(rawArgs)
          : (typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs))

        if (!toolCallStartEmitted.has(toolCallId)) {
          const addedItem = isCustom
            ? { id: fcId, type: 'custom_tool_call' as const, status: 'in_progress' as const, call_id: toolCallId, name: toolName, input: '' }
            : { id: fcId, type: 'function_call' as const, status: 'in_progress' as const, call_id: toolCallId, name: toolName, arguments: '' }
          yield { event: 'response.output_item.added', data: {
            type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex,
            item: addedItem,
          } }
        }

        if (!toolCallsWithArgumentDeltas.has(toolCallId)) {
          if (isCustom) {
            yield { event: 'response.custom_tool_call_input.delta', data: {
              type: 'response.custom_tool_call_input.delta', sequence_number: nextSeq(),
              item_id: fcId, output_index: outputIndex, delta: args,
            } }
          } else {
            yield { event: 'response.function_call_arguments.delta', data: {
              type: 'response.function_call_arguments.delta', sequence_number: nextSeq(),
              item_id: fcId, output_index: outputIndex, delta: args,
            } }
          }
        }

        if (isCustom) {
          yield { event: 'response.output_item.done', data: {
            type: 'response.output_item.done', sequence_number: nextSeq(), output_index: outputIndex,
            item: { id: fcId, type: 'custom_tool_call', status: 'completed', call_id: toolCallId, name: toolName, input: args },
          } }
          streamedToolCalls.push({
            id: fcId, type: 'custom_tool_call', status: 'completed',
            call_id: toolCallId, name: toolName, input: args,
          })
        } else {
          yield { event: 'response.function_call_arguments.done', data: {
            type: 'response.function_call_arguments.done', sequence_number: nextSeq(),
            item_id: fcId, output_index: outputIndex, arguments: args,
          } }
          yield { event: 'response.output_item.done', data: {
            type: 'response.output_item.done', sequence_number: nextSeq(), output_index: outputIndex,
            item: { id: fcId, type: 'function_call', status: 'completed', call_id: toolCallId, name: toolName, arguments: args },
          } }
          streamedToolCalls.push({
            id: fcId, type: 'function_call', status: 'completed',
            call_id: toolCallId, name: toolName, arguments: args,
          })
        }
        outputIndex++
      }

      if (part.type === 'tool-result' && hostedToolCallIds.has(part.toolCallId)) {
        // hosted tool 结果到达：tool-call 分支已记录 id（未占 outputIndex）。
        // 这里同步发出 added(action:null) + done(带 action)，item id 用 toolCallId 即上游 ws_ id。
        // 先关闭可能 in-progress 的 text message，避免 outputIndex 冲突。
        yield* closeCurrentTextMessage()
        const action = mapWebSearchAction(part.output)
        yield { event: 'response.output_item.added', data: {
          type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex,
          item: { id: part.toolCallId, type: 'web_search_call', status: 'in_progress', action: null },
        } }
        const wsCall: ResponseWebSearchCall = { id: part.toolCallId, type: 'web_search_call', status: 'completed', action }
        yield { event: 'response.output_item.done', data: {
          type: 'response.output_item.done', sequence_number: nextSeq(), output_index: outputIndex,
          item: wsCall,
        } }
        streamedHostedCalls.push(wsCall)
        outputIndex++
        hostedToolCallIds.delete(part.toolCallId)
      }

      if (part.type === 'finish') {
        if (reasoningItemStarted) {
          yield { event: 'response.reasoning_summary_text.done', data: {
            type: 'response.reasoning_summary_text.done',
            sequence_number: nextSeq(),
            item_id: reasoningItemId,
            output_index: outputIndex,
            text: fullReasoning,
          } }
          yield { event: 'response.output_item.done', data: {
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: {
              id: reasoningItemId,
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: fullReasoning }],
              ...(reasoningEncryptedContent ? { encrypted_content: reasoningEncryptedContent } : {}),
            },
          } }
          outputIndex++
          reasoningItemStarted = false
          fullReasoning = ''
          reasoningEncryptedContent = undefined
        }
        yield* closeCurrentTextMessage()

        const finishReason = part.finishReason
        // Fix 1: hosted web_search_call 不参与 incomplete 判定（streamedToolCalls 已不含 hosted）
        const status = mapResponseStatus(finishReason, streamedToolCalls)
        const usage = extractUsageFromFinishPart(part)
        const finishResponse = part.response

        const textOutput: ResponseOutputMessage[] = fullText !== '' ? [{
          id: currentMsgId, type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: fullText, annotations: [] }],
        }] : []

        const completedResponse: OpenAIResponse = {
          id: finishResponse?.id ?? responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: input.model,
          status,
          output: [...textOutput, ...streamedToolCalls, ...streamedHostedCalls],
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
            total_tokens: usage.totalTokens ?? (promptTokens + completionTokens),
            input_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
            output_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
          }
        }

        yield { event: 'response.completed', data: {
          type: 'response.completed',
          sequence_number: nextSeq(),
          response: completedResponse,
        } }
      }

      if (part.type === 'error') {
        const errorData = part.error
        yield { event: 'response.error', data: {
          type: 'response.error',
          sequence_number: nextSeq(),
          error: { type: 'server_error', message: toErrorMessage(errorData) },
        } }
        yield { event: 'response.completed', data: {
          type: 'response.completed',
          sequence_number: nextSeq(),
          response: {
            id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
            model: input.model, status: 'incomplete', output: [], output_text: '',
            instructions: null, temperature: null, top_p: null, tool_choice: null,
            tools: [], parallel_tool_calls: true, truncation: 'disabled',
          },
        } }
        return
      }

      if (part.type === 'openai-error') {
        const errorData = part.body
        yield { event: 'response.error', data: {
          type: 'response.error',
          sequence_number: nextSeq(),
          error: { type: 'server_error', message: toErrorMessage(errorData) },
        } }
        yield { event: 'response.completed', data: {
          type: 'response.completed',
          sequence_number: nextSeq(),
          response: {
            id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
            model: input.model, status: 'incomplete', output: [], output_text: '',
            instructions: null, temperature: null, top_p: null, tool_choice: null,
            tools: [], parallel_tool_calls: true, truncation: 'disabled',
          },
        } }
        return
      }
    }
  } catch (error) {
    yield { event: 'response.error', data: {
      type: 'response.error',
      sequence_number: nextSeq(),
      error: { type: 'server_error', message: toErrorMessage(error) },
    } }
    yield { event: 'response.completed', data: {
      type: 'response.completed',
      sequence_number: nextSeq(),
      response: {
        id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
        model: input.model, status: 'incomplete', output: [], output_text: '',
        instructions: null, temperature: null, top_p: null, tool_choice: null,
        tools: [], parallel_tool_calls: true, truncation: 'disabled',
      },
    } }
    return
  }
}

// ─── Non-Streaming Renderer ───────────────────────────────────

export function renderOpenAIResponse(input: RenderResultInput): OpenAIResponse {
  const output: ResponseOutputItem[] = []
  const customToolNames = input.customToolNames

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
          action: null,  // 非流式 generateText 无 tool-result 配对，action 未知
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
      } else {
        const args = typeof call.input === 'string' ? call.input : JSON.stringify(call.input ?? {})
        output.push({
          id: `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function_call',
          status: 'completed',
          call_id: call.toolCallId,
          name: call.toolName,
          arguments: args,
        })
      }
    }
  }

  // Fix 1: hosted web_search_call (providerExecuted) 不参与 incomplete 判定——
  // 上游内联执行，不暂停 Codex agent loop；仅 function/custom tool call 触发 incomplete。
  const nonHostedToolCalls = input.toolCalls?.filter((c) => c.providerExecuted !== true)

  const response: OpenAIResponse = {
    id: input.response?.id ?? `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'response',
    created_at: Math.floor((input.response?.timestamp?.getTime() ?? Date.now()) / 1000),
    model: input.model,
    status: mapResponseStatus(input.finishReason, nonHostedToolCalls),
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
      total_tokens: input.usage.totalTokens ?? (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0),
      input_tokens_details: { cached_tokens: input.usage.cacheReadTokens ?? 0 },
      output_tokens_details: { reasoning_tokens: input.usage.reasoningTokens ?? 0 },
    }
  }

  return response
}
