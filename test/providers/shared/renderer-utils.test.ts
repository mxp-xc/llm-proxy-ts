import { describe, expect, it } from 'vitest'
import { extractUsageFromFinishPart, hasUsageData, flattenUsage } from '../../../src/providers/shared/renderer-utils.js'
import type { ProxyStreamPart } from '../../../src/providers/shared/aisdk-types.js'
import type { LanguageModelUsage } from 'ai'

/** Helper: 创建最小合法的 LanguageModelUsage 对象 */
function usage(overrides: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    ...overrides,
  }
}

/** Helper: 创建最小合法的 finish part（只含必填字段） */
function finishPart(totalUsage: LanguageModelUsage = usage()): Extract<ProxyStreamPart, { type: 'finish' }> {
  return {
    type: 'finish',
    finishReason: 'stop',
    rawFinishReason: undefined,
    totalUsage,
  }
}

describe('extractUsageFromFinishPart', () => {
  it('returns undefined when totalUsage is null', () => {
    // null totalUsage cannot happen with strict typing, but test defensive behavior
    const part = finishPart()
    const result = extractUsageFromFinishPart({ ...part, totalUsage: null as unknown as LanguageModelUsage })
    expect(result).toBeUndefined()
  })

  it('extracts inputTokens and outputTokens', () => {
    const result = extractUsageFromFinishPart(finishPart(
      usage({ inputTokens: 10, outputTokens: 5 }),
    ))
    expect(result).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: undefined,
      cacheReadTokens: undefined,
      reasoningTokens: undefined,
    })
  })

  it('extracts totalTokens', () => {
    const result = extractUsageFromFinishPart(finishPart(
      usage({ inputTokens: 10, outputTokens: 5, totalTokens: 20 }),
    ))
    expect(result!.totalTokens).toBe(20)
  })

  it('extracts cacheReadTokens from inputTokenDetails', () => {
    const result = extractUsageFromFinishPart(finishPart(
      usage({
        inputTokens: 10,
        outputTokens: 5,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: 3,
          cacheWriteTokens: undefined,
        },
      }),
    ))
    expect(result!.cacheReadTokens).toBe(3)
  })

  it('extracts reasoningTokens from outputTokenDetails', () => {
    const result = extractUsageFromFinishPart(finishPart(
      usage({
        inputTokens: 10,
        outputTokens: 5,
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: 7,
        },
      }),
    ))
    expect(result!.reasoningTokens).toBe(7)
  })

  it('returns undefined for fields that are undefined', () => {
    const result = extractUsageFromFinishPart(finishPart(
      usage({ inputTokens: undefined, outputTokens: undefined }),
    ))
    expect(result!.inputTokens).toBeUndefined()
    expect(result!.outputTokens).toBeUndefined()
  })
})

describe('hasUsageData', () => {
  it('returns false for undefined', () => {
    expect(hasUsageData(undefined)).toBe(false)
  })

  it('returns false when both tokens are zero', () => {
    expect(hasUsageData({ inputTokens: 0, outputTokens: 0 })).toBe(false)
  })

  it('returns false when both tokens are undefined', () => {
    expect(hasUsageData({ inputTokens: undefined as number | undefined, outputTokens: undefined as number | undefined })).toBe(false)
  })

  it('returns true when inputTokens > 0', () => {
    expect(hasUsageData({ inputTokens: 5, outputTokens: 0 })).toBe(true)
  })

  it('returns true when outputTokens > 0', () => {
    expect(hasUsageData({ inputTokens: 0, outputTokens: 3 })).toBe(true)
  })
})

describe('flattenUsage', () => {
  it('flattens nested token details to flat shape', () => {
    const result = flattenUsage({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 20,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: 3,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: 7,
      },
    } satisfies LanguageModelUsage)
    expect(result).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 20,
      cacheReadTokens: 3,
      reasoningTokens: 7,
    })
  })

  it('handles missing details', () => {
    const result = flattenUsage({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: {
        textTokens: undefined,
        reasoningTokens: undefined,
      },
    } satisfies LanguageModelUsage)
    expect(result).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    })
  })
})
