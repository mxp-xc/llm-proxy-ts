import { describe, expect, it } from 'vitest'
import type { AISDKInput } from '../src/providers/shared/aisdk-types.js'
import { filterDisabledTools, ToolNameMatcher } from '../src/tool-filter.js'

const tool = {} as NonNullable<AISDKInput['tools']>[string]

function input(toolNames: string[], toolChoice?: AISDKInput['toolChoice']): AISDKInput {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    tools: Object.fromEntries(toolNames.map((name) => [name, tool])),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
  }
}

describe('ToolNameMatcher', () => {
  it('matches exact strings and explicit case-sensitive globs', () => {
    const matcher = new ToolNameMatcher(['apply_patch', { glob: 'mcp__github__*' }])

    expect(matcher.matches('apply_patch')).toBe(true)
    expect(matcher.matches('mcp__github__search')).toBe(true)
    expect(matcher.matches('Apply_Patch')).toBe(false)
    expect(matcher.matches('mcp__GitHub__search')).toBe(false)
  })

  it('supports question-mark globs while treating wildcard characters in strings literally', () => {
    const matcher = new ToolNameMatcher(['literal_*', { glob: 'tool_?' }])

    expect(matcher.matches('literal_*')).toBe(true)
    expect(matcher.matches('literal_name')).toBe(false)
    expect(matcher.matches('tool_a')).toBe(true)
    expect(matcher.matches('tool_ab')).toBe(false)
  })

  it('deduplicates repeated exact and glob entries', () => {
    const matcher = new ToolNameMatcher(['same', 'same', { glob: 'tool_*' }, { glob: 'tool_*' }])

    expect(matcher.matches('same')).toBe(true)
    expect(matcher.matches('tool_one')).toBe(true)
  })
})

describe('filterDisabledTools', () => {
  it('returns the original input when no rule matches', () => {
    const original = input(['keep'])

    expect(filterDisabledTools(original, new ToolNameMatcher(['missing']))).toBe(original)
    expect(filterDisabledTools(original, new ToolNameMatcher([]))).toBe(original)
  })

  it('removes matching tools while preserving retained definitions and order', () => {
    const original = input(['keep_first', 'remove', 'keep_last'])
    const result = filterDisabledTools(original, new ToolNameMatcher(['remove']))

    expect(Object.keys(result.tools ?? {})).toEqual(['keep_first', 'keep_last'])
    expect(result.tools?.keep_first).toBe(original.tools?.keep_first)
    expect(result.tools?.keep_last).toBe(original.tools?.keep_last)
    expect(Object.keys(original.tools ?? {})).toEqual(['keep_first', 'remove', 'keep_last'])
  })

  it('omits an empty tool set and resets required tool choice to auto', () => {
    const result = filterDisabledTools(
      input(['remove'], 'required'),
      new ToolNameMatcher(['remove']),
    )

    expect(result.tools).toBeUndefined()
    expect(result.toolChoice).toBe('auto')
  })

  it('resets a removed named tool choice but preserves choices for retained tools', () => {
    const removedChoice = filterDisabledTools(
      input(['keep', 'remove'], { type: 'tool', toolName: 'remove' }),
      new ToolNameMatcher(['remove']),
    )
    const retainedChoice = filterDisabledTools(
      input(['keep', 'remove'], { type: 'tool', toolName: 'keep' }),
      new ToolNameMatcher(['remove']),
    )

    expect(removedChoice.toolChoice).toBe('auto')
    expect(retainedChoice.toolChoice).toEqual({ type: 'tool', toolName: 'keep' })
  })

  it.each(['auto', 'none'] as const)('preserves %s when all tools are removed', (choice) => {
    const result = filterDisabledTools(input(['remove'], choice), new ToolNameMatcher(['remove']))

    expect(result.tools).toBeUndefined()
    expect(result.toolChoice).toBe(choice)
  })
})
