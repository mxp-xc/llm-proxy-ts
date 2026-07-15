import { readFile } from 'node:fs/promises'
import { parse } from 'jsonc-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeTempSettings } from '../helpers/temp-file.js'
import { runModelsSync } from '../../src/cli/models/sync-run.js'
import { discoverProviderModels } from '../../src/cli/models/discovery.js'

vi.mock('@clack/prompts', () => {
  const log = {
    step: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  }
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    isCancel: vi.fn((value) => value === Symbol.for('cancel')),
    log,
    spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
    multiselect: vi.fn(),
    autocompleteMultiselect: vi.fn(),
    confirm: vi.fn(),
  }
})

vi.mock('../../src/cli/models/discovery.js', () => ({
  discoverProviderModels: vi.fn(),
}))

const discoverMock = vi.mocked(discoverProviderModels)

const settingsText = `{
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "test-key",
      "models": {}
    }
  }
}`

const settingsWithExistingModelText = `{
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "test-key",
      "models": {
        "friendly": {
          "upstreamModel": "gpt-5"
        }
      }
    }
  }
}`

const multiProviderSettingsText = `{
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "test-key",
      "models": {}
    },
    "openai": {
      "type": "openai",
      "apiKey": "openai-key",
      "models": {}
    }
  }
}`

async function writeSettings(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  return writeTempSettings(settingsText, 'llm-proxy-models-sync-run-')
}

async function writeCustomSettings(
  content: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  return writeTempSettings(content, 'llm-proxy-models-sync-run-')
}

