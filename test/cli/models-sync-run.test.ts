import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeTempSettings } from '../helpers/temp-file.js'
import { makeSettings } from '../helpers/settings.js'
import { runModelsSync } from '../../src/cli/models/sync-run.js'
import { discoverProviderModels } from '../../src/cli/models/discovery.js'
import type { DiscoverResult } from '../../src/cli/models/discovery.js'
import { PluginRegistry } from '../../src/plugins/registry.js'

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

interface ErrorSnapshot extends Record<string, unknown> {
  name: string
  message: string
  stack?: string
  cause?: unknown
  errors?: unknown[]
}

function asErrorSnapshot(value: unknown): ErrorSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an error snapshot')
  }
  return value as ErrorSnapshot
}

function loggedError(context: string): ErrorSnapshot {
  const value = vi
    .mocked(console.error)
    .mock.calls.find(([loggedContext]) => loggedContext === context)?.[1]
  return asErrorSnapshot(value)
}

function expectErrorDetails(snapshot: ErrorSnapshot, error: Error): void {
  expect(snapshot.name).toBe(error.name)
  expect(snapshot.message).toBe(error.message)
  expect(snapshot.stack).toBe(error.stack)
}

const discoveredModelsResult = {
  ok: {
    providerName: 'openrouter',
    models: [{ id: 'gpt-5' }],
    existingModels: {},
    source: 'http',
  },
} satisfies DiscoverResult

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

const pluginSettingsText = `{
  "plugins": [{ "module": "./unused-plugin.mjs" }],
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "test-key",
      "models": {}
    }
  }
}`

async function writeDynamicPluginSettings(): Promise<{
  path: string
  lifecyclePath: string
  cleanup: () => Promise<void>
}> {
  const temp = await writeCustomSettings('{}')
  const pluginPath = join(dirname(temp.path), 'lifecycle-plugin.mjs')
  const lifecyclePath = join(dirname(temp.path), 'lifecycle.log')
  await writeFile(
    pluginPath,
    `import { appendFile } from 'node:fs/promises'

    const lifecyclePath = ${JSON.stringify(lifecyclePath)}

    export default {
      name: 'models-sync-lifecycle',
      async init() {
        await appendFile(lifecyclePath, 'init\\n', 'utf8')
      },
      async dispose() {
        await appendFile(lifecyclePath, 'dispose\\n', 'utf8')
      }
    }`,
    'utf8',
  )
  await writeFile(
    temp.path,
    JSON.stringify({
      plugins: [{ module: pluginPath }],
      providers: {
        openrouter: {
          type: 'openai-compatible',
          baseURL: 'https://api.example.com/v1',
          apiKey: 'test-key',
          models: {},
        },
      },
    }),
    'utf8',
  )
  return { ...temp, lifecyclePath }
}

async function mockPluginRegistry(disposeError: Error) {
  const registry = await PluginRegistry.fromSettings(makeSettings(), '.')
  vi.spyOn(registry, 'initAll').mockResolvedValue()
  const disposeAll = vi.spyOn(registry, 'disposeAll')
  const disposeFailure = new AggregateError(
    [disposeError],
    'Failed to dispose one or more plugins',
    { cause: disposeError },
  )
  disposeAll.mockRejectedValue(disposeFailure)
  vi.spyOn(PluginRegistry, 'fromSettings').mockResolvedValue(registry)
  return { disposeAll, disposeFailure }
}

