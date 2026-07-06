import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatLimitNum, renderRows, runModelsList } from '../../src/cli/models/list-run.js'
import type { ModelRow } from '../../src/cli/models/list-run.js'

describe('formatLimitNum', () => {
  it('returns "-" for undefined', () => {
    expect(formatLimitNum(undefined)).toBe('-')
  })

  it('returns "0" for 0', () => {
    expect(formatLimitNum(0)).toBe('0')
  })

  it('returns floored decimal M for values at least 1_000_000', () => {
    expect(formatLimitNum(1_048_576)).toBe('1M')
    expect(formatLimitNum(1_999_999)).toBe('1M')
  })

  it('returns "8M" for 8_388_608 using decimal floor', () => {
    expect(formatLimitNum(8_388_608)).toBe('8M')
  })

  it('returns floored decimal K for values at least 1_000', () => {
    expect(formatLimitNum(4096)).toBe('4K')
    expect(formatLimitNum(1999)).toBe('1K')
  })

  it('returns "128K" for 128000', () => {
    expect(formatLimitNum(128000)).toBe('128K')
  })

  it('formats token limits with decimal K/M units', () => {
    expect(formatLimitNum(272000)).toBe('272K')
    expect(formatLimitNum(1000000)).toBe('1M')
    expect(formatLimitNum(200000)).toBe('200K')
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

describe('runModelsList', () => {
  it('prints every exposed model and alias id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-models-list-'))
    const settingsPath = join(dir, 'settings.json')
    const logs: string[] = []
    const originalLog = console.log

    try {
      await writeFile(
        settingsPath,
        JSON.stringify({
          providers: {
            zhipu: {
              type: 'openai-compatible',
              baseURL: 'https://example.com/v1',
              apiKey: 'test-key',
              headers: {},
              plugins: [],
              models: {
                'glm-5': {
                  upstreamModel: 'glm-5',
                  aliases: [{ name: 'zhipu-flat', flat: true }],
                  headers: {},
                  plugins: [],
                  limit: { context: 200000 },
                },
              },
            },
            openai: {
              type: 'openai',
              apiKey: 'test-key',
              headers: {},
              plugins: [],
              options: { enableFlatModelLookup: true },
              models: {
                'gpt-5.5': {
                  upstreamModel: 'gpt-5.5',
                  aliases: [{ name: 'gpt-5.5-alias', flat: true }],
                  headers: {},
                  plugins: [],
                  limit: { context: 1000000 },
                },
                'codex/mini': {
                  upstreamModel: 'codex/mini',
                  aliases: [],
                  headers: {},
                  plugins: [],
                  limit: { context: 1999 },
                },
              },
            },
          },
        }),
      )
      console.log = (...args: unknown[]) => logs.push(args.join(' '))

      await runModelsList({ settingsPath })

      const output = logs.join('\n')
      expect(output).toContain('openai/gpt-5.5')
      expect(output).toContain('gpt-5.5')
      expect(output).toContain('openai/gpt-5.5-alias')
      expect(output).toContain('gpt-5.5-alias')
      expect(output).toContain('openai/codex/mini')
      expect(output).toContain('zhipu/zhipu-flat')
      expect(output).toContain('zhipu-flat')
      expect(output).toContain('1M')
      expect(output).toContain('1K')

      const ids = logs
        .slice(2)
        .filter((line) => line.trim() !== '' && !line.startsWith(' '))
        .map((line) => line.split(/\s+/)[0])
      expect(ids).toEqual([
        'zhipu/glm-5',
        'zhipu/zhipu-flat',
        'zhipu-flat',
        'openai/gpt-5.5',
        'openai/gpt-5.5-alias',
        'openai/codex/mini',
        'gpt-5.5',
        'gpt-5.5-alias',
      ])
    } finally {
      console.log = originalLog
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses runtime routing override for duplicate flat ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-models-list-'))
    const settingsPath = join(dir, 'settings.json')

    try {
      await writeFile(
        settingsPath,
        JSON.stringify({
          providers: {
            zhipu: {
              type: 'openai-compatible',
              baseURL: 'https://example.com/v1',
              apiKey: 'test-key',
              headers: {},
              plugins: [],
              models: {
                'glm-5': {
                  upstreamModel: 'glm-5',
                  aliases: [{ name: 'gpt-5.5', flat: true }],
                  headers: {},
                  plugins: [],
                },
              },
            },
            openai: {
              type: 'openai',
              apiKey: 'test-key',
              headers: {},
              plugins: [],
              options: { enableFlatModelLookup: true },
              models: {
                'gpt-5.5': {
                  upstreamModel: 'gpt-5.5',
                  aliases: [],
                  headers: {},
                  plugins: [],
                },
              },
            },
          },
        }),
      )

      const logs: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => logs.push(args.join(' '))
      try {
        await runModelsList({ settingsPath })
      } finally {
        console.log = originalLog
      }

      const bareGpt55Lines = logs.filter((line) => /^gpt-5\.5\s/.test(line))
      expect(bareGpt55Lines).toHaveLength(1)
      expect(bareGpt55Lines[0]).toMatch(/^gpt-5\.5\s+openai\s+gpt-5\.5\s/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
