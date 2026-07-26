import { randomUUID } from 'node:crypto'
import { toErrorMessage, type FinishReason, type RenderResultInput } from '../protocol-types.js'
import { extractUsageFromFinishPart, hasUsageData } from '../shared/renderer-utils.js'
import type { SSEFrame, SSEOutput } from '../shared/sse-utils.js'
import type { ProxyStreamPart } from '../shared/aisdk-types.js'
import type {
  AnthropicMessageResponse,
  AnthropicResponseContentBlock,
  AnthropicSSEData,
  AnthropicSSEMessageDelta,
  AnthropicSSEToolUseContentBlock,
  AnthropicSSETextContentBlock,
  AnthropicStopReason,
} from './types.js'

export type { FinishReason, RenderResultInput } from '../protocol-types.js'

// ─── Non-Streaming Renderer ────────────────────────────────────

export function renderAnthropicMessage(input: RenderResultInput): AnthropicMessageResponse {
  const content: AnthropicResponseContentBlock[] = []

  if (input.text) {
    content.push({ type: 'text', text: input.text })
  }

  if (input.toolCalls?.length) {
    for (const call of input.toolCalls) {
      content.push({
        type: 'tool_use',
        id: call.toolCallId,
        name: call.toolName,
        input: (call.input as Record<string, unknown>) ?? {},
      })
    }
  }

  // Anthropic API 要求 usage 字段始终存在；无数据时使用默认零值
  const usage: AnthropicMessageResponse['usage'] = hasUsageData(input.usage)
    ? { input_tokens: input.usage!.inputTokens ?? 0, output_tokens: input.usage!.outputTokens ?? 0 }
    : { input_tokens: 0, output_tokens: 0 }

  return {
    id: input.response?.id ?? `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: input.model,
    content,
    stop_reason: mapStopReason(input.finishReason, input.toolCalls),
    stop_sequence: null,
    usage,
  }
}

// ─── Streaming SSE Renderer ────────────────────────────────────

export async function* renderAnthropicMessageSSE(input: {
  model: string
  stream: AsyncIterable<ProxyStreamPart>
}): AsyncIterable<SSEOutput<AnthropicSSEData>> {
  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

  let messageStarted = false
  let currentBlockIndex = -1
  let currentBlockType: 'text' | 'tool_use' | null = null
  type PendingToolCall = {
    name: string
    deltas: string[]
    complete: boolean
  }
  const pendingToolCalls = new Map<string, PendingToolCall>()

  function emitMessageStart(): SSEFrame<AnthropicSSEData> {
    messageStarted = true
    return {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [],
          model: input.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 1 },
        },
      },
    }
  }

  function emitBlockStart(
    type: 'text' | 'tool_use',
    block: AnthropicSSETextContentBlock | AnthropicSSEToolUseContentBlock,
  ): SSEFrame<AnthropicSSEData> {
    currentBlockIndex++
    currentBlockType = type
    return {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: currentBlockIndex,
        content_block: block,
      },
    }
  }

  function emitBlockStop(): SSEFrame<AnthropicSSEData> | null {
    if (currentBlockType === null) return null
    const result: SSEFrame<AnthropicSSEData> = {
      event: 'content_block_stop',
      data: {
        type: 'content_block_stop',
        index: currentBlockIndex,
      },
    }
    currentBlockType = null
    return result
  }

  function queueToolCall(id: string, name: string): PendingToolCall {
    const existing = pendingToolCalls.get(id)
    if (existing) return existing
    const pending = { name, deltas: [], complete: false }
    pendingToolCalls.set(id, pending)
    return pending
  }

  function* emitPendingToolCalls(force: boolean): Generator<SSEFrame<AnthropicSSEData>> {
    for (const [id, pending] of pendingToolCalls) {
      if (!force && !pending.complete) return
      pendingToolCalls.delete(id)
      const stopChunk = emitBlockStop()
      if (stopChunk) yield stopChunk
      yield emitBlockStart('tool_use', {
        type: 'tool_use',
        id,
        name: pending.name,
        input: {},
      })
      for (const partialJson of pending.deltas) {
        yield {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'input_json_delta', partial_json: partialJson },
          },
        }
      }
      const toolStopChunk = emitBlockStop()
      if (toolStopChunk) yield toolStopChunk
    }
  }

  function* emitTerminalError(message: string): Generator<SSEFrame<AnthropicSSEData>> {
    if (!messageStarted) yield emitMessageStart()
    yield* emitPendingToolCalls(true)
    const stopChunk = emitBlockStop()
    if (stopChunk) yield stopChunk
    yield {
      event: 'error',
      data: {
        type: 'error',
        error: { type: 'api_error', message },
      },
    }
    yield { event: 'message_stop', data: { type: 'message_stop' } }
  }

  try {
    for await (const part of input.stream) {
      if (part.type === 'text-delta') {
        if (!messageStarted) yield emitMessageStart()

        if (currentBlockType !== 'text') {
          const stopChunk = emitBlockStop()
          if (stopChunk) yield stopChunk
          yield emitBlockStart('text', { type: 'text', text: '' })
        }

        yield {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'text_delta', text: part.text },
          },
        }
      } else if (part.type === 'tool-input-start') {
        if (!messageStarted) yield emitMessageStart()
        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk
        queueToolCall(part.id, part.toolName)
      } else if (part.type === 'tool-input-delta') {
        pendingToolCalls.get(part.id)?.deltas.push(part.delta)
      } else if (part.type === 'tool-call') {
        if (!messageStarted) yield emitMessageStart()
        const pending = queueToolCall(part.toolCallId, part.toolName)
        if (pending.deltas.length === 0) pending.deltas.push(JSON.stringify(part.input ?? {}))
        pending.complete = true
        yield* emitPendingToolCalls(false)
      } else if (part.type === 'finish') {
        if (!messageStarted) yield emitMessageStart()
        yield* emitPendingToolCalls(true)
        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk

        const stopReason = mapStopReason(part.finishReason)
        const usage = extractUsageFromFinishPart(part)

        const messageDelta: AnthropicSSEMessageDelta = {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
        }
        if (usage && hasUsageData(usage)) {
          messageDelta.usage = {
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
          }
        }

        yield { event: 'message_delta', data: messageDelta }

        yield { event: 'message_stop', data: { type: 'message_stop' } }
        return
      } else if (part.type === 'openai-error') {
        yield* emitTerminalError(toErrorMessage(part.body))
        return
      } else if (part.type === 'error') {
        yield* emitTerminalError(toErrorMessage(part.error))
        return
      }
    }

    yield* emitTerminalError('Upstream stream ended before a terminal event')
  } catch (error) {
    yield* emitTerminalError(toErrorMessage(error))
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function mapStopReason(
  reason?: FinishReason | unknown,
  toolCalls?: unknown[],
): AnthropicStopReason {
  if (toolCalls?.length) return 'tool_use'
  if (reason === 'tool-calls') return 'tool_use'
  if (reason === 'stop') return 'end_turn'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content-filter') return 'refusal'
  return 'end_turn'
}
