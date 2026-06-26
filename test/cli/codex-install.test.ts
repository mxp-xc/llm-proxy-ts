import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTempDir, writeTempSettings } from '../helpers/temp-file.js'
import { makeSettings } from '../helpers/settings.js'
import { writeFile, readFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCodexBaseUrl, runCodexInstall } from '../../src/cli/codex/install-run.js'
import type { CodexInstallFs } from '../../src/cli/codex/install-run.js'

/** Wrap raw node:fs/promises fns to match the narrower CodexInstallFs interface. */
function wrapFs(over: { writeFile?: CodexInstallFs['writeFile']; access?: CodexInstallFs['access'] }): CodexInstallFs {
  return {
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: over.writeFile ?? ((p, d) => writeFile(p, d, 'utf8')),
    mkdir: (p, o) => mkdir(p, o).then(() => undefined),
    access: over.access ?? ((p) => access(p)),
  }
}

/** Minimal codex bundled catalog entry (passes codexModelInfoSchema). */
function makeModel(slug: string, displayName = slug) {
  return {
    slug,
    display_name: displayName,
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
}

/** Catalog fetcher returning a single supported_in_api template (gpt-5.4). */
const catalogFetcher = (): Promise<string> =>
  Promise.resolve(JSON.stringify({ models: [makeModel('gpt-5.4')] }))

function zhipuProvider(models: Record<string, unknown>) {
  return {
    type: 'openai-compatible',
    baseURL: 'https://x',
    apiKey: 'k',
    headers: {},
    plugins: [],
    models,
  }
}

function modelDef(upstreamModel: string) {
  return { upstreamModel, aliases: [], headers: {}, plugins: [] }
}

function settingsJson(providers: unknown, codex: unknown = { context_window: 204800 }): string {
  return JSON.stringify({
    service: { name: 'llm-proxy', host: '127.0.0.1', port: 8056 },
    providers,
    routing: { enableFlatModelLookup: false },
    codex,
  })
}

describe('buildCodexBaseUrl', () => {
  it('builds http url without trailing slash', () => {
    const settings = makeSettings({}, { service: { name: 'llm-proxy', host: '127.0.0.1', port: 8056 } })
    expect(buildCodexBaseUrl(settings)).toBe('http://127.0.0.1:8056/codex/v1')
  })
  it('brackets IPv6 host', () => {
    const settings = makeSettings({}, { service: { name: 'llm-proxy', host: '::1', port: 8056 } })
    expect(buildCodexBaseUrl(settings)).toBe('http://[::1]:8056/codex/v1')
  })
})

describe('runCodexInstall', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> }
  let settings: { path: string; cleanup: () => Promise<void> }
  const extraCleanups: Array<() => Promise<void>> = []

  beforeEach(async () => {
    tmp = await createTempDir('codex-install-')
    // 默认 settings:zhipu 下两个 model → buildCodexModelsResponse 产出
    // zhipu/glm-5.2、zhipu/gpt-5（flat lookup 关闭,slug = provider/modelKey）
    settings = await writeTempSettings(
      settingsJson({
        zhipu: zhipuProvider({
          'glm-5.2': modelDef('glm-5.2'),
          'gpt-5': modelDef('gpt-5'),
        }),
      }),
    )
    extraCleanups.length = 0
  })
  afterEach(async () => {
    await tmp.cleanup()
    await settings.cleanup()
    await Promise.all(extraCleanups.map((c) => c()))
  })

  async function writeSettings(providers: unknown, codex?: unknown): Promise<string> {
    const s = await writeTempSettings(settingsJson(providers, codex))
    extraCleanups.push(s.cleanup)
    return s.path
  }

  /** fs that captures written config.toml + catalog file content. */
  function capturingFs(): { fs: CodexInstallFs; writtenConfig: () => string; writtenCatalog: () => string } {
    let writtenConfig = ''
    let writtenCatalog = ''
    const fs: CodexInstallFs = {
      readFile: async (p) => readFile(p, 'utf8'),
      writeFile: async (p, d) => {
        if (p.endsWith('config.toml')) writtenConfig = d
        if (p.endsWith('.json')) writtenCatalog = d
      },
      mkdir: (p, o) => mkdir(p, o).then(() => undefined),
      access: async () => {},
    }
    return { fs, writtenConfig: () => writtenConfig, writtenCatalog: () => writtenCatalog }
  }

  it('aborts when config.toml missing, no catalog fetch, no catalog written', async () => {
    const fetcher = vi.fn(catalogFetcher)
    const writeFileSpy = vi.fn()
    const selectModels = vi.fn().mockResolvedValue(['zhipu/glm-5.2'])
    const selectDefaultModel = vi.fn().mockResolvedValue('zhipu/glm-5.2')
    const fs = wrapFs({ writeFile: writeFileSpy, access: async () => { throw new Error('enoent') } })
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher: fetcher,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModels, selectDefaultModel },
    })
    expect(fetcher).not.toHaveBeenCalled()
    expect(writeFileSpy).not.toHaveBeenCalled()
    expect(selectModels).not.toHaveBeenCalled()
  })

  it('aborts when catalog fetcher throws', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher: async () => { throw new Error('codex not found') },
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['zhipu/glm-5.2'], selectDefaultModel: async () => 'zhipu/glm-5.2' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when settings has no providers (empty models)', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const emptySettingsPath = await writeSettings({})
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: emptySettingsPath,
      catalogFetcher,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['zhipu/glm-5.2'], selectDefaultModel: async () => 'zhipu/glm-5.2' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when configured templateSlug is not in catalog', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const badSettingsPath = await writeSettings(
      { zhipu: zhipuProvider({ 'glm-5.2': modelDef('glm-5.2') }) },
      { templateSlug: 'nonexistent', context_window: 204800 },
    )
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: badSettingsPath,
      catalogFetcher,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['zhipu/glm-5.2'], selectDefaultModel: async () => 'zhipu/glm-5.2' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('succeeds with default-all: writes full catalog + edits config.toml', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), '# codex\nmodel = "gpt-5"\n')
    const { fs, writtenConfig, writtenCatalog } = capturingFs()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2', 'zhipu/gpt-5'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    const catalog = JSON.parse(writtenCatalog()) as { models: { slug: string }[] }
    expect(catalog.models.map((m) => m.slug).sort()).toEqual(['zhipu/glm-5.2', 'zhipu/gpt-5'])
    expect(writtenConfig()).toContain('model_catalog_json = "llm-proxy-model-catalog.json"')
    expect(writtenConfig()).toContain('model_provider = "llm-proxy"')
    expect(writtenConfig()).toContain('model = "zhipu/glm-5.2"')
    expect(writtenConfig()).toContain('[model_providers.llm-proxy]')
    expect(writtenConfig()).toContain('# codex') // comment preserved
  })

  it('filters catalog to the selected subset', async () => {
    // 三 model:zhipu/glm-5.2、zhipu/gpt-5、zhipu/glm-5.1
    const threeSettingsPath = await writeSettings({
      zhipu: zhipuProvider({
        'glm-5.2': modelDef('glm-5.2'),
        'gpt-5': modelDef('gpt-5'),
        'glm-5.1': modelDef('glm-5.1'),
      }),
    })
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const { fs, writtenConfig, writtenCatalog } = capturingFs()
    await runCodexInstall({
      settingsPath: threeSettingsPath,
      catalogFetcher,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2', 'zhipu/glm-5.1'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    const catalog = JSON.parse(writtenCatalog()) as { models: { slug: string }[] }
    expect(catalog.models.map((m) => m.slug).sort()).toEqual(['zhipu/glm-5.1', 'zhipu/glm-5.2'])
    expect(writtenConfig()).toContain('model = "zhipu/glm-5.2"')
  })

  it('skips default selection when subset has a single model', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const selectDefaultModel = vi.fn().mockResolvedValue('zhipu/gpt-5')
    const { fs, writtenConfig, writtenCatalog } = capturingFs()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['zhipu/gpt-5'], selectDefaultModel },
    })
    expect(selectDefaultModel).not.toHaveBeenCalled()
    expect(writtenConfig()).toContain('model = "zhipu/gpt-5"')
    const catalog = JSON.parse(writtenCatalog()) as { models: { slug: string }[] }
    expect(catalog.models.map((m) => m.slug)).toEqual(['zhipu/gpt-5'])
  })

  it('skips both prompts when settings has a single model', async () => {
    const singleSettingsPath = await writeSettings({
      zhipu: zhipuProvider({ 'glm-5.2': modelDef('glm-5.2') }),
    })
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const selectModels = vi.fn().mockResolvedValue(['zhipu/glm-5.2'])
    const selectDefaultModel = vi.fn().mockResolvedValue('zhipu/glm-5.2')
    const { fs, writtenConfig, writtenCatalog } = capturingFs()
    await runCodexInstall({
      settingsPath: singleSettingsPath,
      catalogFetcher,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModels, selectDefaultModel },
    })
    expect(selectModels).not.toHaveBeenCalled()
    expect(selectDefaultModel).not.toHaveBeenCalled()
    expect(writtenCatalog()).toContain('zhipu/glm-5.2')
    expect(writtenConfig()).toContain('model = "zhipu/glm-5.2"')
  })

  it('cancel at selectModels: nothing written', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => null, selectDefaultModel: async () => 'zhipu/glm-5.2' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('cancel at selectDefaultModel: nothing written', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['zhipu/glm-5.2', 'zhipu/gpt-5'], selectDefaultModel: async () => null },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when selectModels returns an empty array (injection guard)', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => [], selectDefaultModel: async () => 'zhipu/glm-5.2' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when selectModels returns a slug not in the catalog (injection guard)', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['nonexistent'], selectDefaultModel: async () => 'zhipu/glm-5.2' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when selectDefaultModel returns a slug not in the subset (injection guard)', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['zhipu/glm-5.2', 'zhipu/gpt-5'], selectDefaultModel: async () => 'nonexistent' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })
})
