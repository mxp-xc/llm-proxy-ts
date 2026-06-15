import { describe, expect, it } from 'vitest'
import { formatLimitNum } from '../../src/cli/models-list.js'

describe('formatLimitNum', () => {
  it('returns "-" for undefined', () => {
    expect(formatLimitNum(undefined)).toBe('-')
  })

  it('returns "0" for 0', () => {
    expect(formatLimitNum(0)).toBe('0')
  })

  it('returns "1M" for 1_048_576', () => {
    expect(formatLimitNum(1_048_576)).toBe('1M')
  })

  it('returns "8M" for 8_388_608', () => {
    expect(formatLimitNum(8_388_608)).toBe('8M')
  })

  it('returns "4K" for 4096', () => {
    expect(formatLimitNum(4096)).toBe('4K')
  })

  it('returns "125K" for 128000', () => {
    expect(formatLimitNum(128000)).toBe('125K')
  })

  it('returns raw number for non-round values', () => {
    expect(formatLimitNum(200000)).toBe('200000')
  })

  it('returns "1" for 1', () => {
    expect(formatLimitNum(1)).toBe('1')
  })
})
