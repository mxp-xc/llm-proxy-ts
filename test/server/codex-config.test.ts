import { describe, expect, it } from 'vitest'
import { settingsSchema } from '../../src/config.js'

describe('codex config mounting', () => {
  it('parses codex override at settings / provider / model scope', () => {
    const settings = settingsSchema.parse({
      codex: { templateSlug: 'gpt-5.5', default_reasoning_level: 'medium' },
      providers: {
        zhipu: {
          type: 'openai-compatible',
          baseURL: 'https://x',
          apiKey: 'k',
          options: { codex: { context_window: 128000, max_context_window: 128000 } },
          models: {
            'glm-5.1': { upstreamModel: 'glm-5.1', codex: { display_name: 'GLM-5.1' } },
          },
        },
      },
    })
    expect(settings.codex.templateSlug).toBe('gpt-5.5')
    expect(settings.codex.default_reasoning_level).toBe('medium')
    expect(settings.providers.zhipu?.options?.codex?.context_window).toBe(128000)
    expect(settings.providers.zhipu?.models['glm-5.1']?.codex?.display_name).toBe('GLM-5.1')
  })

  it('codex defaults context_window=200000 when not configured; templateSlug undefined; slug stripped from model.codex', () => {
    const settings = settingsSchema.parse({
      providers: {
        zhipu: {
          type: 'openai-compatible',
          baseURL: 'https://x',
          apiKey: 'k',
          models: { 'glm-5.1': { upstreamModel: 'glm-5.1', codex: { slug: 'x' } } },
        },
      },
    })
    expect(settings.codex.templateSlug).toBeUndefined()
    expect(settings.codex.context_window).toBe(200000)
    const codex = settings.providers.zhipu?.models['glm-5.1']?.codex
    expect(codex).toBeDefined()
    expect(codex && !('slug' in codex)).toBe(true)
  })

  it('codex templateSlug / contextWindow configurable at settings scope', () => {
    const settings = settingsSchema.parse({
      codex: { templateSlug: 'gpt-5.5', context_window: 128000 },
      providers: {},
    })
    expect(settings.codex.templateSlug).toBe('gpt-5.5')
    expect(settings.codex.context_window).toBe(128000)
  })

  it('rejects context_window <= 0 at model override layer', () => {
    expect(() =>
      settingsSchema.parse({
        providers: {
          zhipu: {
            type: 'openai-compatible',
            baseURL: 'https://x',
            apiKey: 'k',
            models: { 'glm-5.1': { upstreamModel: 'glm-5.1', codex: { context_window: 0 } } },
          },
        },
      }),
    ).toThrow()
  })

  it('accepts null context_window at override layer (signals "use lower layer")', () => {
    const settings = settingsSchema.parse({
      providers: {
        zhipu: {
          type: 'openai-compatible',
          baseURL: 'https://x',
          apiKey: 'k',
          models: { 'glm-5.1': { upstreamModel: 'glm-5.1', codex: { context_window: null } } },
        },
      },
    })
    expect(settings.providers.zhipu?.models['glm-5.1']?.codex?.context_window).toBeNull()
  })
})