describe('runModelsSync', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  it('logs the full settings load error while keeping the CLI summary', async () => {
    const clack = await import('@clack/prompts')
    const temp = await writeCustomSettings('{ invalid settings')
    try {
      await runModelsSync({ settingsPath: temp.path })

      expect(clack.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load settings:'),
      )
      expect(clack.outro).toHaveBeenCalledWith('Aborted')
      const loadError = loggedError('Failed to load settings')
      expect(loadError.name).toBe('Error')
      expect(loadError.message).toContain('Failed to parse JSONC settings')
      expect(loadError.stack).toContain(loadError.message)
    } finally {
      await temp.cleanup()
    }
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

  it('logs plugin initialization errors with their stack before falling back', async () => {
    const clack = await import('@clack/prompts')
    const registry = await PluginRegistry.fromSettings(makeSettings(), '.')
    const initializationCause = new Error('plugin dependency unavailable')
    const initializationError = Object.assign(
      new Error('plugin initialization boom with token=plugin-init-secret', {
        cause: initializationCause,
      }),
      { token: 'plugin-init-secret' },
    )
    vi.spyOn(registry, 'initAll').mockRejectedValue(initializationError)
    const disposeAll = vi.spyOn(registry, 'disposeAll').mockResolvedValue()
    vi.spyOn(PluginRegistry, 'fromSettings').mockResolvedValue(registry)
    vi.mocked(clack.autocompleteMultiselect).mockResolvedValue([])
    discoverMock.mockResolvedValue(discoveredModelsResult)
    const temp = await writeCustomSettings(pluginSettingsText)
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      const logged = loggedError('Plugin initialization failed')
      expect(logged.name).toBe(initializationError.name)
      expect(logged.message).toBe('plugin initialization boom with token=[REDACTED]')
      expect(logged.stack).toContain('plugin initialization boom with token=[REDACTED]')
      expect(logged.stack).not.toContain('plugin-init-secret')
      expect(logged.token).toBe('[REDACTED]')
      expectErrorDetails(asErrorSnapshot(logged.cause), initializationCause)
      expect(clack.log.warn).toHaveBeenCalledWith(
        'Plugin initialization failed: plugin initialization boom with token=[REDACTED]',
      )
      expect(clack.log.info).toHaveBeenCalledWith(
        'Falling back to direct model discovery for all providers',
      )
      expect(disposeAll).toHaveBeenCalledOnce()
    } finally {
      await temp.cleanup()
    }
  })

  it('logs the original discovery error while keeping its CLI summary', async () => {
    const clack = await import('@clack/prompts')
    const discoveryCause = Object.assign(new Error('upstream connection closed'), {
      token: 'discovery-cause-token-secret',
    })
    const discoveryError = Object.assign(
      new Error(
        'HTTP 503 Service Unavailable Authorization: Bearer discovery-authorization-secret',
        {
          cause: discoveryCause,
        },
      ),
      {
        Authorization: 'Bearer discovery-authorization-secret',
        apiKey: 'discovery-api-key-secret',
        token: 'discovery-token-secret',
      },
    )
    discoverMock.mockResolvedValue({
      skipped: {
        providerName: 'openrouter',
        reason: 'fetch_failed',
        message: 'HTTP 503 Service Unavailable',
        cause: discoveryError,
      },
    })
    const temp = await writeSettings()
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      expect(clack.log.warn).toHaveBeenCalledWith(
        'openrouter: HTTP 503 Service Unavailable Authorization: [REDACTED]',
      )
      const logged = loggedError('Model discovery failed for openrouter')
      expect(logged.name).toBe(discoveryError.name)
      expect(logged.message).toBe('HTTP 503 Service Unavailable Authorization: [REDACTED]')
      expect(logged.stack).toContain('HTTP 503 Service Unavailable Authorization: [REDACTED]')
      expect(logged).toMatchObject({
        Authorization: '[REDACTED]',
        apiKey: '[REDACTED]',
        token: '[REDACTED]',
      })
      const loggedCause = asErrorSnapshot(logged.cause)
      expectErrorDetails(loggedCause, discoveryCause)
      expect(loggedCause.token).toBe('[REDACTED]')
      const serialized = JSON.stringify(logged)
      for (const secret of [
        'discovery-cause-token-secret',
        'discovery-authorization-secret',
        'discovery-api-key-secret',
        'discovery-token-secret',
      ]) {
        expect(serialized).not.toContain(secret)
      }
      expect(clack.log.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('upstream connection'),
      )
      expect(clack.log.error).toHaveBeenCalledWith('Could not fetch models from any provider')
      expect(clack.outro).toHaveBeenCalledWith('Aborted')
    } finally {
      await temp.cleanup()
    }
  })

  it('wraps and redacts a non-Error thrown value while preserving it as the cause', async () => {
    const thrown = {
      reason: 'upstream rejected the request',
      Authorization: 'Bearer thrown-authorization-secret',
      apiKey: 'thrown-api-key-secret',
      nested: { token: 'thrown-token-secret' },
    }
    discoverMock.mockRejectedValue(thrown)
    const temp = await writeSettings()
    try {
      await expect(runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })).rejects.toBe(
        thrown,
      )

      const logged = loggedError('Models sync failed')
      expect(logged.name).toBe('Error')
      expect(logged.message).toBe('Non-Error value thrown')
      expect(logged.stack).toContain('Error: Non-Error value thrown')
      expect(logged.cause).toEqual({
        reason: 'upstream rejected the request',
        Authorization: '[REDACTED]',
        apiKey: '[REDACTED]',
        nested: { token: '[REDACTED]' },
      })
      const serialized = JSON.stringify(logged)
      for (const secret of [
        'thrown-authorization-secret',
        'thrown-api-key-secret',
        'thrown-token-secret',
      ]) {
        expect(serialized).not.toContain(secret)
      }
    } finally {
      await temp.cleanup()
    }
  })

  it('does not log an error object for an expected discovery skip without a cause', async () => {
    const clack = await import('@clack/prompts')
    discoverMock.mockResolvedValue({
      skipped: {
        providerName: 'openrouter',
        reason: 'oauth_needs_login',
        message: 'OAuth login required',
      },
    })
    const temp = await writeSettings()
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      expect(console.error).not.toHaveBeenCalledWith(
        'Model discovery failed for openrouter',
        expect.anything(),
      )
      expect(clack.log.warn).toHaveBeenCalledWith('openrouter: OAuth login required')
      expect(clack.log.error).toHaveBeenCalledWith('Could not fetch models from any provider')
    } finally {
      await temp.cleanup()
    }
  })

  it.each([
    { models: [{ id: '' }] },
    { models: [{ id: 'bad-context', limit: { context: 0 } }] },
    { models: [{ id: 'bad-output', limit: { output: Number.POSITIVE_INFINITY } }] },
    { models: [{ id: 'bad-input', limit: { input: 1.5 } }] },
  ])('rejects invalid discovered plugin models before prompting', async ({ models }) => {
    const clack = await import('@clack/prompts')
    discoverMock.mockResolvedValue({
      ok: {
        providerName: 'openrouter',
        models,
        existingModels: {},
        source: 'plugin',
      },
    })
    const temp = await writeSettings()
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      expect(clack.autocompleteMultiselect).not.toHaveBeenCalled()
      expect(clack.log.error).toHaveBeenCalledWith(
        expect.stringContaining('openrouter: Invalid discovered models'),
      )
      const validationError = loggedError('Invalid discovered models from openrouter')
      expect(validationError.name).toBe('Error')
      expect(validationError.message).toContain('Invalid discovered models')
      expect(validationError.stack).toContain(validationError.message)
      const validationCause = asErrorSnapshot(validationError.cause)
      expect(validationCause.name).toBe('ZodError')
      expect(validationCause.message).toBeTruthy()
      expect(validationCause.stack).toContain(validationCause.message)
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

  it('does not overwrite settings changed while model selection was in progress', async () => {
    const clack = await import('@clack/prompts')
    vi.mocked(clack.autocompleteMultiselect).mockResolvedValue(['gpt-5'])
    vi.mocked(clack.confirm).mockImplementation(async () => {
      await writeFile(tempPath, concurrentText, 'utf8')
      return true
    })
    discoverMock.mockResolvedValue({
      ok: {
        providerName: 'openrouter',
        models: [{ id: 'gpt-5' }],
        existingModels: {},
        source: 'http',
      },
    })
    const concurrentText = `${settingsText}\n// concurrent edit\n`
    let tempPath = ''
    const temp = await writeSettings()
    tempPath = temp.path
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      expect(clack.log.success).not.toHaveBeenCalled()
      expect(clack.log.error).toHaveBeenCalledWith(
        expect.stringContaining('settings file changed since it was loaded'),
      )
      const writeError = loggedError('Failed to write settings')
      expect(writeError.name).toBe('Error')
      expect(writeError.message).toContain('settings file changed since it was loaded')
      expect(writeError.stack).toContain(writeError.message)
      await expect(readFile(temp.path, 'utf8')).resolves.toBe(concurrentText)
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

  it('loads and disposes a dynamic plugin after a successful sync exit', async () => {
    const clack = await import('@clack/prompts')
    vi.mocked(clack.autocompleteMultiselect).mockResolvedValue([])
    discoverMock.mockResolvedValue(discoveredModelsResult)
    const temp = await writeDynamicPluginSettings()
    try {
      await runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })

      await expect(readFile(temp.lifecyclePath, 'utf8')).resolves.toBe('init\ndispose\n')
    } finally {
      await temp.cleanup()
    }
  })

  it('fails clearly when plugin disposal fails after a successful sync', async () => {
    const clack = await import('@clack/prompts')
    vi.mocked(clack.autocompleteMultiselect).mockResolvedValue([])
    discoverMock.mockResolvedValue(discoveredModelsResult)
    const disposeCause = Object.assign(new Error('plugin transport close failed'), {
      token: 'dispose-cause-token-secret',
    })
    const disposeError = Object.assign(
      new Error('models sync dispose boom', { cause: disposeCause }),
      {
        Authorization: 'Bearer dispose-authorization-secret',
        apiKey: 'dispose-api-key-secret',
      },
    )
    const { disposeAll, disposeFailure } = await mockPluginRegistry(disposeError)
    Object.assign(disposeFailure, { token: 'aggregate-token-secret' })
    const temp = await writeCustomSettings(pluginSettingsText)
    try {
      await expect(runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })).rejects.toBe(
        disposeFailure,
      )

      expect(disposeAll).toHaveBeenCalledOnce()
      expect(clack.log.info).toHaveBeenCalledWith('No changes to apply')
      expect(clack.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to dispose plugins: models sync dispose boom'),
      )
      const logged = loggedError('Failed to dispose plugins')
      expectErrorDetails(logged, disposeFailure)
      expect(logged.token).toBe('[REDACTED]')

      const loggedCause = asErrorSnapshot(logged.cause)
      expectErrorDetails(loggedCause, disposeError)
      expect(loggedCause.Authorization).toBe('[REDACTED]')
      expect(loggedCause.apiKey).toBe('[REDACTED]')
      const nestedCause = asErrorSnapshot(loggedCause.cause)
      expectErrorDetails(nestedCause, disposeCause)
      expect(nestedCause.token).toBe('[REDACTED]')

      expect(logged.errors).toHaveLength(1)
      const loggedMember = asErrorSnapshot(logged.errors?.[0])
      expectErrorDetails(loggedMember, disposeError)
      expectErrorDetails(asErrorSnapshot(loggedMember.cause), disposeCause)

      const serialized = JSON.stringify(logged)
      for (const secret of [
        'dispose-cause-token-secret',
        'dispose-authorization-secret',
        'dispose-api-key-secret',
        'aggregate-token-secret',
      ]) {
        expect(serialized).not.toContain(secret)
      }
    } finally {
      await temp.cleanup()
    }
  })

  it.each([
    { outcome: 'cancelled' as const },
    { outcome: 'friendly failure' as const },
    { outcome: 'thrown error' as const },
  ])('does not replace a primary $outcome with a disposal failure', async ({ outcome }) => {
    const clack = await import('@clack/prompts')
    const { disposeAll, disposeFailure } = await mockPluginRegistry(
      new Error('models sync dispose boom'),
    )
    const temp = await writeCustomSettings(pluginSettingsText)
    const syncError = new Error('model discovery crashed')
    discoverMock.mockResolvedValue(discoveredModelsResult)

    if (outcome === 'cancelled') {
      vi.mocked(clack.autocompleteMultiselect).mockResolvedValue(Symbol.for('cancel'))
    } else if (outcome === 'friendly failure') {
      vi.mocked(clack.autocompleteMultiselect).mockResolvedValue(['gpt-5'])
      const originalText = await readFile(temp.path, 'utf8')
      vi.mocked(clack.confirm).mockImplementation(async () => {
        await writeFile(temp.path, `${originalText}\n`, 'utf8')
        return true
      })
    } else {
      discoverMock.mockRejectedValue(syncError)
    }

    try {
      const result = runModelsSync({ settingsPath: temp.path, provider: 'openrouter' })
      if (outcome === 'thrown error') {
        await expect(result).rejects.toBe(syncError)
        expectErrorDetails(loggedError('Models sync failed'), syncError)
      } else {
        await expect(result).resolves.toBeUndefined()
      }

      if (outcome === 'cancelled') {
        expect(clack.cancel).toHaveBeenCalledWith('Operation cancelled')
      } else if (outcome === 'friendly failure') {
        expect(clack.log.error).toHaveBeenCalledWith(
          expect.stringContaining(
            'Failed to write settings: settings file changed since it was loaded',
          ),
        )
        expect(clack.outro).toHaveBeenCalledWith('Aborted')
      }
      expect(disposeAll).toHaveBeenCalledOnce()
      expect(clack.log.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to dispose plugins: models sync dispose boom'),
      )
      const disposalLog = loggedError('Failed to dispose plugins')
      expectErrorDetails(disposalLog, disposeFailure)
      expect(disposalLog.errors).toHaveLength(1)
      expectErrorDetails(
        asErrorSnapshot(disposalLog.errors?.[0]),
        disposeFailure.errors[0] as Error,
      )
    } finally {
      await temp.cleanup()
    }
  })
})
