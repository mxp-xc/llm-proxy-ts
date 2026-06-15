import { randomUUID } from 'node:crypto'
import { toErrorMessage, isRecord } from '../protocol-types.js'
import { extractUsageFromFinishPart, hasUsageData } from '../shared/renderer-utils.js'
import type { FinishReason, RenderResultInput } from '../protocol-types.js'
import type {
  ResponseOutputText,
  ResponseOutputMessage,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseUsage,
  OpenAIResponse,
} from './types.js'

export type {
  ResponseOutputText,
  ResponseOutputMessage,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseUsage,
  OpenAIResponse,
} from './types.js'

// ─── Status Mapping ───────────────────────────────────────────

function mapResponseStatus(
  finishReason?: FinishReason,
  toolCalls?: Array<unknown>,
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

// ─── Streaming SSE Renderer ───────────────────────────────────


export async function* renderOpenAIResponseSSE(input: {
  model: string
  stream: AsyncIterable<unknown>
}): AsyncIterable<Uint8Array> {
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
  const streamedToolCalls: ResponseFunctionToolCall[] = []

  // Bug #3 — tool-call delta tracking state
  const toolCallFcIds = new Map<string, string>()       // toolCallId → fcId
  const toolCallsWithArgumentDeltas = new Set<string>()  // toolCallIds that had incremental deltas
  const toolCallStartEmitted = new Set<string>()         // toolCallIds that had output_item.added emitted

  function sse(event: string, data: Record<string, unknown>): Uint8Array {
    return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  function nextSeq(): number {
    return ++sequenceNumber
  }

  try {
    for await (const part of input.stream) {
      if (!isRecord(part)) continue

      // Start response on first part
      if (!responseStarted) {
        responseStarted = true
        yield sse('response.created', {
          type: 'response.created',
          sequence_number: nextSeq(),
          response: { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: input.model, status: 'in_progress', output: [] },
        })
        yield sse('response.in_progress', {
          type: 'response.in_progress',
          sequence_number: nextSeq(),
          response: { id: responseId, object: 'response', status: 'in_progress', output: [] },
        })
      }

      const partType = (part as Record<string, unknown>).type

      if (partType === 'text-delta') {
        // AI SDK fullStream uses `text` field (not `textDelta`); fall back to `delta` for other stream types
        const delta = String((part as Record<string, unknown>).text ?? (part as Record<string, unknown>).delta ?? '')

        // Start output item if needed
        if (!outputItemStarted) {
          outputItemStarted = true
          const msgId = newMsgId()
          yield sse('response.output_item.added', {
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          })
          yield sse('response.content_part.added', {
            type: 'response.content_part.added',
            sequence_number: nextSeq(),
            item_id: msgId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          })
          contentPartStarted = true
        }

        fullText += delta
        yield sse('response.output_text.delta', {
          type: 'response.output_text.delta',
          sequence_number: nextSeq(),
          item_id: currentMsgId,
          output_index: outputIndex,
          content_index: 0,
          delta,
        })
      }

      // Reasoning chunks — map to reasoning output item (OpenAI Responses API)
      if (partType === 'reasoning-start') {
        if (!reasoningItemStarted) {
          reasoningItemStarted = true
          reasoningItemId = `rs_${randomUUID().replace(/-/g, '').slice(0, 24)}`
          yield sse('response.output_item.added', {
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { id: reasoningItemId, type: 'reasoning', summary: [] },
          })
        }
      }

      if (partType === 'reasoning-delta') {
        // AI SDK fullStream uses `text` field; fall back to `delta`
        const delta = String((part as Record<string, unknown>).text ?? (part as Record<string, unknown>).delta ?? '')
        if (!delta) continue

        if (!reasoningItemStarted) {
          reasoningItemStarted = true
          reasoningItemId = `rs_${randomUUID().replace(/-/g, '').slice(0, 24)}`
          yield sse('response.output_item.added', {
            type: 'response.output_item.added',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { id: reasoningItemId, type: 'reasoning', summary: [] },
          })
        }

        fullReasoning += delta
        yield sse('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          sequence_number: nextSeq(),
          item_id: reasoningItemId,
          output_index: outputIndex,
          delta,
        })
      }

      if (partType === 'reasoning-end') {
        if (reasoningItemStarted) {
          yield sse('response.reasoning_summary_text.done', {
            type: 'response.reasoning_summary_text.done',
            sequence_number: nextSeq(),
            item_id: reasoningItemId,
            output_index: outputIndex,
            text: fullReasoning,
          })
          yield sse('response.output_item.done', {
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: fullReasoning }] },
          })
          outputIndex++
          reasoningItemStarted = false
          fullReasoning = ''
        }
      }

      // Bug #3 — Handler 1: tool-call-start / tool-input-start
      if (partType === 'tool-call-start' || partType === 'tool-input-start') {
        const toolCallId = String((part as Record<string, unknown>).toolCallId ?? `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`)
        const toolName = String((part as Record<string, unknown>).toolName ?? '')
        const fcId = `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        toolCallFcIds.set(toolCallId, fcId)

        // Close any open text content part first
        if (contentPartStarted) {
          yield sse('response.output_text.done', {
            type: 'response.output_text.done',
            sequence_number: nextSeq(),
            item_id: currentMsgId, output_index: outputIndex, content_index: 0,
            text: fullText,
          })
          yield sse('response.content_part.done', {
            type: 'response.content_part.done',
            sequence_number: nextSeq(),
            item_id: currentMsgId, output_index: outputIndex, content_index: 0,
            part: { type: 'output_text', text: fullText, annotations: [] },
          })
          yield sse('response.output_item.done', {
            type: 'response.output_item.done',
            sequence_number: nextSeq(), output_index: outputIndex,
            item: { id: currentMsgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] },
          })
          outputIndex++
          outputItemStarted = false
          contentPartStarted = false
        }

        yield sse('response.output_item.added', {
          type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex,
          item: { id: fcId, type: 'function_call', status: 'in_progress', call_id: toolCallId, name: toolName, arguments: '' },
        })
        toolCallStartEmitted.add(toolCallId)
      }

      // Bug #3 — Handler 2: tool-call-delta / tool-call-args-delta / tool-input-delta
      if (partType === 'tool-call-delta' || partType === 'tool-call-args-delta' || partType === 'tool-input-delta') {
        const toolCallId = String((part as Record<string, unknown>).toolCallId ?? '')
        const argsDelta = String(
          (part as Record<string, unknown>).argsTextDelta ??
          (part as Record<string, unknown>).inputTextDelta ??
          (part as Record<string, unknown>).argumentsDelta ??
          (part as Record<string, unknown>).delta ?? ''
        )
        if (!toolCallId || !argsDelta) continue

        toolCallsWithArgumentDeltas.add(toolCallId)
        const fcId = toolCallFcIds.get(toolCallId) ?? `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`

        yield sse('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', sequence_number: nextSeq(),
          item_id: fcId, output_index: outputIndex, delta: argsDelta,
        })
      }

      // Bug #3 — Handler 3: tool-call (complete)
      if (partType === 'tool-call') {
        const toolCallId = String((part as Record<string, unknown>).toolCallId ?? `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`)
        const toolName = String((part as Record<string, unknown>).toolName ?? '')
        const fcId = toolCallFcIds.get(toolCallId) ?? `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`

        // Close any open text content part first
        if (contentPartStarted) {
          yield sse('response.output_text.done', {
            type: 'response.output_text.done',
            sequence_number: nextSeq(),
            item_id: currentMsgId, output_index: outputIndex, content_index: 0,
            text: fullText,
          })
          yield sse('response.content_part.done', {
            type: 'response.content_part.done',
            sequence_number: nextSeq(),
            item_id: currentMsgId, output_index: outputIndex, content_index: 0,
            part: { type: 'output_text', text: fullText, annotations: [] },
          })
          yield sse('response.output_item.done', {
            type: 'response.output_item.done',
            sequence_number: nextSeq(), output_index: outputIndex,
            item: { id: currentMsgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] },
          })
          outputIndex++
          outputItemStarted = false
          contentPartStarted = false
        }

        // Bug #9 — avoid double-encoding string args
        const rawArgs = (part as Record<string, unknown>).args ?? (part as Record<string, unknown>).input ?? {}
        const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)

        // If start wasn't emitted via incremental events, emit it now
        if (!toolCallStartEmitted.has(toolCallId)) {
          yield sse('response.output_item.added', {
            type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex,
            item: { id: fcId, type: 'function_call', status: 'in_progress', call_id: toolCallId, name: toolName, arguments: '' },
          })
        }

        // Only emit full args as a single delta if no argument deltas were streamed
        if (!toolCallsWithArgumentDeltas.has(toolCallId)) {
          yield sse('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta', sequence_number: nextSeq(),
            item_id: fcId, output_index: outputIndex, delta: args,
          })
        }

        yield sse('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done', sequence_number: nextSeq(),
          item_id: fcId, output_index: outputIndex, arguments: args,
        })
        yield sse('response.output_item.done', {
          type: 'response.output_item.done', sequence_number: nextSeq(), output_index: outputIndex,
          item: { id: fcId, type: 'function_call', status: 'completed', call_id: toolCallId, name: toolName, arguments: args },
        })

        // Bug #1 — accumulate tool calls for response.completed
        streamedToolCalls.push({
          id: fcId, type: 'function_call', status: 'completed',
          call_id: toolCallId, name: toolName, arguments: args,
        })
        outputIndex++
      }

      if (partType === 'finish') {
        // Close any open reasoning item
        if (reasoningItemStarted) {
          yield sse('response.reasoning_summary_text.done', {
            type: 'response.reasoning_summary_text.done',
            sequence_number: nextSeq(),
            item_id: reasoningItemId,
            output_index: outputIndex,
            text: fullReasoning,
          })
          yield sse('response.output_item.done', {
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: fullReasoning }] },
          })
          outputIndex++
          reasoningItemStarted = false
          fullReasoning = ''
        }
        // Close any open text content
        if (contentPartStarted) {
          yield sse('response.output_text.done', {
            type: 'response.output_text.done',
            sequence_number: nextSeq(),
            item_id: currentMsgId, output_index: outputIndex, content_index: 0,
            text: fullText,
          })
          yield sse('response.content_part.done', {
            type: 'response.content_part.done',
            sequence_number: nextSeq(),
            item_id: currentMsgId, output_index: outputIndex, content_index: 0,
            part: { type: 'output_text', text: fullText, annotations: [] },
          })
        }
        if (outputItemStarted) {
          yield sse('response.output_item.done', {
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { id: currentMsgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] },
          })
        }

        // Build complete response object
        const finishReason = (part as Record<string, unknown>).finishReason as FinishReason
        // Bug #8 — pass streamedToolCalls to mapResponseStatus
        const status = mapResponseStatus(finishReason, streamedToolCalls)
        const usage = extractUsageFromFinishPart(part)
        const finishResponse = (part as Record<string, unknown>).response as { id?: string } | undefined

        // Bug #1 — build output from both text and accumulated tool calls
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
          output: [...textOutput, ...streamedToolCalls],
          output_text: fullText,
          instructions: null,
          temperature: null,
          top_p: null,
          tool_choice: null,
          tools: [],
          parallel_tool_calls: true,
          truncation: 'disabled',
        }

        // 只在有实际 usage 数据时才包含 usage（避免全 0 误导）
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

        yield sse('response.completed', {
          type: 'response.completed',
          sequence_number: nextSeq(),
          response: completedResponse,
        })
      }

      // Bug #2 — Error handling must be terminal
      if (partType === 'error' || partType === 'openai-error') {
        const errorData = (part as Record<string, unknown>).error ?? (part as Record<string, unknown>).body
        yield sse('response.error', {
          type: 'response.error',
          sequence_number: nextSeq(),
          error: { type: 'server_error', message: toErrorMessage(errorData) },
        })
        // Terminal event
        yield sse('response.completed', {
          type: 'response.completed',
          sequence_number: nextSeq(),
          response: {
            id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
            model: input.model, status: 'incomplete', output: [], output_text: '',
            instructions: null, temperature: null, top_p: null, tool_choice: null,
            tools: [], parallel_tool_calls: true, truncation: 'disabled',
          },
        })
        return
      }
    }
  } catch (error) {
    yield sse('response.error', {
      type: 'response.error',
      sequence_number: nextSeq(),
      error: { type: 'server_error', message: toErrorMessage(error) },
    })
    yield sse('response.completed', {
      type: 'response.completed',
      sequence_number: nextSeq(),
      response: {
        id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000),
        model: input.model, status: 'incomplete', output: [], output_text: '',
        instructions: null, temperature: null, top_p: null, tool_choice: null,
        tools: [], parallel_tool_calls: true, truncation: 'disabled',
      },
    })
    return
  }
}

// ─── Non-Streaming Renderer ───────────────────────────────────

export function renderOpenAIResponse(input: RenderResultInput): OpenAIResponse {
  const output: ResponseOutputItem[] = []

  // Bug #5 — empty-string text should still produce a message output item
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
      // Bug #9 — avoid double-encoding string args
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

  const response: OpenAIResponse = {
    id: input.response?.id ?? `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object: 'response',
    created_at: Math.floor((input.response?.timestamp?.getTime() ?? Date.now()) / 1000),
    model: input.model,
    status: mapResponseStatus(input.finishReason, input.toolCalls),
    output,
    // Bug #5 — use ?? instead of || for empty-string text
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
