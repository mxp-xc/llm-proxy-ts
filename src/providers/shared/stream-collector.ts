import type { ProviderMetadata } from 'ai'
import type { FinishReason, RenderResultInput } from '../protocol-types.js'
import { extractUsageFromFinishPart } from './renderer-utils.js'
import type { ProxyStreamPart } from './aisdk-types.js'

/** 流收集结果，结构与 AI SDK generateText() 返回值兼容 */
export interface CollectedResult {
  text: string
  finishReason?: FinishReason
  usage?: RenderResultInput['usage']
  response?: { id?: string; timestamp?: Date }
  toolCalls?: Array<{
    toolCallId: string
    toolName: string
    input: unknown
    providerExecuted?: boolean
    providerMetadata?: ProviderMetadata
  }>
}

/**
 * 遍历 AI SDK streamText().fullStream，收集完整结果。
 * 用于 streamOnly provider 的非流式请求适配。
 */
export async function collectStreamResult(
  stream: AsyncIterable<ProxyStreamPart>,
): Promise<CollectedResult> {
  let text = ''
  let finishReason: FinishReason | undefined
  let usage: RenderResultInput['usage'] | undefined
  let response: { id?: string; timestamp?: Date } | undefined
  const toolCalls: Array<{
    toolCallId: string
    toolName: string
    input: unknown
    providerExecuted?: boolean
    providerMetadata?: ProviderMetadata
  }> = []

  for await (const part of stream) {
    switch (part.type) {
      case 'text-delta': {
        text += part.text
        break
      }
      case 'tool-call': {
        let input: unknown = part.input
        // input 可能是 JSON 字符串，需解析
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input)
          } catch {
            // 防御性：input 为畸形 JSON 时保留原始字符串。实践中 AI SDK 总提供已解析对象。
          }
        }
        const call: {
          toolCallId: string
          toolName: string
          input: unknown
          providerExecuted?: boolean
          providerMetadata?: ProviderMetadata
        } = {
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input,
        }
        if (part.providerExecuted) call.providerExecuted = true
        if (part.providerMetadata) call.providerMetadata = part.providerMetadata
        toolCalls.push(call)
        break
      }
      case 'error':
        throw part.error
      case 'openai-error':
        throw Object.assign(new Error('Upstream stream error'), {
          ...(part.status !== undefined && { statusCode: part.status }),
        })
      case 'abort':
        throw Object.assign(new Error(part.reason ?? 'Upstream stream aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        })
      case 'finish': {
        finishReason = part.finishReason
        const extracted = extractUsageFromFinishPart(part)
        if (extracted) {
          const u: NonNullable<RenderResultInput['usage']> = {}
          if (extracted.inputTokens !== undefined) u.inputTokens = extracted.inputTokens
          if (extracted.outputTokens !== undefined) u.outputTokens = extracted.outputTokens
          if (extracted.totalTokens !== undefined) u.totalTokens = extracted.totalTokens
          if (extracted.cacheReadTokens !== undefined) u.cacheReadTokens = extracted.cacheReadTokens
          if (extracted.reasoningTokens !== undefined) u.reasoningTokens = extracted.reasoningTokens
          usage = u
        }
        const resp = part.response
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

  throw Object.assign(new Error('Upstream stream ended without a finish chunk'), {
    name: 'IncompleteStreamError',
  })
}
