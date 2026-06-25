import { describe, expect, it } from 'vitest'
import { CodexCatalogCache, buildCodexModelsResponse } from '../../src/server/codex-catalog.js'
import type { CodexModelInfo } from '../../src/codex-types.js'
import { makeSettings } from '../helpers/settings.js'

const FULL_MODEL = {
  slug: 'gpt-5.4',
  display_name: 'GPT-5.4',
  supported_reasoning_levels: [],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 0,
  base_instructions: 'x',
  supports_reasoning_summaries: false,
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: false,
  experimental_supported_tools: [],
}

describe('CodexCatalogCache', () => {
  it('fetches, indexes by slug, caches (lazy + dedup concurrent)', async () => {
    let calls = 0
    const fetcher = async () => {
      calls++
      return JSON.stringify({ models: [FULL_MODEL] })
    }
    const cache = new CodexCatalogCache(fetcher)
    const [m1, m2] = await Promise.all([cache.get(), cache.get()])
    const m3 = await cache.get()
    expect(calls).toBe(1)
    expect(m1).toBe(m2)
    expect(m1).toBe(m3)
    expect(m1.get('gpt-5.4')?.slug).toBe('gpt-5.4')
  })

  it('throws on non-json stdout', async () => {
    const cache = new CodexCatalogCache(async () => 'not json')
    await expect(cache.get()).rejects.toThrow()
  })

  it('throws on fetcher error', async () => {
    const cache = new CodexCatalogCache(async () => {
      throw new Error('codex not found')
    })
    await expect(cache.get()).rejects.toThrow('codex not found')
  })

  it('throws on entry missing slug', async () => {
    const cache = new CodexCatalogCache(async () =>
      JSON.stringify({ models: [{ ...FULL_MODEL, slug: undefined }] }),
    )
    await expect(cache.get()).rejects.toThrow()
  })

  it('throws on entry with empty slug', async () => {
    const cache = new CodexCatalogCache(async () =>
      JSON.stringify({ models: [{ ...FULL_MODEL, slug: '' }] }),
    )
    await expect(cache.get()).rejects.toThrow('empty slug')
  })
})

const CATALOG = new Map<string, CodexModelInfo>([
  [
    'gpt-5.4',
    {
      ...FULL_MODEL,
      base_instructions: 'codex-base',
      model_messages: {
        instructions_template: 'tpl-{{ personality }}',
        instructions_variables: { personality_default: '' },
      },
      supports_parallel_tool_calls: false,
      context_window: 272000,
      max_context_window: 272000,
      visibility: 'hide',
      supported_in_api: false,
      priority: 9,
      experimental_supported_tools: [{ name: 'x' }],
    } as CodexModelInfo,
  ],
  [
    'gpt-5.5',
    { ...FULL_MODEL, slug: 'gpt-5.5', display_name: 'GPT-5.5', base_instructions: 'codex-5.5' },
  ],
])

