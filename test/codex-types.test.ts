import { describe, expect, it } from 'vitest'
import { codexInstallSchema } from '../src/codex-types.js'

describe('codexInstallSchema systemPrompt', () => {
  it('leaves systemPrompt undefined when omitted', () => {
    expect(codexInstallSchema.parse({}).systemPrompt).toBeUndefined()
  })

  it.each(['gpt-5.6', 'gpt-5.5'] as const)('accepts %s', (systemPrompt) => {
    expect(codexInstallSchema.parse({ systemPrompt }).systemPrompt).toBe(systemPrompt)
  })

  it('rejects unsupported system prompts', () => {
    expect(() => codexInstallSchema.parse({ systemPrompt: 'gpt-5.4' })).toThrow()
  })
})
