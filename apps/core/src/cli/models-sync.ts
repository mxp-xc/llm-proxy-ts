import * as clack from '@clack/prompts'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { loadSettingsFromFile, resolveEnvPlaceholders } from '../config.js'
import type { ModelRouteInput, Settings } from '../config.js'
import { TokenManager, OAuthError } from '../oauth/index.js'
import { PluginRegistry } from '../plugins/registry.js'
import type { DiscoveredModel } from '../plugins/types.js'
import { fetchUpstreamModels, openAIToDiscoveredModels } from './discover-models.js'
import { applyMultipleProviderModels, writeSettingsFile } from './settings-writer.js'

export interface ModelsSyncOptions {
  settingsPath: string
  provider?: string
  dryRun?: boolean
}

interface ProviderModelsResult {
  providerName: string
  models: DiscoveredModel[]
  existingModels: Record<string, ModelRouteInput>
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
    clack.log.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`)
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
    clack.log.error(
      `Failed to read settings file: ${err instanceof Error ? err.message : String(err)}`,
    )
    clack.outro('Aborted')
    return
  }

  // 解析原始 JSONC 以获取未解析 env 占位符的 apiKey
  const rawErrors: ParseError[] = []
  const rawParsed = parse(rawText, rawErrors, { allowTrailingComma: true }) as Record<
    string,
    unknown
  >

  // 初始化插件注册表（如果有插件配置）
  const settingsDir = dirname(settingsPath)
  const authFilePath = join(settingsDir, 'auth.json')
  let pluginRegistry: PluginRegistry | undefined
  if (settings.plugins.length > 0) {
    try {
      pluginRegistry = await PluginRegistry.fromSettings(settings, settingsDir, authFilePath)
      await pluginRegistry.initAll(undefined, authFilePath)
    } catch (err) {
      clack.log.warn(
        `Plugin initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      clack.log.info('Falling back to direct model discovery for all providers')
      pluginRegistry = undefined
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

  // 延迟初始化 TokenManager（仅当存在 OAuth provider 且无插件覆盖时）
  let tokenManager: TokenManager | undefined
  const hasOAuthProviders = selectedProviders.some((name) => settings.providers[name]?.oauth)
  if (hasOAuthProviders) {
    tokenManager = new TokenManager(authFilePath)
    await tokenManager.load()
  }

  const results: ProviderModelsResult[] = []

  for (const providerName of selectedProviders) {
    const provider = settings.providers[providerName]!
    const s = clack.spinner()
    s.start(`Fetching models from ${providerName}...`)

    try {
      let models: DiscoveredModel[]

      // 优先使用 auth 插件的 discoverModels
      if (pluginRegistry) {
        try {
          const discovered = await pluginRegistry.discoverModels(
            providerName,
            undefined,
            authFilePath,
          )
          if (discovered) {
            models = discovered.models
            s.stop(`Found ${models.length} models from ${providerName} (via auth plugin)`)
            results.push({ providerName, models, existingModels: provider.models })
            continue
          }
        } catch (err) {
          s.stop(`Skipped ${providerName}`)
          clack.log.warn(
            `${providerName}: Auth plugin discoverModels failed — ${err instanceof Error ? err.message : String(err)}`,
          )
          continue
        }
      }

      // 回退：通过 OpenAI 协议 HTTP 发现
      const rawProviders = rawParsed['providers'] as
        | Record<string, Record<string, unknown>>
        | undefined
      const rawProvider = rawProviders?.[providerName]
      const resolvedApiKey =
        rawProvider?.['apiKey'] != null
          ? (resolveEnvPlaceholders(rawProvider['apiKey']) as string | string[] | null)
          : provider.apiKey

      // 解析 OAuth token（如果配置了 OAuth）
      let oauthToken: { tokenType: string; accessToken: string } | undefined
      if (provider.oauth && tokenManager) {
        const status = tokenManager.getStatus(providerName, provider.oauth)
        if (status === 'needs_login') {
          s.stop(`Skipped ${providerName}`)
          clack.log.warn(
            `${providerName}: OAuth login required. Start the server and visit /oauth/login/${providerName} to authenticate.`,
          )
          continue
        }
        try {
          const token = await tokenManager.ensureValidToken(providerName, provider.oauth)
          oauthToken = { tokenType: token.tokenType, accessToken: token.accessToken }
        } catch (err) {
          s.stop(`Skipped ${providerName}`)
          const msg =
            err instanceof OAuthError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err)
          clack.log.warn(`${providerName}: OAuth token refresh failed — ${msg}`)
          continue
        }
      }

      const openaiModels = await fetchUpstreamModels({
        baseURL: provider.baseURL,
        apiKey: resolvedApiKey,
        proxySettings: settings.proxy,
        modelsEndpoint: provider.modelsEndpoint,
        headers: provider.headers,
        oauthToken,
      })
      models = openAIToDiscoveredModels(openaiModels).models

      s.stop(`Found ${models.length} models from ${providerName}`)
      results.push({
        providerName,
        models,
        existingModels: provider.models,
      })
    } catch (err) {
      s.stop(`Failed to fetch models from ${providerName}`)
      clack.log.warn(`${providerName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (results.length === 0) {
    clack.log.error('Could not fetch models from any provider')
    clack.outro('Aborted')
    return
  }

  // 4. 选择模型
  const changes: Array<{
    providerName: string
    newModels: Record<string, ModelRouteInput>
    added: number
    kept: number
    removed: number
  }> = []

  for (const { providerName, models, existingModels } of results) {
    const existingKeys = Object.keys(existingModels)

    const options = models.map((model) => ({
      value: model.id,
      label: model.id,
    }))

    const initialValues: string[] = []
    for (const key of existingKeys) {
      const upstreamModel = existingModels[key]?.upstreamModel
      if (upstreamModel && models.some((m) => m.id === upstreamModel)) {
        initialValues.push(upstreamModel)
      }
    }

    const selected = await clack.autocompleteMultiselect({
      message: `Select models for ${providerName} (${models.length} available)`,
      options,
      initialValues,
      placeholder: 'Type to search models...',
      required: false,
    })

    if (clack.isCancel(selected)) {
      clack.cancel('Operation cancelled')
      return
    }

    const selectedIds = new Set(selected as string[])

    const newModels: Record<string, ModelRouteInput> = {}
    let kept = 0
    let added = 0

    for (const modelId of selectedIds) {
      const existingEntry = Object.entries(existingModels).find(
        ([, config]) => config.upstreamModel === modelId,
      )

      if (existingEntry) {
        newModels[existingEntry[0]] = existingEntry[1]
        kept++
      } else {
        newModels[modelId] = { upstreamModel: modelId }
        added++
      }
    }

    const removed = existingKeys.length - kept

    changes.push({ providerName, newModels, added, kept, removed })

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
    return
  }

  if (dryRun) {
    clack.log.info('Dry run — no changes written')
    clack.outro('Done')
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
    const modifiedText = applyMultipleProviderModels(
      rawText,
      changes.map((c) => ({ providerName: c.providerName, newModels: c.newModels })),
    )

    await writeSettingsFile(settingsPath, modifiedText)
    clack.log.success('Settings updated')
  } catch (err) {
    clack.log.error(`Failed to write settings: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }

  clack.outro('Done')
}