describe('buildCodexModelsResponse', () => {
  it('emits one ModelInfo per listModels id, slug fixed = id, settings-derived defaults', () => {
    const settings = makeSettings({
      zhipu: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        models: { 'glm-5.1': { upstreamModel: 'glm-5.1', aliases: ['g'], headers: {}, plugins: [] } },
      },
    })
    const { models } = buildCodexModelsResponse(settings, CATALOG)
    // flat lookup 默认关闭:只 provider/modelKey
    expect(models.map((m) => m.slug).sort()).toEqual(['zhipu/glm-5.1'])
    const m = models[0]!
    expect(m.slug).toBe('zhipu/glm-5.1')
    expect(m.display_name).toBe('zhipu/glm-5.1') // 默认 = slug
    expect(m.context_window).toBe(200000) // 无 limit → fallback
    expect(m.max_context_window).toBe(200000)
    expect(m.visibility).toBe('list') // 强制,覆盖 template hide
    expect(m.supported_in_api).toBe(true)
    expect(m.priority).toBe(0)
    expect(m.experimental_supported_tools).toEqual([])
    expect(m.base_instructions).toBe('codex-base') // template
  })

  it('context_window from limit.context; flat lookup adds modelKey + alias slugs', () => {
    const settings = makeSettings(
      {
        zhipu: {
          type: 'openai-compatible',
          baseURL: 'https://x',
          apiKey: 'k',
          headers: {},
          plugins: [],
          models: {
            'glm-5.1': {
              upstreamModel: 'glm-5.1',
              aliases: ['g'],
              headers: {},
              plugins: [],
              limit: { context: 128000 },
            },
          },
        },
      },
      { routing: { enableFlatModelLookup: true } },
    )
    const { models } = buildCodexModelsResponse(settings, CATALOG)
    expect(models.map((m) => m.slug).sort()).toEqual(['g', 'glm-5.1', 'zhipu/glm-5.1'])
    const main = models.find((m) => m.slug === 'zhipu/glm-5.1')!
    expect(main.context_window).toBe(128000)
    expect(main.max_context_window).toBe(128000)
  })

  it('4-layer override merge: global < provider < model; templateSlug per-layer', () => {
    const settings = makeSettings({
      zhipu: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        options: { codex: { templateSlug: 'gpt-5.5', display_name: 'Zhipu Model' } },
        models: {
          'glm-5.1': {
            upstreamModel: 'glm-5.1',
            aliases: [],
            headers: {},
            plugins: [],
            codex: { display_name: 'GLM-5.1', supports_parallel_tool_calls: true },
          },
        },
      },
    })
    settings.codex.default_reasoning_level = 'medium'
    const { models } = buildCodexModelsResponse(settings, CATALOG)
    const m = models[0]!
    expect(m.base_instructions).toBe('codex-5.5') // provider templateSlug=gpt-5.5 生效
    expect(m.display_name).toBe('GLM-5.1') // model 层覆盖 provider 层
    expect(m.supports_parallel_tool_calls).toBe(true) // model 层
    expect(m.default_reasoning_level).toBe('medium') // global 层
  })

  it('slug override in config is ignored (stripped)', () => {
    const settings = makeSettings({
      zhipu: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        models: {
          'glm-5.1': {
            upstreamModel: 'glm-5.1',
            aliases: [],
            headers: {},
            plugins: [],
            codex: { slug: 'should-be-ignored' } as never,
          },
        },
      },
    })
    const { models } = buildCodexModelsResponse(settings, CATALOG)
    expect(models[0]!.slug).toBe('zhipu/glm-5.1')
  })

  it('throws when merged templateSlug not in catalog (whole response fails)', () => {
    const settings = makeSettings({
      zhipu: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        options: { codex: { templateSlug: 'nonexistent' } },
        models: { 'glm-5.1': { upstreamModel: 'glm-5.1', aliases: [], headers: {}, plugins: [] } },
      },
    })
    expect(() => buildCodexModelsResponse(settings, CATALOG)).toThrow()
  })

  it('empty providers returns { models: [] }', () => {
    const { models } = buildCodexModelsResponse(makeSettings(), CATALOG)
    expect(models).toEqual([])
  })

  it('context_window 4-layer override: model > provider > global; limit.context wins', () => {
    const settings = makeSettings({
      zhipu: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        options: { codex: { context_window: 111000 } },
        models: {
          'glm-5.1': {
            upstreamModel: 'glm-5.1',
            aliases: [],
            headers: {},
            plugins: [],
            codex: { context_window: 222000 },
          },
        },
      },
    })
    // global 200000 < provider 111000 < model 222000 → model wins
    const { models } = buildCodexModelsResponse(settings, CATALOG)
    expect(models[0]!.context_window).toBe(222000)
    // limit.context 优先于 contextWindow
    settings.providers.zhipu!.models['glm-5.1']!.limit = { context: 99000 }
    const { models: m2 } = buildCodexModelsResponse(settings, CATALOG)
    expect(m2[0]!.context_window).toBe(99000)
  })

  it('settings codex templateSlug default gpt-5.4 applies when no override', () => {
    const settings = makeSettings({
      zhipu: {
        type: 'openai-compatible',
        baseURL: 'https://x',
        apiKey: 'k',
        headers: {},
        plugins: [],
        models: { 'glm-5.1': { upstreamModel: 'glm-5.1', aliases: [], headers: {}, plugins: [] } },
      },
    })
    const { models } = buildCodexModelsResponse(settings, CATALOG)
    expect(models[0]!.base_instructions).toBe('codex-base') // gpt-5.4 template
  })
})
