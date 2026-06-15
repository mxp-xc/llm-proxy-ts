import { randomUUID } from 'node:crypto'
import { toErrorMessage } from '../protocol-types.js'
import { extractUsageFromFinishPart, hasUsageData } from '../shared/renderer-utils.js'
import type { SSEOutput } from '../shared/sse-utils.js'
import type { FinishReason, RenderResultInput } from '../protocol-types.js'
import type { ProxyStreamPart } from '../shared/aisdk-types.js'
import type { OpenAIChatCompletion, OpenAIChatChunk, OpenAIChatStreamError } from './types.js'

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

  if (input.usage && hasUsageData(input.usage)) {
    const promptTokens = input.usage.inputTokens
    const completionTokens = input.usage.outputTokens
    const totalTokens =
      input.usage.totalTokens ??
      (promptTokens != null && completionTokens != null ? promptTokens + completionTokens : undefined)

    body.usage = {}
    if (promptTokens !== undefined) body.usage.prompt_tokens = promptTokens
    if (completionTokens !== undefined) body.usage.completion_tokens = completionTokens
    if (totalTokens !== undefined) body.usage.total_tokens = totalTokens
  }

  return body
}

export async function* renderOpenAIChatCompletionSSE(input: {
  model: string
  stream: AsyncIterable<ProxyStreamPart>
}): AsyncIterable<SSEOutput<OpenAIChatChunk | OpenAIChatStreamError>> {
  const id = `chatcmpl_${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const toolIndexes = new Map<string, number>()
  const toolCallsWithArgumentDeltas = new Set<string>()

  for await (const part of input.stream) {
    if (part.type === 'text-delta') {
      yield {
        data: {
          id,
          object: 'chat.completion.chunk',
          created,
          model: input.model,
          choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
        },
      }
    } else if (part.type === 'tool-input-start') {
      const toolCallId = part.id
      const toolName = part.toolName

      yield {
        data: {
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
        },
      }
    } else if (part.type === 'tool-input-delta') {
      const toolCallId = part.id
      const argumentsDelta = part.delta
      toolCallsWithArgumentDeltas.add(toolCallId)

      yield {
        data: {
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
        },
      }
    } else if (part.type === 'tool-call') {
      const toolCallId = part.toolCallId
      const toolName = part.toolName
      const functionCall: { name: string; arguments?: string } = { name: toolName }
      if (!toolCallsWithArgumentDeltas.has(toolCallId)) {
        functionCall.arguments = JSON.stringify(part.args ?? {})
      }

      yield {
        data: {
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
        },
      }
    } else if (part.type === 'finish') {
      const usage = extractUsageFromFinishPart(part)
      const finishChunk: OpenAIChatChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: input.model,
        choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(part.finishReason) }],
      }
      if (usage && hasUsageData(usage)) {
        const promptTokens = usage.inputTokens ?? 0
        const completionTokens = usage.outputTokens ?? 0
        finishChunk.usage = {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: usage.totalTokens ?? (promptTokens + completionTokens),
        }
      }
      yield { data: finishChunk }
    } else if (part.type === 'openai-error') {
      yield { data: part.body as OpenAIChatStreamError }
      yield { type: 'done' as const }
      return
    } else if (part.type === 'error') {
      yield {
        data: {
          error: {
            type: 'upstream_error',
            code: 'stream_internal_error',
            message: toErrorMessage(part.error),
          },
        },
      }
      yield { type: 'done' as const }
      return
    }
  }

  yield { type: 'done' as const }
}

function mapFinishReason(reason?: FinishReason | unknown, toolCalls?: unknown[]): string | null {
  if (toolCalls?.length) return 'tool_calls'
  if (reason === 'tool-calls') return 'tool_calls'
  if (reason === 'content-filter') return 'content_filter'
  if (reason === 'stop' || reason === 'length') return reason
  return null
}


function toolIndex(indexes: Map<string, number>, toolCallId: string): number {
  const existing = indexes.get(toolCallId)
  if (existing !== undefined) return existing
  const index = indexes.size
  indexes.set(toolCallId, index)
  return index
}