describe('runModelsSync', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('aborts without writing when provider flag is missing', async () => {
    const temp = await writeSettings()
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'missing' })

      expect(discoverMock).not.toHaveBeenCalled()
      await expect(readFile(temp.path, 'utf8')).resolves.toBe(settingsText)
    } finally {
      await temp.cleanup()
    }
  })

  it('does not write changes during dry-run', async () => {
    const clack = await import('@clack/prompts')
    vi.mocked(clack.autocompleteMultiselect).mockResolvedValue(['gpt-5'])
    discoverMock.mockResolvedValue({
      ok: {
        providerName: 'openrouter',
        models: [{ id: 'gpt-5' }],
        existingModels: {},
        source: 'http',
      },
    })
    const temp = await writeSettings()
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter', dryRun: true })

      expect(discoverMock).toHaveBeenCalledOnce()
      expect(clack.confirm).not.toHaveBeenCalled()
      await expect(readFile(temp.path, 'utf8')).resolves.toBe(settingsText)
    } finally {
      await temp.cleanup()
    }
  })

  it('shows discovered descriptions without including them in model search', async () => {
    const clack = await import('@clack/prompts')
    vi.mocked(clack.autocompleteMultiselect).mockResolvedValue([])
    discoverMock.mockResolvedValue({
      ok: {
        providerName: 'openrouter',
        models: [
          { id: 'gpt-5', description: 'Best for complex coding tasks' },
          { id: 'gpt-5-mini' },
          { id: 'gpt-5-nano', description: '' },
        ],
        existingModels: {},
        source: 'plugin',
      },
    })
    const temp = await writeSettings()
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      const promptOptions = vi.mocked(clack.autocompleteMultiselect).mock.calls[0]![0]
      const modelOptions = promptOptions.options
      if (!Array.isArray(modelOptions)) throw new Error('Expected static model options')

      expect(modelOptions).toEqual([
        { value: 'gpt-5', label: 'gpt-5', hint: 'Best for complex coding tasks' },
        { value: 'gpt-5-mini', label: 'gpt-5-mini' },
        { value: 'gpt-5-nano', label: 'gpt-5-nano' },
      ])

      const filter = promptOptions.filter!
      expect(filter('GPT-5', modelOptions[0]!)).toBe(true)
      expect(filter('complex coding', modelOptions[0]!)).toBe(false)
    } finally {
      await temp.cleanup()
    }
  })

  it('does not write changes when confirmation is declined', async () => {
    const clack = await import('@clack/prompts')
    vi.mocked(clack.autocompleteMultiselect).mockResolvedValue(['gpt-5'])
    vi.mocked(clack.confirm).mockResolvedValue(false)
    discoverMock.mockResolvedValue({
      ok: {
        providerName: 'openrouter',
        models: [{ id: 'gpt-5' }],
        existingModels: {},
        source: 'http',
      },
    })
    const temp = await writeSettings()
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      expect(clack.confirm).toHaveBeenCalledOnce()
      expect(clack.cancel).toHaveBeenCalledWith('Operation cancelled')
      await expect(readFile(temp.path, 'utf8')).resolves.toBe(settingsText)
    } finally {
      await temp.cleanup()
    }
  })

  it('writes selected models with limits when confirmation is accepted', async () => {
    const clack = await import('@clack/prompts')
    vi.mocked(clack.autocompleteMultiselect).mockResolvedValue(['gpt-5'])
    vi.mocked(clack.confirm).mockResolvedValue(true)
    discoverMock.mockResolvedValue({
      ok: {
        providerName: 'openrouter',
        models: [
          {
            id: 'gpt-5',
            description: 'Best for complex coding tasks',
            limit: { context: 128000, output: 8192 },
          },
        ],
        existingModels: {},
        source: 'plugin',
      },
    })
    const temp = await writeSettings()
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      expect(clack.confirm).toHaveBeenCalledOnce()
      expect(clack.log.success).toHaveBeenCalledWith('Settings updated')
      const updated = parse(await readFile(temp.path, 'utf8')) as {
        providers: { openrouter: { models: Record<string, unknown> } }
      }
      expect(updated.providers.openrouter.models['gpt-5']).toEqual({
        upstreamModel: 'gpt-5',
        limit: { context: 128000, output: 8192 },
      })
    } finally {
      await temp.cleanup()
    }
  })

  it('does not ask for confirmation when selected models make no changes', async () => {
    const clack = await import('@clack/prompts')
    vi.mocked(clack.autocompleteMultiselect).mockResolvedValue(['gpt-5'])
    discoverMock.mockResolvedValue({
      ok: {
        providerName: 'openrouter',
        models: [{ id: 'gpt-5' }],
        existingModels: {
          friendly: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] },
        },
        source: 'http',
      },
    })
    const temp = await writeCustomSettings(settingsWithExistingModelText)
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      expect(clack.confirm).not.toHaveBeenCalled()
      expect(clack.log.info).toHaveBeenCalledWith('No changes to apply')
      await expect(readFile(temp.path, 'utf8')).resolves.toBe(settingsWithExistingModelText)
    } finally {
      await temp.cleanup()
    }
  })

  it('does not discover or write when provider selection is cancelled', async () => {
    const clack = await import('@clack/prompts')
    vi.mocked(clack.multiselect).mockResolvedValue(Symbol.for('cancel'))
    const temp = await writeCustomSettings(multiProviderSettingsText)
    try {
      await runModelsSync({ settingsPath: temp.path })

      expect(discoverMock).not.toHaveBeenCalled()
      expect(clack.cancel).toHaveBeenCalledWith('Operation cancelled')
      await expect(readFile(temp.path, 'utf8')).resolves.toBe(multiProviderSettingsText)
    } finally {
      await temp.cleanup()
    }
  })

  it('does not confirm or write when model selection is cancelled', async () => {
    const clack = await import('@clack/prompts')
    vi.mocked(clack.autocompleteMultiselect).mockResolvedValue(Symbol.for('cancel'))
    discoverMock.mockResolvedValue({
      ok: {
        providerName: 'openrouter',
        models: [{ id: 'gpt-5' }],
        existingModels: {},
        source: 'http',
      },
    })
    const temp = await writeSettings()
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      expect(discoverMock).toHaveBeenCalledOnce()
      expect(clack.confirm).not.toHaveBeenCalled()
      expect(clack.cancel).toHaveBeenCalledWith('Operation cancelled')
      await expect(readFile(temp.path, 'utf8')).resolves.toBe(settingsText)
    } finally {
      await temp.cleanup()
    }
  })
})
