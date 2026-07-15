import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTempDir, writeTempSettings } from '../helpers/temp-file.js'
import { makeSettings } from '../helpers/settings.js'
import { writeFile, readFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildCodexBaseUrl,
  runCodexInstall,
  resolveSelectedModels,
} from '../../src/cli/codex/install-run.js'
import type { CodexInstallFs } from '../../src/cli/codex/install-run.js'
import { CODEX_PROMPT_ASSETS } from '../../src/cli/codex/prompt-assets.js'

/** Wrap raw node:fs/promises fns to match the narrower CodexInstallFs interface. */
function wrapFs(over: {
  readFile?: CodexInstallFs['readFile']
  writeFile?: CodexInstallFs['writeFile']
  access?: CodexInstallFs['access']
  unlink?: CodexInstallFs['unlink']
}): CodexInstallFs {
  return {
    readFile: over.readFile ?? ((p) => readFile(p, 'utf8')),
    writeFile: over.writeFile ?? ((p, d) => writeFile(p, d, 'utf8')),
    mkdir: (p, o) => mkdir(p, o).then(() => undefined),
    access: over.access ?? ((p) => access(p)),
    unlink: over.unlink ?? (async () => {}),
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

function settingsJson(
  providers: unknown,
  codex: unknown = { models_catalog: { context_window: 204800 } },
): string {
  return JSON.stringify({
    service: { name: 'llm-proxy', host: '127.0.0.1', port: 8056 },
    providers,
    routing: { enableFlatModelLookup: false },
    codex,
  })
}

describe('buildCodexBaseUrl', () => {
  it('builds http url without trailing slash', () => {
    const settings = makeSettings(
      {},
      { service: { name: 'llm-proxy', host: '127.0.0.1', port: 8056 } },
    )
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
  function capturingFs(): {
    fs: CodexInstallFs
    writtenConfig: () => string
    writtenCatalog: () => string
    writtenFiles: () => ReadonlyMap<string, string>
    unlinkedPaths: () => readonly string[]
  } {
    let writtenConfig = ''
    let writtenCatalog = ''
    const writtenFiles = new Map<string, string>()
    const unlinkedPaths: string[] = []
    const fs: CodexInstallFs = {
      readFile: async (p) => readFile(p, 'utf8'),
      writeFile: async (p, d) => {
        writtenFiles.set(p, d)
        if (p.endsWith('config.toml')) writtenConfig = d
        if (p.endsWith('.json')) writtenCatalog = d
      },
      mkdir: (p, o) => mkdir(p, o).then(() => undefined),
      access: async () => {},
      unlink: async (p) => {
        unlinkedPaths.push(p)
      },
    }
    return {
      fs,
      writtenConfig: () => writtenConfig,
      writtenCatalog: () => writtenCatalog,
      writtenFiles: () => writtenFiles,
      unlinkedPaths: () => unlinkedPaths,
    }
  }

  it('aborts when config.toml missing, no catalog fetch, no catalog written', async () => {
    const fetcher = vi.fn(catalogFetcher)
    const writeFileSpy = vi.fn()
    const selectModels = vi.fn().mockResolvedValue(['zhipu/glm-5.2'])
    const selectDefaultModel = vi.fn().mockResolvedValue('zhipu/glm-5.2')
    const fs = wrapFs({
      writeFile: writeFileSpy,
      access: async () => {
        throw new Error('enoent')
      },
    })
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
      catalogFetcher: async () => {
        throw new Error('codex not found')
      },
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
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
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when configured templateSlug is not in catalog', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const badSettingsPath = await writeSettings(
      { zhipu: zhipuProvider({ 'glm-5.2': modelDef('glm-5.2') }) },
      { models_catalog: { templateSlug: 'nonexistent', context_window: 204800 } },
    )
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: badSettingsPath,
      catalogFetcher,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('succeeds with default-all: writes full catalog + edits config.toml', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), '# codex\nmodel = "gpt-5"\n')
    const { fs, writtenConfig, writtenCatalog, writtenFiles, unlinkedPaths } = capturingFs()
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
    expect(writtenConfig()).toContain('model_catalog_json = "llm-proxy/model-catalog.json"')
    expect(writtenConfig()).toContain('model_provider = "llm-proxy"')
    expect(writtenConfig()).toContain('model = "zhipu/glm-5.2"')
    expect(writtenConfig()).toContain('check_for_update_on_startup = false')
    expect(writtenConfig()).toContain('[model_providers.llm-proxy]')
    expect(writtenConfig()).toContain('# codex') // comment preserved
    for (const asset of CODEX_PROMPT_ASSETS) {
      const targetPath = join(tmp.dir, 'llm-proxy', 'prompts', asset.filename).replaceAll('\\', '/')
      const target = [...writtenFiles().entries()].find(
        ([path]) => path.replaceAll('\\', '/') === targetPath,
      )
      expect(target?.[1]).toBe(await readFile(asset.sourcePath, 'utf8'))
    }
    expect(unlinkedPaths().some((path) => path.endsWith('llm-proxy-model-catalog.json'))).toBe(true)
  })

  it('does not touch model_instructions_file when systemPrompt is omitted', async () => {
    await writeFile(
      join(tmp.dir, 'config.toml'),
      'model = "gpt-5"\nmodel_instructions_file = "custom.md"\n',
    )
    const { fs, writtenConfig } = capturingFs()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    expect(writtenConfig()).toContain('model_instructions_file = "custom.md"')
  })

  it.each([
    ['gpt-5.6', 'llm-proxy/prompts/gpt-5.6.md'],
    ['gpt-5.5', 'llm-proxy/prompts/gpt-5.5.md'],
  ] as const)(
    'reads systemPrompt=%s directly from settings',
    async (systemPrompt, expectedPath) => {
      const configuredSettingsPath = await writeSettings(
        { zhipu: zhipuProvider({ 'glm-5.2': modelDef('glm-5.2') }) },
        {
          models_catalog: { context_window: 204800 },
          install: { systemPrompt },
        },
      )
      await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
      const { fs, writtenConfig } = capturingFs()
      await runCodexInstall({
        settingsPath: configuredSettingsPath,
        catalogFetcher,
        fs,
        codexHome: tmp.dir,
        prompts: {
          selectModels: async () => ['zhipu/glm-5.2'],
          selectDefaultModel: async () => 'zhipu/glm-5.2',
        },
      })
      expect(writtenConfig()).toContain(`model_instructions_file = "${expectedPath}"`)
    },
  )

  it('does not clean up the legacy catalog when an install write fails', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const unlinkSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs: wrapFs({
        access: async () => {},
        writeFile: async () => {
          throw new Error('disk full')
        },
        unlink: unlinkSpy,
      }),
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    expect(unlinkSpy).not.toHaveBeenCalled()
  })

  it('does not write or clean up when prompt asset preflight fails', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const writeFileSpy = vi.fn()
    const unlinkSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs: wrapFs({
        access: async () => {},
        readFile: async (path) => {
          if (path.endsWith('.md')) throw new Error('prompt asset missing')
          return readFile(path, 'utf8')
        },
        writeFile: writeFileSpy,
        unlink: unlinkSpy,
      }),
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
    expect(unlinkSpy).not.toHaveBeenCalled()
  })

  it('ignores a missing legacy catalog after activating the new config', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs: wrapFs({
        access: async () => {},
        unlink: async () => {
          throw missing
        },
      }),
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    await expect(readFile(join(tmp.dir, 'config.toml'), 'utf8')).resolves.toContain(
      'model_catalog_json = "llm-proxy/model-catalog.json"',
    )
  })

  it('keeps the new config active when legacy catalog cleanup fails', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const unlinkSpy = vi.fn().mockRejectedValue(new Error('access denied'))
    await runCodexInstall({
      settingsPath: settings.path,
      catalogFetcher,
      fs: wrapFs({ access: async () => {}, unlink: unlinkSpy }),
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    expect(unlinkSpy).toHaveBeenCalledOnce()
    await expect(readFile(join(tmp.dir, 'config.toml'), 'utf8')).resolves.toContain(
      'model_catalog_json = "llm-proxy/model-catalog.json"',
    )
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
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2', 'zhipu/gpt-5'],
        selectDefaultModel: async () => null,
      },
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
      prompts: {
        selectModels: async () => ['nonexistent'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
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
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2', 'zhipu/gpt-5'],
        selectDefaultModel: async () => 'nonexistent',
      },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('writes custom providerId and requires_openai_auth from settings', async () => {
    const customSettingsPath = await writeSettings(
      { zhipu: zhipuProvider({ 'glm-5.2': modelDef('glm-5.2') }) },
      {
        models_catalog: { context_window: 204800 },
        install: { providerId: 'my-proxy', requiresOpenaiAuth: true },
      },
    )
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const { fs, writtenConfig } = capturingFs()
    await runCodexInstall({
      settingsPath: customSettingsPath,
      catalogFetcher,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    expect(writtenConfig()).toContain('model_provider = "my-proxy"')
    expect(writtenConfig()).toContain('[model_providers.my-proxy]')
    expect(writtenConfig()).toContain('requires_openai_auth = true')
  })

  it('writes check_for_update_on_startup = true from install config', async () => {
    const customSettingsPath = await writeSettings(
      { zhipu: zhipuProvider({ 'glm-5.2': modelDef('glm-5.2') }) },
      { models_catalog: { context_window: 204800 }, install: { checkForUpdateOnStartup: true } },
    )
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const { fs, writtenConfig } = capturingFs()
    await runCodexInstall({
      settingsPath: customSettingsPath,
      catalogFetcher,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    expect(writtenConfig()).toContain('check_for_update_on_startup = true')
  })

  it('writes model_reasoning_effort from default model default_reasoning_level', async () => {
    const settingsPath = await writeSettings({
      zhipu: {
        ...zhipuProvider({
          'glm-5.2': {
            upstreamModel: 'glm-5.2',
            aliases: [],
            headers: {},
            plugins: [],
            reasoning_effort: { default: 'xhigh' },
          },
        }),
      },
    })
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const { fs, writtenConfig } = capturingFs()
    await runCodexInstall({
      settingsPath,
      catalogFetcher,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    expect(writtenConfig()).toContain('model_reasoning_effort = "xhigh"')
  })

  it('omits model_reasoning_effort when default model has no default_reasoning_level', async () => {
    const settingsPath = await writeSettings({
      zhipu: zhipuProvider({ 'glm-5.2': modelDef('glm-5.2') }),
    })
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const { fs, writtenConfig } = capturingFs()
    await runCodexInstall({
      settingsPath,
      catalogFetcher,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    expect(writtenConfig()).not.toContain('model_reasoning_effort')
  })
})

describe('resolveSelectedModels', () => {
  const ALL = ['zhipu/glm-5.2', 'zhipu/glm-5.1', 'zhipu/gpt-5']

  it('returns all slugs when the "Select all" sentinel is present', () => {
    expect(resolveSelectedModels(['__select_all__'], ALL)).toEqual(ALL)
  })

  it('returns all slugs even when other items are also toggled', () => {
    expect(resolveSelectedModels(['__select_all__', 'zhipu/glm-5.2'], ALL)).toEqual(ALL)
  })

  it('passes through the selection when the sentinel is absent', () => {
    expect(resolveSelectedModels(['zhipu/glm-5.2', 'zhipu/gpt-5'], ALL)).toEqual([
      'zhipu/glm-5.2',
      'zhipu/gpt-5',
    ])
  })

  it('keeps the contract stable for a stray sentinel', () => {
    expect(resolveSelectedModels(['zhipu/glm-5.2', '__select_all__'], ALL)).toEqual(ALL)
  })

  it('returns an empty array for empty input', () => {
    expect(resolveSelectedModels([], ALL)).toEqual([])
  })
})
