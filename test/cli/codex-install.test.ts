import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTempDir, writeTempSettings } from '../helpers/temp-file.js'
import { makeSettings } from '../helpers/settings.js'
import { writeFile, readFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCodexBaseUrl, fetchCodexModelsResponse, runCodexInstall } from '../../src/cli/codex-install.js'
import type { CodexInstallFs } from '../../src/cli/codex-install.js'

/** Wrap raw node:fs/promises fns to match the narrower CodexInstallFs interface. */
function wrapFs(over: { writeFile?: CodexInstallFs['writeFile']; access?: CodexInstallFs['access'] }): CodexInstallFs {
  return {
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: over.writeFile ?? ((p, d) => writeFile(p, d, 'utf8')),
    mkdir: (p, o) => mkdir(p, o).then(() => undefined),
    access: over.access ?? ((p) => access(p)),
  }
}

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

describe('fetchCodexModelsResponse', () => {
  it('parses a 200 models response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const res = await fetchCodexModelsResponse({ url: 'http://x/codex/v1/models', fetchImpl })
    expect(res.models).toHaveLength(2)
  })
  it('throws http503 on 503', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { type: 'server_error', message: 'codex CLI missing' } }),
    }) as unknown as typeof fetch
    await expect(fetchCodexModelsResponse({ url: 'http://x/codex/v1/models', fetchImpl })).rejects.toMatchObject({
      kind: 'http503',
    })
  })
  it('throws network on TypeError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch
    await expect(fetchCodexModelsResponse({ url: 'http://x/codex/v1/models', fetchImpl })).rejects.toMatchObject({
      kind: 'network',
    })
  })
})

