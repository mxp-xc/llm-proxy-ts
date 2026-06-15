import { describe, expect, it } from 'vitest'
import { extractUsageFromFinishPart, hasUsageData, flattenUsage } from '../../../src/providers/shared/renderer-utils.js'

describe('extractUsageFromFinishPart', () => {
  it('returns undefined when totalUsage is absent', () => {
    const result = extractUsageFromFinishPart({ type: 'finish', finishReason: 'stop' })
    expect(result).toBeUndefined()
  })

  it('returns undefined when totalUsage is not a record', () => {
    const result = extractUsageFromFinishPart({ type: 'finish', totalUsage: 'bad' })
    expect(result).toBeUndefined()
  })

  it('extracts inputTokens and outputTokens', () => {
    const result = extractUsageFromFinishPart({
      type: 'finish',
      totalUsage: { inputTokens: 10, outputTokens: 5 },
    })
    expect(result).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: undefined,
      cacheReadTokens: undefined,
      reasoningTokens: undefined,
    })
  })

  it('extracts totalTokens', () => {
    const result = extractUsageFromFinishPart({
      type: 'finish',
      totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 20 },
    })
    expect(result!.totalTokens).toBe(20)
  })

  it('extracts cacheReadTokens from inputTokenDetails', () => {
    const result = extractUsageFromFinishPart({
      type: 'finish',
      totalUsage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheReadTokens: 3 } },
    })
    expect(result!.cacheReadTokens).toBe(3)
  })

  it('extracts reasoningTokens from outputTokenDetails', () => {
    const result = extractUsageFromFinishPart({
      type: 'finish',
      totalUsage: { inputTokens: 10, outputTokens: 5, outputTokenDetails: { reasoningTokens: 7 } },
    })
    expect(result!.reasoningTokens).toBe(7)
  })

  it('returns undefined for fields that are not numbers', () => {
    const result = extractUsageFromFinishPart({
      type: 'finish',
      totalUsage: { inputTokens: undefined, outputTokens: null },
    })
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
      inputTokenDetails: { cacheReadTokens: 3 },
      outputTokenDetails: { reasoningTokens: 7 },
    })
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
    })
    expect(result).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    })
  })
})
