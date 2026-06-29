import { describe, expect, it } from 'vitest'
import { settingsSchema } from '../../src/config.js'

describe('codex config mounting', () => {
  it('parses codex override at settings / provider / model scope', () => {
    const settings = settingsSchema.parse({
      codex: { models_catalog: { templateSlug: 'gpt-5.5', default_reasoning_level: 'medium' } },
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
    expect(settings.codex.models_catalog.templateSlug).toBe('gpt-5.5')
    expect(settings.codex.models_catalog.default_reasoning_level).toBe('medium')
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
    expect(settings.codex.models_catalog.templateSlug).toBeUndefined()
    expect(settings.codex.models_catalog.context_window).toBe(200000)
    const codex = settings.providers.zhipu?.models['glm-5.1']?.codex
    expect(codex).toBeDefined()
    expect(codex && !('slug' in codex)).toBe(true)
  })

  it('codex templateSlug / contextWindow configurable at settings scope', () => {
    const settings = settingsSchema.parse({
      codex: { models_catalog: { templateSlug: 'gpt-5.5', context_window: 128000 } },
      providers: {},
    })
    expect(settings.codex.models_catalog.templateSlug).toBe('gpt-5.5')
    expect(settings.codex.models_catalog.context_window).toBe(128000)
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

describe('codex config restructure', () => {
  it('parses codex.models_catalog and codex.install with defaults', () => {
    const settings = settingsSchema.parse({
      codex: {
        models_catalog: { templateSlug: 'gpt-5.5', context_window: 128000 },
        install: { requiresOpenaiAuth: true },
      },
      providers: {},
    })
    expect(settings.codex.models_catalog.templateSlug).toBe('gpt-5.5')
    expect(settings.codex.models_catalog.context_window).toBe(128000)
    expect(settings.codex.install.providerId).toBe('llm-proxy')
    expect(settings.codex.install.providerName).toBe('LLM Proxy')
    expect(settings.codex.install.requiresOpenaiAuth).toBe(true)
  })

  it('defaults codex.install when omitted', () => {
    const settings = settingsSchema.parse({ providers: {} })
    expect(settings.codex.install.providerId).toBe('llm-proxy')
    expect(settings.codex.install.providerName).toBe('LLM Proxy')
    expect(settings.codex.install.requiresOpenaiAuth).toBe(false)
  })

  it('defaults codex.models_catalog.context_window=200000 when omitted', () => {
    const settings = settingsSchema.parse({ providers: {} })
    expect(settings.codex.models_catalog.context_window).toBe(200000)
  })

  it('rejects unknown top-level key in codex (strict)', () => {
    expect(() =>
      settingsSchema.parse({ codex: { context_window: 200000 }, providers: {} }),
    ).toThrow()
  })
})

describe('reasoning_effort config', () => {
  it('parses reasoning_effort at model and provider level', () => {
    const settings = settingsSchema.parse({
      providers: {
        zhipu: {
          type: 'openai-compatible',
          baseURL: 'https://x',
          apiKey: 'k',
          options: { reasoning_effort: { default: 'medium', supported: ['low', 'medium', 'high'] } },
          models: {
            'glm-5.1': {
              upstreamModel: 'glm-5.1',
              reasoning_effort: { default: 'high' },
            },
          },
        },
      },
    })
    expect(settings.providers.zhipu?.options?.reasoning_effort?.default).toBe('medium')
    expect(settings.providers.zhipu?.options?.reasoning_effort?.supported).toEqual(['low', 'medium', 'high'])
    expect(settings.providers.zhipu?.models['glm-5.1']?.reasoning_effort?.default).toBe('high')
  })

  it('rejects unknown keys in reasoning_effort (strict)', () => {
    expect(() =>
      settingsSchema.parse({
        providers: {
          zhipu: {
            type: 'openai-compatible',
            baseURL: 'https://x',
            apiKey: 'k',
            models: { 'glm-5.1': { upstreamModel: 'glm-5.1', reasoning_effort: { level: 'high' } } },
          },
        },
      }),
    ).toThrow()
  })

  it('accepts custom effort strings not in built-in enum', () => {
    const settings = settingsSchema.parse({
      providers: {
        zhipu: {
          type: 'openai-compatible',
          baseURL: 'https://x',
          apiKey: 'k',
          models: {
            'glm-5.1': {
              upstreamModel: 'glm-5.1',
              reasoning_effort: { default: 'turbo', supported: ['eco', 'turbo'] },
            },
          },
        },
      },
    })
    expect(settings.providers.zhipu?.models['glm-5.1']?.reasoning_effort?.default).toBe('turbo')
  })

  it('rejects default not in supported when both are provided', () => {
    expect(() =>
      settingsSchema.parse({
        providers: {
          zhipu: {
            type: 'openai-compatible',
            baseURL: 'https://x',
            apiKey: 'k',
            models: {
              'glm-5.1': {
                upstreamModel: 'glm-5.1',
                reasoning_effort: { default: 'high', supported: ['low', 'medium'] },
              },
            },
          },
        },
      }),
    ).toThrow('default must be one of the supported values')
  })

  it('allows default without supported (no cross-field constraint)', () => {
    const settings = settingsSchema.parse({
      providers: {
        zhipu: {
          type: 'openai-compatible',
          baseURL: 'https://x',
          apiKey: 'k',
          models: {
            'glm-5.1': {
              upstreamModel: 'glm-5.1',
              reasoning_effort: { default: 'max' },
            },
          },
        },
      },
    })
    expect(settings.providers.zhipu?.models['glm-5.1']?.reasoning_effort?.default).toBe('max')
  })
})