describe('runCodexInstall', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> }
  let settings: { path: string; cleanup: () => Promise<void> }

  beforeEach(async () => {
    tmp = await createTempDir('codex-install-')
    settings = await writeTempSettings(JSON.stringify({
      service: { name: 'llm-proxy', host: '127.0.0.1', port: 8056 },
      providers: {},
      routing: { enableFlatModelLookup: true },
      codex: { templateSlug: 'gpt-5.5', context_window: 204800 },
    }))
  })
  afterEach(async () => {
    await tmp.cleanup()
    await settings.cleanup()
  })

  it('aborts when config.toml missing, no fetch, no catalog written', async () => {
    const fetchImpl = vi.fn()
    const writeFileSpy = vi.fn()
    const selectModels = vi.fn().mockResolvedValue(['a'])
    const selectDefaultModel = vi.fn().mockResolvedValue('a')
    const fs = wrapFs({ writeFile: writeFileSpy, access: async () => { throw new Error('enoent') } })
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModels, selectDefaultModel },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(writeFileSpy).not.toHaveBeenCalled()
    expect(selectModels).not.toHaveBeenCalled()
  })

  it('aborts on fetch network error', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['a'], selectDefaultModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts on empty models', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['a'], selectDefaultModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('succeeds with default-all: writes full catalog + edits config.toml', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), '# codex\nmodel = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('zhipu/glm-5.2', 'GLM-5.2'), makeModel('gpt-5', 'GPT-5')] }),
    }) as unknown as typeof fetch
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
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['zhipu/glm-5.2', 'gpt-5'],
        selectDefaultModel: async () => 'zhipu/glm-5.2',
      },
    })
    const catalog = JSON.parse(writtenCatalog) as { models: { slug: string }[] }
    expect(catalog.models.map((m) => m.slug).sort()).toEqual(['gpt-5', 'zhipu/glm-5.2'])
    expect(writtenConfig).toContain('model_catalog_json = "llm-proxy-model-catalog.json"')
    expect(writtenConfig).toContain('model_provider = "llm-proxy"')
    expect(writtenConfig).toContain('model = "zhipu/glm-5.2"')
    expect(writtenConfig).toContain('[model_providers.llm-proxy]')
    expect(writtenConfig).toContain('# codex') // comment preserved
  })

  it('filters catalog to the selected subset', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b'), makeModel('c')] }),
    }) as unknown as typeof fetch
    let writtenCatalog = ''
    let writtenConfig = ''
    const fs: CodexInstallFs = {
      readFile: async (p) => readFile(p, 'utf8'),
      writeFile: async (p, d) => {
        if (p.endsWith('config.toml')) writtenConfig = d
        if (p.endsWith('.json')) writtenCatalog = d
      },
      mkdir: (p, o) => mkdir(p, o).then(() => undefined),
      access: async () => {},
    }
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs,
      codexHome: tmp.dir,
      prompts: {
        selectModels: async () => ['a', 'c'],
        selectDefaultModel: async () => 'a',
      },
    })
    const catalog = JSON.parse(writtenCatalog) as { models: { slug: string }[] }
    expect(catalog.models.map((m) => m.slug).sort()).toEqual(['a', 'c'])
    expect(writtenConfig).toContain('model = "a"')
  })

  it('skips default selection when subset has a single model', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const selectDefaultModel = vi.fn().mockResolvedValue('a')
    let writtenCatalog = ''
    let writtenConfig = ''
    const fs: CodexInstallFs = {
      readFile: async (p) => readFile(p, 'utf8'),
      writeFile: async (p, d) => {
        if (p.endsWith('config.toml')) writtenConfig = d
        if (p.endsWith('.json')) writtenCatalog = d
      },
      mkdir: (p, o) => mkdir(p, o).then(() => undefined),
      access: async () => {},
    }
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['b'], selectDefaultModel },
    })
    expect(selectDefaultModel).not.toHaveBeenCalled()
    expect(writtenConfig).toContain('model = "b"')
    const catalog = JSON.parse(writtenCatalog) as { models: { slug: string }[] }
    expect(catalog.models.map((m) => m.slug)).toEqual(['b'])
  })

  it('skips both prompts when catalog has a single model', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('zhipu/glm-5.2', 'GLM-5.2')] }),
    }) as unknown as typeof fetch
    const selectModels = vi.fn().mockResolvedValue(['zhipu/glm-5.2'])
    const selectDefaultModel = vi.fn().mockResolvedValue('zhipu/glm-5.2')
    let writtenCatalog = ''
    let writtenConfig = ''
    const fs: CodexInstallFs = {
      readFile: async (p) => readFile(p, 'utf8'),
      writeFile: async (p, d) => {
        if (p.endsWith('config.toml')) writtenConfig = d
        if (p.endsWith('.json')) writtenCatalog = d
      },
      mkdir: (p, o) => mkdir(p, o).then(() => undefined),
      access: async () => {},
    }
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs,
      codexHome: tmp.dir,
      prompts: { selectModels, selectDefaultModel },
    })
    expect(selectModels).not.toHaveBeenCalled()
    expect(selectDefaultModel).not.toHaveBeenCalled()
    expect(writtenCatalog).toContain('zhipu/glm-5.2')
    expect(writtenConfig).toContain('model = "zhipu/glm-5.2"')
  })

  it('cancel at selectModels: nothing written', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => null, selectDefaultModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('cancel at selectDefaultModel: nothing written', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['a', 'b'], selectDefaultModel: async () => null },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when selectModels returns an empty array (injection guard)', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => [], selectDefaultModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when selectModels returns a slug not in the catalog (injection guard)', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['nonexistent'], selectDefaultModel: async () => 'a' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })

  it('aborts when selectDefaultModel returns a slug not in the subset (injection guard)', async () => {
    await writeFile(join(tmp.dir, 'config.toml'), 'model = "gpt-5"\n')
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [makeModel('a'), makeModel('b')] }),
    }) as unknown as typeof fetch
    const writeFileSpy = vi.fn()
    await runCodexInstall({
      settingsPath: settings.path,
      fetchImpl,
      fs: wrapFs({ writeFile: writeFileSpy, access: async () => {} }),
      codexHome: tmp.dir,
      prompts: { selectModels: async () => ['a', 'b'], selectDefaultModel: async () => 'nonexistent' },
    })
    expect(writeFileSpy).not.toHaveBeenCalled()
  })
})
