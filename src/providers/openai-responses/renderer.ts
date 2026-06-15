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
  ResponseOutputItem,
  ResponseUsage,
  OpenAIResponse,
  OpenAIResponseStreamEvent,
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

// ─── Streaming SSE Renderer ───────────────────────────────────

export async function* renderOpenAIResponseSSE(input: {
  model: string
  stream: AsyncIterable<ProxyStreamPart>
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
  const streamedToolCalls: ResponseFunctionToolCall[] = []

  const toolCallFcIds = new Map<string, string>()
  const toolCallsWithArgumentDeltas = new Set<string>()
  const toolCallStartEmitted = new Set<string>()

  function nextSeq(): number {
    return ++sequenceNumber
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
        if (!delta) continue

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
            item: { id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: fullReasoning }] },
          } }
          outputIndex++
          reasoningItemStarted = false
          fullReasoning = ''
        }
      }

      if (part.type === 'tool-input-start') {
        const toolCallId = part.id
        const toolName = part.toolName
        const fcId = `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        toolCallFcIds.set(toolCallId, fcId)

        if (contentPartStarted) {
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

        yield { event: 'response.output_item.added', data: {
          type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex,
          item: { id: fcId, type: 'function_call', status: 'in_progress', call_id: toolCallId, name: toolName, arguments: '' },
        } }
        toolCallStartEmitted.add(toolCallId)
      }

      if (part.type === 'tool-input-delta') {
        const toolCallId = part.id
        const argsDelta = part.delta
        if (!toolCallId || !argsDelta) continue

        toolCallsWithArgumentDeltas.add(toolCallId)
        const fcId = toolCallFcIds.get(toolCallId) ?? `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`

        yield { event: 'response.function_call_arguments.delta', data: {
          type: 'response.function_call_arguments.delta', sequence_number: nextSeq(),
          item_id: fcId, output_index: outputIndex, delta: argsDelta,
        } }
      }

      if (part.type === 'tool-call') {
        const toolCallId = part.toolCallId
        const toolName = part.toolName
        const fcId = toolCallFcIds.get(toolCallId) ?? `fc_${randomUUID().replace(/-/g, '').slice(0, 24)}`

        if (contentPartStarted) {
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

        const rawArgs = part.args ?? {}
        const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)

        if (!toolCallStartEmitted.has(toolCallId)) {
          yield { event: 'response.output_item.added', data: {
            type: 'response.output_item.added', sequence_number: nextSeq(), output_index: outputIndex,
            item: { id: fcId, type: 'function_call', status: 'in_progress', call_id: toolCallId, name: toolName, arguments: '' },
          } }
        }

        if (!toolCallsWithArgumentDeltas.has(toolCallId)) {
          yield { event: 'response.function_call_arguments.delta', data: {
            type: 'response.function_call_arguments.delta', sequence_number: nextSeq(),
            item_id: fcId, output_index: outputIndex, delta: args,
          } }
        }

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
        outputIndex++
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
            item: { id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: fullReasoning }] },
          } }
          outputIndex++
          reasoningItemStarted = false
          fullReasoning = ''
        }
        if (contentPartStarted) {
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
        }
        if (outputItemStarted) {
          yield { event: 'response.output_item.done', data: {
            type: 'response.output_item.done',
            sequence_number: nextSeq(),
            output_index: outputIndex,
            item: { id: currentMsgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] },
          } }
        }

        const finishReason = part.finishReason
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
