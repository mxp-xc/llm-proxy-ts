import { isRecord } from '../protocol-types.js'
import type { RenderResultInput } from '../protocol-types.js'

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
export function extractUsageFromFinishPart(part: Record<string, unknown>): ExtractedUsage | undefined {
  const totalUsage = part.totalUsage
  if (!isRecord(totalUsage)) return undefined

  const inputTokenDetails = isRecord(totalUsage.inputTokenDetails) ? totalUsage.inputTokenDetails : undefined
  const outputTokenDetails = isRecord(totalUsage.outputTokenDetails) ? totalUsage.outputTokenDetails : undefined

  return {
    inputTokens: typeof totalUsage.inputTokens === 'number' ? totalUsage.inputTokens : undefined,
    outputTokens: typeof totalUsage.outputTokens === 'number' ? totalUsage.outputTokens : undefined,
    totalTokens: typeof totalUsage.totalTokens === 'number' ? totalUsage.totalTokens : undefined,
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
