import type { FinishReason, RenderResultInput } from '../protocol-types.js'
import { isRecord } from '../protocol-types.js'
import { extractUsageFromFinishPart } from './renderer-utils.js'

/** 流收集结果，结构与 AI SDK generateText() 返回值兼容 */
export interface CollectedResult {
  text: string
  finishReason?: FinishReason
  usage?: RenderResultInput['usage']
  response?: { id?: string; timestamp?: Date }
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>
}

/**
 * 遍历 AI SDK streamText().fullStream，收集完整结果。
 * 用于 streamOnly provider 的非流式请求适配。
 */
export async function collectStreamResult(stream: AsyncIterable<unknown>): Promise<CollectedResult> {
  let text = ''
  let finishReason: FinishReason | undefined
  let usage: RenderResultInput['usage'] | undefined
  let response: { id?: string; timestamp?: Date } | undefined
  const toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = []

  for await (const chunk of stream) {
    if (!isRecord(chunk)) continue

    switch (chunk.type) {
      case 'text-delta': {
        const delta = typeof chunk.textDelta === 'string' ? chunk.textDelta : ''
        text += delta
        break
      }
      case 'tool-call': {
        const toolCallId = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : ''
        const toolName = typeof chunk.toolName === 'string' ? chunk.toolName : ''
        let input: unknown = chunk.args
        // args 可能是 JSON 字符串，需解析
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input)
          } catch {
            // 防御性：args 为畸形 JSON 时保留原始字符串。实践中 AI SDK 总提供已解析对象。
          }
        }
        toolCalls.push({ toolCallId, toolName, input })
        break
      }
      case 'finish': {
        finishReason = chunk.finishReason as FinishReason
        const extracted = extractUsageFromFinishPart(chunk)
        if (extracted) {
          const u: NonNullable<RenderResultInput['usage']> = {}
          if (extracted.inputTokens !== undefined) u.inputTokens = extracted.inputTokens
          if (extracted.outputTokens !== undefined) u.outputTokens = extracted.outputTokens
          if (extracted.totalTokens !== undefined) u.totalTokens = extracted.totalTokens
          if (extracted.cacheReadTokens !== undefined) u.cacheReadTokens = extracted.cacheReadTokens
          if (extracted.reasoningTokens !== undefined) u.reasoningTokens = extracted.reasoningTokens
          usage = u
        }
        const resp = isRecord(chunk.response) ? chunk.response : undefined
        if (resp) {
          response = {}
          if (typeof resp.id === 'string') response.id = resp.id
          if (resp.timestamp instanceof Date) response.timestamp = resp.timestamp
          else if (typeof resp.timestamp === 'number' || typeof resp.timestamp === 'string')
            response.timestamp = new Date(resp.timestamp)
        }
        // finish 是 fullStream 最后一个 chunk，提前返回避免依赖流关闭的隐式契约
        const finishResult: CollectedResult = { text }
        if (finishReason !== undefined) finishResult.finishReason = finishReason
        if (usage !== undefined) finishResult.usage = usage
        if (response !== undefined) finishResult.response = response
        if (toolCalls.length > 0) finishResult.toolCalls = toolCalls
        return finishResult
      }
    }
  }

  const result: CollectedResult = { text }
  if (finishReason !== undefined) result.finishReason = finishReason
  if (usage !== undefined) result.usage = usage
  if (response !== undefined) result.response = response
  if (toolCalls.length > 0) result.toolCalls = toolCalls

  return result
}
