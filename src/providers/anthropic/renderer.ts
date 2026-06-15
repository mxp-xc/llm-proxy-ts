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
  const toolCallBlockIndexes = new Map<string, number>()

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

        const toolCallId = part.id
        const toolName = part.toolName

        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk
        toolCallBlockIndexes.set(toolCallId, currentBlockIndex + 1)
        yield emitBlockStart('tool_use', {
          type: 'tool_use',
          id: toolCallId,
          name: toolName,
          input: {},
        })
      } else if (part.type === 'tool-input-delta') {
        const toolCallId = part.id
        const argsDelta = part.delta

        const blockIndex = toolCallBlockIndexes.get(toolCallId) ?? currentBlockIndex

        yield {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: argsDelta },
          },
        }
      } else if (part.type === 'tool-call') {
        if (!messageStarted) yield emitMessageStart()

        const toolCallId = part.toolCallId
        const toolName = part.toolName

        if (!toolCallBlockIndexes.has(toolCallId)) {
          const stopChunk = emitBlockStop()
          if (stopChunk) yield stopChunk
          toolCallBlockIndexes.set(toolCallId, currentBlockIndex + 1)
          yield emitBlockStart('tool_use', {
            type: 'tool_use',
            id: toolCallId,
            name: toolName,
            input: {},
          })

          const inputJson = JSON.stringify(part.args ?? {})
          yield {
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'input_json_delta', partial_json: inputJson },
            },
          }
        }

        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk
      } else if (part.type === 'finish') {
        if (!messageStarted) yield emitMessageStart()
        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk

        const stopReason = mapStopReason(part.finishReason)
        const usage = extractUsageFromFinishPart(part)

        const messageDelta: AnthropicSSEMessageDelta = {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
        }
        if (usage && hasUsageData(usage)) {
          messageDelta.usage = { input_tokens: usage.inputTokens ?? 0, output_tokens: usage.outputTokens ?? 0 }
        }

        yield { event: 'message_delta', data: messageDelta }

        yield { event: 'message_stop', data: { type: 'message_stop' } }
        return
      } else if (part.type === 'openai-error') {
        if (!messageStarted) yield emitMessageStart()
        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk
        yield {
          event: 'error',
          data: {
            type: 'error',
            error: { type: 'api_error', message: JSON.stringify(part.body) },
          },
        }
        yield { event: 'message_stop', data: { type: 'message_stop' } }
        return
      } else if (part.type === 'error') {
        if (!messageStarted) yield emitMessageStart()
        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk
        yield {
          event: 'error',
          data: {
            type: 'error',
            error: {
              type: 'api_error',
              message: toErrorMessage(part.error),
            },
          },
        }
        yield { event: 'message_stop', data: { type: 'message_stop' } }
        return
      }
    }

    if (!messageStarted) yield emitMessageStart()
    const stopChunk = emitBlockStop()
    if (stopChunk) yield stopChunk
    yield {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
      },
    }
    yield { event: 'message_stop', data: { type: 'message_stop' } }
  } catch (error) {
    if (!messageStarted) yield emitMessageStart()
    const stopChunk = emitBlockStop()
    if (stopChunk) yield stopChunk
    const message = toErrorMessage(error)
    yield {
      event: 'error',
      data: {
        type: 'error',
        error: { type: 'api_error', message },
      },
    }
    yield { event: 'message_stop', data: { type: 'message_stop' } }
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
