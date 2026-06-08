import { randomUUID } from 'node:crypto'
import type { FinishReason, RenderResultInput } from '../protocol-types.js'
import type {
  AnthropicMessageResponse,
  AnthropicResponseContentBlock,
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
        input: call.input ?? {},
      })
    }
  }

  const usage: AnthropicMessageResponse['usage'] = {
    input_tokens: input.usage?.inputTokens ?? 0,
    output_tokens: input.usage?.outputTokens ?? 0,
  }

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
  stream: AsyncIterable<unknown>
}): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  const id = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

  let messageStarted = false
  let currentBlockIndex = -1
  let currentBlockType: 'text' | 'tool_use' | null = null
  const toolCallBlockIndexes = new Map<string, number>()

  function emitMessageStart(): Uint8Array {
    messageStarted = true
    return encoder.encode(
      anthropicSSE('message_start', {
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
      }),
    )
  }

  function emitBlockStart(type: 'text' | 'tool_use', block: Record<string, unknown>): Uint8Array {
    currentBlockIndex++
    currentBlockType = type
    return encoder.encode(
      anthropicSSE('content_block_start', {
        type: 'content_block_start',
        index: currentBlockIndex,
        content_block: block,
      }),
    )
  }

  function emitBlockStop(): Uint8Array | null {
    if (currentBlockType === null) return null
    const result = encoder.encode(
      anthropicSSE('content_block_stop', {
        type: 'content_block_stop',
        index: currentBlockIndex,
      }),
    )
    currentBlockType = null
    return result
  }

  try {
    for await (const part of input.stream) {
      if (!isRecord(part)) continue

      if (part.type === 'text-delta') {
        if (!messageStarted) yield emitMessageStart()

        // 如果没有打开的 text block，先打开一个
        if (currentBlockType !== 'text') {
          const stopChunk = emitBlockStop()
          if (stopChunk) yield stopChunk
          yield emitBlockStart('text', { type: 'text', text: '' })
        }

        yield encoder.encode(
          anthropicSSE('content_block_delta', {
            type: 'content_block_delta',
            index: currentBlockIndex,
            delta: { type: 'text_delta', text: stringValue(part.text) ?? '' },
          }),
        )
      } else if (part.type === 'tool-call-start' || part.type === 'tool-input-start') {
        if (!messageStarted) yield emitMessageStart()

        const toolCallId = toolCallIdValue(part)
        const toolName = stringValue(part.toolName)
        if (!toolCallId || !toolName) continue

        // 关闭当前 block（如果有），开启新的 tool_use block
        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk
        toolCallBlockIndexes.set(toolCallId, currentBlockIndex + 1)
        yield emitBlockStart('tool_use', {
          type: 'tool_use',
          id: toolCallId,
          name: toolName,
          input: {},
        })
      } else if (
        part.type === 'tool-call-delta' ||
        part.type === 'tool-call-args-delta' ||
        part.type === 'tool-input-delta'
      ) {
        const toolCallId = toolCallIdValue(part)
        const argsDelta = stringValue(
          part.argsTextDelta ?? part.inputTextDelta ?? part.argumentsDelta ?? part.delta,
        )
        if (!toolCallId || argsDelta === undefined) continue

        const blockIndex = toolCallBlockIndexes.get(toolCallId) ?? currentBlockIndex

        yield encoder.encode(
          anthropicSSE('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: argsDelta },
          }),
        )
      } else if (part.type === 'tool-call') {
        if (!messageStarted) yield emitMessageStart()

        const toolCallId = toolCallIdValue(part)
        const toolName = stringValue(part.toolName)
        if (!toolCallId || !toolName) continue

        // 如果这个 tool call 没有通过 start 事件打开过 block
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

          // emit 完整的 input 作为单个 delta
          const inputJson = JSON.stringify(part.input ?? {})
          yield encoder.encode(
            anthropicSSE('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'input_json_delta', partial_json: inputJson },
            }),
          )
        }

        // 关闭 tool_use block
        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk
      } else if (part.type === 'finish') {
        if (!messageStarted) yield emitMessageStart()
        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk

        const stopReason = mapStopReason(part.finishReason as FinishReason | undefined)
        const outputTokens =
          typeof part.totalTokens === 'number'
            ? part.totalTokens
            : typeof part.outputTokens === 'number'
              ? part.outputTokens
              : 0

        yield encoder.encode(
          anthropicSSE('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
          }),
        )

        yield encoder.encode(anthropicSSE('message_stop', { type: 'message_stop' }))
        return
      } else if (part.type === 'openai-error') {
        if (!messageStarted) yield emitMessageStart()
        const stopChunk = emitBlockStop()
        if (stopChunk) yield stopChunk
        yield encoder.encode(
          anthropicSSE('error', {
            type: 'error',
            error: { type: 'api_error', message: JSON.stringify(part.body) },
          }),
        )
        return
      }
    }

    // 如果流正常结束但无 finish part，仍需发送 message_stop
    if (!messageStarted) yield emitMessageStart()
    const stopChunk = emitBlockStop()
    if (stopChunk) yield stopChunk
    yield encoder.encode(
      anthropicSSE('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 0 },
      }),
    )
    yield encoder.encode(anthropicSSE('message_stop', { type: 'message_stop' }))
  } catch (error) {
    if (!messageStarted) yield emitMessageStart()
    const stopChunk = emitBlockStop()
    if (stopChunk) yield stopChunk
    const message = error instanceof Error ? error.message : String(error)
    yield encoder.encode(
      anthropicSSE('error', {
        type: 'error',
        error: { type: 'api_error', message },
      }),
    )
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function anthropicSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function toolCallIdValue(part: Record<string, unknown>): string | undefined {
  return stringValue(part.toolCallId ?? part.id)
}
