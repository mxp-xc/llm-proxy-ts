import * as clack from '@clack/prompts'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'
import { loadSettingsFromFile } from '../../config.js'
import type { Settings } from '../../config.js'
import { createTokenManagerIfNeeded } from '../../oauth/index.js'
import { PluginRegistry } from '../../plugins/registry.js'
import { redact } from '../../server/logging.js'
import { applyMultipleProviderModels, writeSettingsFile } from './settings-writer.js'
import { discoverProviderModels, type ProviderModelsResult } from './discovery.js'
import { validateDiscoveredModels } from './discover.js'
import { getInitialModelSelections, planModelSyncChanges, type ModelSyncPlan } from './sync-plan.js'

export interface ModelsSyncOptions {
  settingsPath: string
  provider?: string
  dryRun?: boolean
}

function errorMessage(err: unknown): string {
  const error = err instanceof Error ? err : new Error('Non-Error value thrown', { cause: err })
  const snapshot = redact(error)
  if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    'message' in snapshot &&
    typeof snapshot.message === 'string'
  ) {
    return snapshot.message
  }
  return 'Unknown error'
}

function logError(context: string, err: unknown): void {
  const error = err instanceof Error ? err : new Error('Non-Error value thrown', { cause: err })
  console.error(context, redact(error))
}

