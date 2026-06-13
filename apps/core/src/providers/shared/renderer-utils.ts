import { isRecord } from '../protocol-types.js'

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function toolCallIdValue(part: Record<string, unknown>): string | undefined {
  return stringValue(part.toolCallId ?? part.id)
}

/** 从 AI SDK finish part 提取 token usage（AI SDK v6: totalUsage: LanguageModelUsage） */
export function extractUsageFromFinishPart(part: Record<string, unknown>): {
  inputTokens: number
  outputTokens: number
} {
  const totalUsage = part.totalUsage
  if (isRecord(totalUsage)) {
    return {
      inputTokens: typeof totalUsage.inputTokens === 'number' ? totalUsage.inputTokens : 0,
      outputTokens: typeof totalUsage.outputTokens === 'number' ? totalUsage.outputTokens : 0,
    }
  }
  return { inputTokens: 0, outputTokens: 0 }
}
