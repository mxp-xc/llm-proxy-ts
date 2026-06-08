import { randomUUID } from 'node:crypto'
import type { FinishReason, RenderResultInput } from '../protocol-types.js'

export type { FinishReason, RenderResultInput } from '../protocol-types.js'

export interface OpenAIChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: { name: string; arguments: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

export function renderOpenAIChatCompletion(input: RenderResultInput): OpenAIChatCompletion {
  const message: OpenAIChatCompletion['choices'][number]['message'] = {
    role: 'assistant',
    content: input.text || null,
  }

  if (input.toolCalls?.length) {
    message.tool_calls = input.toolCalls.map((call) => ({
      id: call.toolCallId,
      type: 'function',
      function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) },
    }))
  }

  const body: OpenAIChatCompletion = {
    id: input.response?.id ?? `chatcmpl_${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor((input.response?.timestamp?.getTime() ?? Date.now()) / 1000),
    model: input.model,
    choices: [
      { index: 0, message, finish_reason: mapFinishReason(input.finishReason, input.toolCalls) },
    ],
  }

  if (input.usage) {
    body.usage = {}
    if (input.usage.inputTokens !== undefined) body.usage.prompt_tokens = input.usage.inputTokens
    if (input.usage.outputTokens !== undefined)
      body.usage.completion_tokens = input.usage.outputTokens
    if (input.usage.totalTokens !== undefined) body.usage.total_tokens = input.usage.totalTokens
  }

  return body
}

export async function* renderOpenAIChatCompletionSSE(input: {
  model: string
  stream: AsyncIterable<unknown>
}): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  const id = `chatcmpl_${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const toolIndexes = new Map<string, number>()
  const toolCallsWithArgumentDeltas = new Set<string>()

  for await (const part of input.stream) {
    if (!isRecord(part)) continue

    if (part.type === 'text-delta') {
      yield encoder.encode(
        sse({
          id,
          object: 'chat.completion.chunk',
          created,
          model: input.model,
          choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
        }),
      )
    } else if (part.type === 'tool-call-start' || part.type === 'tool-input-start') {
      const toolCallId = toolCallIdValue(part)
      const toolName = stringValue(part.toolName)
      if (!toolCallId || !toolName) continue

      yield encoder.encode(
        sse({
          id,
          object: 'chat.completion.chunk',
          created,
          model: input.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex(toolIndexes, toolCallId),
                    id: toolCallId,
                    type: 'function',
                    function: { name: toolName },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      )
    } else if (
      part.type === 'tool-call-delta' ||
      part.type === 'tool-call-args-delta' ||
      part.type === 'tool-input-delta'
    ) {
      const toolCallId = toolCallIdValue(part)
      const argumentsDelta = stringValue(
        part.argsTextDelta ?? part.inputTextDelta ?? part.argumentsDelta ?? part.delta,
      )
      if (!toolCallId || argumentsDelta === undefined) continue
      toolCallsWithArgumentDeltas.add(toolCallId)

      yield encoder.encode(
        sse({
          id,
          object: 'chat.completion.chunk',
          created,
          model: input.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex(toolIndexes, toolCallId),
                    function: { arguments: argumentsDelta },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      )
    } else if (part.type === 'tool-call') {
      const toolCallId = toolCallIdValue(part)
      const toolName = stringValue(part.toolName)
      if (!toolCallId || !toolName) continue
      const functionCall: { name: string; arguments?: string } = { name: toolName }
      if (!toolCallsWithArgumentDeltas.has(toolCallId)) {
        functionCall.arguments = JSON.stringify(part.input ?? {})
      }

      yield encoder.encode(
        sse({
          id,
          object: 'chat.completion.chunk',
          created,
          model: input.model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex(toolIndexes, toolCallId),
                    id: toolCallId,
                    type: 'function',
                    function: functionCall,
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      )
    } else if (part.type === 'finish') {
      yield encoder.encode(
        sse({
          id,
          object: 'chat.completion.chunk',
          created,
          model: input.model,
          choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(part.finishReason) }],
        }),
      )
    } else if (part.type === 'openai-error') {
      yield encoder.encode(sse(part.body))
      return
    }
  }

  yield encoder.encode('data: [DONE]\n\n')
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function mapFinishReason(reason?: FinishReason | unknown, toolCalls?: unknown[]): string | null {
  if (toolCalls?.length) return 'tool_calls'
  if (reason === 'tool-calls') return 'tool_calls'
  if (reason === 'content-filter') return 'content_filter'
  if (reason === 'stop' || reason === 'length') return reason
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function toolIndex(indexes: Map<string, number>, toolCallId: string): number {
  const existing = indexes.get(toolCallId)
  if (existing !== undefined) return existing
  const index = indexes.size
  indexes.set(toolCallId, index)
  return index
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function toolCallIdValue(part: Record<string, unknown>): string | undefined {
  return stringValue(part.toolCallId ?? part.id)
}