export async function runModelsSync(options: ModelsSyncOptions): Promise<void> {
  const { settingsPath, provider: providerFlag, dryRun = false } = options

  clack.intro('llm-proxy models sync')

  // 1. 加载配置
  clack.log.step(`Loading settings from ${settingsPath}`)

  let settings: Settings
  try {
    settings = await loadSettingsFromFile(settingsPath)
  } catch (err) {
    logError('Failed to load settings', err)
    clack.log.error(`Failed to load settings: ${errorMessage(err)}`)
    clack.outro('Aborted')
    return
  }

  const providerNames = Object.keys(settings.providers)
  if (providerNames.length === 0) {
    clack.log.warn('No providers configured in settings')
    clack.outro('Done')
    return
  }

  // 读取原始 JSONC 文本（用于后续保留注释的写入）
  let rawText: string
  try {
    rawText = await readFile(settingsPath, 'utf8')
  } catch (err) {
    logError('Failed to read settings file', err)
    clack.log.error(`Failed to read settings file: ${errorMessage(err)}`)
    clack.outro('Aborted')
    return
  }

  // 解析原始 JSONC 以获取未解析 env 占位符的 apiKey
  const rawParsed = parse(rawText, undefined, { allowTrailingComma: true }) as unknown

  // 初始化插件注册表（如果有插件配置）
  const settingsDir = dirname(settingsPath)
  const authFilePath = join(settingsDir, 'auth.json')
  let pluginRegistry: PluginRegistry | undefined
  let registryToDispose: PluginRegistry | undefined
  let operationFailed = true

  try {
    if (settings.plugins.length > 0) {
      try {
        registryToDispose = await PluginRegistry.fromSettings(settings, settingsDir)
        await registryToDispose.initAll(undefined, authFilePath)
        pluginRegistry = registryToDispose
      } catch (err) {
        logError('Plugin initialization failed', err)
        clack.log.warn(`Plugin initialization failed: ${errorMessage(err)}`)
        clack.log.info('Falling back to direct model discovery for all providers')
      }
    }

    // 2. 选择 provider
    let selectedProviders: string[]
    if (providerFlag) {
      if (!settings.providers[providerFlag]) {
        clack.log.error(`Provider "${providerFlag}" not found in settings`)
        clack.outro('Aborted')
        return
      }
      selectedProviders = [providerFlag]
      clack.log.step(`Syncing provider: ${providerFlag}`)
    } else if (providerNames.length === 1) {
      selectedProviders = [providerNames[0]!]
      clack.log.step(`Auto-selected provider: ${selectedProviders[0]}`)
    } else {
      const selected = await clack.multiselect({
        message: 'Select providers to sync',
        options: providerNames.map((name) => {
          const opt: { value: string; label: string; hint?: string } = { value: name, label: name }
          const baseURL = settings.providers[name]?.baseURL
          if (baseURL) opt.hint = baseURL
          return opt
        }),
        required: true,
      })

      if (clack.isCancel(selected)) {
        clack.cancel('Operation cancelled')
        return
      }

      selectedProviders = selected as string[]
    }

    // 3. 发现模型

    // 延迟初始化 TokenManager（仅当存在 OAuth provider 时）
    const hasOAuthProviders = selectedProviders.some((name) => settings.providers[name]?.oauth)
    const tokenManager = await createTokenManagerIfNeeded(authFilePath, hasOAuthProviders)

    const results: ProviderModelsResult[] = []

    for (const providerName of selectedProviders) {
      const provider = settings.providers[providerName]!
      const s = clack.spinner()
      s.start(`Fetching models from ${providerName}...`)
      const result = await discoverProviderModels({
        providerName,
        provider,
        settings,
        rawParsed,
        ...(pluginRegistry !== undefined ? { pluginRegistry } : {}),
        ...(tokenManager !== undefined ? { tokenManager } : {}),
        authFilePath,
      })
      if ('ok' in result) {
        try {
          result.ok.models = validateDiscoveredModels(result.ok.models)
        } catch (err) {
          s.stop(`Invalid models from ${providerName}`)
          logError(`Invalid discovered models from ${providerName}`, err)
          clack.log.error(`${providerName}: ${errorMessage(err)}`)
          continue
        }
        s.stop(
          `Found ${result.ok.models.length} models from ${providerName}${
            result.ok.source === 'plugin' ? ' (via auth plugin)' : ''
          }`,
        )
        results.push(result.ok)
      } else {
        s.stop(
          result.skipped.reason === 'fetch_failed'
            ? `Failed to fetch models from ${providerName}`
            : `Skipped ${providerName}`,
        )
        if ('cause' in result.skipped) {
          logError(`Model discovery failed for ${providerName}`, result.skipped.cause)
        }
        clack.log.warn(
          `${providerName}: ${'cause' in result.skipped ? errorMessage(result.skipped.cause) : result.skipped.message}`,
        )
      }
    }

    if (results.length === 0) {
      clack.log.error('Could not fetch models from any provider')
      clack.outro('Aborted')
      return
    }

    // 4. 选择模型
    const changes: Array<ModelSyncPlan & { providerName: string }> = []

    for (const { providerName, models, existingModels } of results) {
      const options = models.map((model) => ({
        value: model.id,
        label: model.id,
        ...(model.description ? { hint: model.description } : {}),
      }))
      const initialValues = getInitialModelSelections({
        existingModels,
        discoveredModels: models,
      })

      const selected = await clack.autocompleteMultiselect({
        message: `Select models for ${providerName} (${models.length} available)`,
        options,
        initialValues,
        placeholder: 'Type to search models...',
        filter: (search, option) =>
          String(option.value).toLowerCase().includes(search.toLowerCase()),
        required: false,
      })

      if (clack.isCancel(selected)) {
        clack.cancel('Operation cancelled')
        return
      }

      const plan = planModelSyncChanges({
        existingModels,
        discoveredModels: models,
        selectedIds: selected as string[],
      })
      const { added, kept, removed } = plan

      changes.push({ providerName, ...plan })

      const parts: string[] = []
      if (added > 0) parts.push(`+${added} new`)
      if (kept > 0) parts.push(`${kept} kept`)
      if (removed > 0) parts.push(`-${removed} removed`)
      clack.log.step(`${providerName}: ${parts.join(', ') || 'no changes'}`)
    }

    const hasChanges = changes.some((c) => c.added > 0 || c.removed > 0)
    if (!hasChanges) {
      clack.log.info('No changes to apply')
      clack.outro('Done')
      operationFailed = false
      return
    }

    if (dryRun) {
      clack.log.info('Dry run — no changes written')
      clack.outro('Done')
      operationFailed = false
      return
    }

    const shouldApply = await clack.confirm({
      message: 'Apply changes to settings.jsonc?',
    })

    if (clack.isCancel(shouldApply) || !shouldApply) {
      clack.cancel('Operation cancelled')
      return
    }

    try {
      await writeSettingsFile(
        settingsPath,
        (currentText) =>
          applyMultipleProviderModels(
            currentText,
            changes.map((c) => ({ providerName: c.providerName, newModels: c.newModels })),
          ),
        rawText,
      )
      clack.log.success('Settings updated')
    } catch (err) {
      logError('Failed to write settings', err)
      clack.log.error(`Failed to write settings: ${errorMessage(err)}`)
      clack.outro('Aborted')
      return
    }

    clack.outro('Done')
    operationFailed = false
  } catch (err) {
    logError('Models sync failed', err)
    throw err
  } finally {
    if (registryToDispose) {
      try {
        await registryToDispose.disposeAll()
      } catch (disposeError) {
        logError('Failed to dispose plugins', disposeError)
        const errors = disposeError instanceof AggregateError ? disposeError.errors : [disposeError]
        const details = errors.map(errorMessage).join('; ')
        clack.log.error(`Failed to dispose plugins: ${details}`)
        if (!operationFailed) throw disposeError
      }
    }
  }
}
