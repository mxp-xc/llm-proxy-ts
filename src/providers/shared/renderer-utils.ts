import type { RenderResultInput } from '../protocol-types.js'
import type { ProxyStreamPart } from './aisdk-types.js'

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function toolCallIdValue(part: Record<string, unknown>): string | undefined {
  return stringValue(part.toolCallId ?? part.id)
}

/** extractUsageFromFinishPart 的返回类型 */
export interface ExtractedUsage {
  inputTokens: number | undefined
  outputTokens: number | undefined
  totalTokens: number | undefined
  cacheReadTokens: number | undefined
  reasoningTokens: number | undefined
}

/** 从 AI SDK finish part 提取 token usage（AI SDK v6: totalUsage: LanguageModelUsage）
 *  - 返回 undefined 表示完全无 usage 数据（totalUsage 不存在）
 *  - 各字段 undefined 表示上游未报告该项 */
export function extractUsageFromFinishPart(
  part: Extract<ProxyStreamPart, { type: 'finish' }> | Record<string, unknown>,
): ExtractedUsage | undefined {
  const totalUsage = 'totalUsage' in part ? part.totalUsage : undefined
  if (totalUsage === undefined || totalUsage === null || typeof totalUsage !== 'object') return undefined

  const tu = totalUsage as Record<string, unknown>
  const inputTokenDetails = typeof tu.inputTokenDetails === 'object' && tu.inputTokenDetails !== null
    ? tu.inputTokenDetails as Record<string, unknown>
    : undefined
  const outputTokenDetails = typeof tu.outputTokenDetails === 'object' && tu.outputTokenDetails !== null
    ? tu.outputTokenDetails as Record<string, unknown>
    : undefined

  return {
    inputTokens: typeof tu.inputTokens === 'number' ? tu.inputTokens : undefined,
    outputTokens: typeof tu.outputTokens === 'number' ? tu.outputTokens : undefined,
    totalTokens: typeof tu.totalTokens === 'number' ? tu.totalTokens : undefined,
    cacheReadTokens:
      inputTokenDetails && typeof inputTokenDetails.cacheReadTokens === 'number'
        ? inputTokenDetails.cacheReadTokens
        : undefined,
    reasoningTokens:
      outputTokenDetails && typeof outputTokenDetails.reasoningTokens === 'number'
        ? outputTokenDetails.reasoningTokens
        : undefined,
  }
}

/** 判断是否有实际 usage 数据（至少一个 token 计数 > 0）
 *  接受 ExtractedUsage（SSE 路径）或 RenderResultInput['usage']（非流式路径） */
export function hasUsageData(usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined): boolean {
  if (usage === undefined) return false
  return (usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0
}

/** 将 AI SDK LanguageModelUsage（嵌套 details）展平为 RenderResultInput['usage'] */
export function flattenUsage(
  usage: {
    inputTokens: number | undefined
    outputTokens: number | undefined
    totalTokens: number | undefined
    inputTokenDetails?: { cacheReadTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  },
): NonNullable<RenderResultInput['usage']> {
  const result: NonNullable<RenderResultInput['usage']> = {}
  if (usage.inputTokens !== undefined) result.inputTokens = usage.inputTokens
  if (usage.outputTokens !== undefined) result.outputTokens = usage.outputTokens
  if (usage.totalTokens !== undefined) result.totalTokens = usage.totalTokens
  if (usage.inputTokenDetails?.cacheReadTokens !== undefined) result.cacheReadTokens = usage.inputTokenDetails.cacheReadTokens
  if (usage.outputTokenDetails?.reasoningTokens !== undefined) result.reasoningTokens = usage.outputTokenDetails.reasoningTokens
  return result
}
