import { describe, expect, it } from 'vitest'
import { formatLimitNum, renderRows } from '../../src/cli/models/list.js'
import type { ModelRow } from '../../src/cli/models/list.js'

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

describe('renderRows', () => {
  const row = (overrides: Partial<ModelRow> = {}): ModelRow => ({
    id: 'p/m',
    provider: 'p',
    upstreamModel: 'up',
    aliases: [],
    modelFlat: false,
    limit: undefined,
    ...overrides,
  })

  it('empty aliases → single data row with "-" in Aliases', () => {
    const lines = renderRows([row()])
    expect(lines[0]).toContain('ID')
    expect(lines[1]).toMatch(/─/)
    expect(lines[2]).toContain('p/m')
    expect(lines[2]).toContain('-')
    expect(lines).toHaveLength(3)
  })

  it('3 aliases (one bare) → 3 data rows, single-value cols vertically centered on middle row, * on bare', () => {
    const lines = renderRows([
      row({
        aliases: [
          { name: 'a1', flat: false },
          { name: 'a2', flat: true },
          { name: 'a3', flat: false },
        ],
        modelFlat: false,
      }),
    ])
    expect(lines).toHaveLength(5) // header + sep + 3 data rows
    const top = 1 // floor((3-1)/2)
    const dataStart = 2
    // 单值列只在中间行(top)出现 'p/m',其余行不含
    expect(lines[dataStart + 0]).not.toMatch(/p\/m/)
    expect(lines[dataStart + top]).toMatch(/p\/m/)
    expect(lines[dataStart + 2]).not.toMatch(/p\/m/)
    // alias 列:a1 / a2 * / a3(aliases 非末列,不用 $ 锚定)
    expect(lines[dataStart + 0]).toMatch(/a1/)
    expect(lines[dataStart + 1]).toMatch(/a2 \*/)
    expect(lines[dataStart + 2]).toMatch(/a3/)
    // a1 行不应出现 a2/a3,避免误匹配
    expect(lines[dataStart + 0]).not.toMatch(/a2/)
    expect(lines[dataStart + 2]).not.toMatch(/a2/)
  })

  it('model.flat=true marks all aliases bare', () => {
    const lines = renderRows([row({ aliases: [{ name: 'a', flat: false }], modelFlat: true })])
    expect(lines[2]).toMatch(/a \*/)
  })
})
