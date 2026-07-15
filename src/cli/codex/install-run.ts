import * as clack from '@clack/prompts'
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises'
import type { CodexModelInfo } from '../../codex-types.js'
import {
  CodexCatalogCache,
  buildCodexModelsResponse,
  type CodexCatalogFetcher,
} from '../../codex-catalog.js'
import { loadSettingsFromFile } from '../../config.js'
import type { Settings } from '../../config.js'
import {
  resolveCodexHome,
  resolveCodexConfigPath,
  resolveCodexCatalogPath,
  resolveLegacyCodexCatalogPath,
  resolveCodexPromptPath,
  resolveCodexPromptsDirectory,
  DEFAULT_CATALOG_FILENAME,
  PROMPTS_DIRECTORY,
} from './home.js'
import { applyCodexConfigEdits } from './toml.js'
import { CODEX_PROMPT_ASSETS, getCodexPromptAsset } from './prompt-assets.js'

/** Build the codex base URL from service settings (no trailing slash; IPv6 bracketed). */
export function buildCodexBaseUrl(settings: Settings): string {
  const { host, port } = settings.service
  const bracketed = host.includes(':') ? `[${host}]` : host
  return `http://${bracketed}:${port}/codex/v1`
}

/** Injectable fs surface for runCodexInstall (avoids `unknown`). */
export interface CodexInstallFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>
  access(path: string): Promise<void>
  unlink(path: string): Promise<void>
}

export interface CodexInstallPrompts {
  /** Multi-select models to install; returns selected slugs, or null on cancel. */
  selectModels(models: CodexModelInfo[]): Promise<string[] | null>
  /** Single-select the default model from the subset; returns slug, or null on cancel. */
  selectDefaultModel(models: CodexModelInfo[]): Promise<string | null>
}

export interface CodexInstallOptions {
  settingsPath: string
  catalogFetcher?: CodexCatalogFetcher
  fs?: CodexInstallFs
  codexHome?: string
  prompts?: CodexInstallPrompts
}

const defaultFs: CodexInstallFs = {
  readFile: (p) => readFile(p, 'utf8'),
  writeFile: (p, d) => writeFile(p, d, 'utf8'),
  mkdir: (p, o) => mkdir(p, o).then(() => undefined),
  access: (p) => access(p),
  unlink: (p) => unlink(p),
}

/** Sentinel pseudo-option value: selecting it installs every model. */
const SELECT_ALL_SENTINEL = '__select_all__'

/**
 * Resolve the multi-select result into the real slug list.
 * If the "Select all" sentinel is present, install every model
 * (individual toggles are ignored). Otherwise pass through, dropping the sentinel.
 */
export function resolveSelectedModels(rawSelected: string[], allSlugs: string[]): string[] {
  if (rawSelected.includes(SELECT_ALL_SENTINEL)) return [...allSlugs]
  return rawSelected.filter((slug) => slug !== SELECT_ALL_SENTINEL)
}

/** Replicates clack's internal default autocomplete filter (label/hint/value includes). */
function defaultClackFilter(
  search: string,
  option: { label?: unknown; value: unknown; hint?: string },
): boolean {
  if (!search) return true
  const label = String(option.label ?? option.value ?? '').toLowerCase()
  const hint = (option.hint ?? '').toLowerCase()
  const value = String(option.value).toLowerCase()
  const needle = search.toLowerCase()
  return label.includes(needle) || hint.includes(needle) || value.includes(needle)
}

function defaultPrompts(): CodexInstallPrompts {
  return {
    async selectModels(models) {
      const slugs = models.map((m) => m.slug)
      const allOption = {
        value: SELECT_ALL_SENTINEL,
        label: 'Select all',
        hint: 'install every model',
      }
      const modelOptions = models.map((m) => ({
        value: m.slug,
        label: m.display_name,
        hint: m.slug,
      }))
      const selected = await clack.autocompleteMultiselect({
        message: 'Select models to install',
        options: [allOption, ...modelOptions],
        initialValues: [],
        required: true,
        placeholder: 'Type to search models...',
        // Keep "Select all" always visible; real options match by clack's default rule.
        filter: (search, option) =>
          option.value === SELECT_ALL_SENTINEL ? true : defaultClackFilter(search, option),
      })
      if (clack.isCancel(selected)) return null
      return resolveSelectedModels(selected as string[], slugs)
    },
    async selectDefaultModel(models) {
      const selected = await clack.autocomplete({
        message: 'Select default model',
        options: models.map((m) => ({ value: m.slug, label: m.display_name, hint: m.slug })),
        initialValue: models[0]!.slug,
        placeholder: 'Type to search models...',
      })
      if (clack.isCancel(selected)) return null
      return selected as string
    },
  }
}

/** Run the codex install flow. Pure-ish: all I/O injectable. */
export async function runCodexInstall(options: CodexInstallOptions): Promise<void> {
  const fs = options.fs ?? defaultFs
  const prompts = options.prompts ?? defaultPrompts()
  clack.intro('llm-proxy codex install')

  // 1. Load settings.
  let settings: Settings
  try {
    settings = await loadSettingsFromFile(options.settingsPath)
  } catch (err) {
    clack.log.error(`Failed to load settings: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }

  const codexHome = options.codexHome ?? resolveCodexHome()
  const configPath = resolveCodexConfigPath(codexHome)
  const catalogPath = resolveCodexCatalogPath(codexHome)

  // 2. config.toml must exist (never create it).
  try {
    await fs.access(configPath)
  } catch {
    clack.log.error(`Codex config not found at ${configPath}. Run codex once first to create it.`)
    clack.outro('Aborted')
    return
  }

  // 3. Build catalog locally (no server required): run `codex debug models --bundled`
  //    via CodexCatalogCache, then merge settings providers into CodexModelInfo[].
  const baseUrl = buildCodexBaseUrl(settings)
  clack.log.step('Building model catalog from local codex CLI...')
  let modelsRes: { models: CodexModelInfo[] }
  try {
    const catalog = await new CodexCatalogCache(options.catalogFetcher).get()
    modelsRes = buildCodexModelsResponse(settings, catalog)
  } catch (err) {
    clack.log.error(mapCatalogError(err))
    clack.outro('Aborted')
    return
  }

  // 4. Non-empty catalog.
  if (modelsRes.models.length === 0) {
    clack.log.error(
      'Proxy returned an empty model catalog. Configure at least one provider/model in settings.jsonc.',
    )
    clack.outro('Aborted')
    return
  }

  // 5. Select models to install (skip the prompt when the catalog has a single model).
  let subsetSlugs: string[] | null
  if (modelsRes.models.length === 1) {
    subsetSlugs = [modelsRes.models[0]!.slug]
  } else {
    try {
      subsetSlugs = await prompts.selectModels(modelsRes.models)
    } catch (err) {
      clack.log.error(`Model selection failed: ${err instanceof Error ? err.message : String(err)}`)
      clack.outro('Aborted')
      return
    }
  }
  if (subsetSlugs === null) {
    clack.cancel('Operation cancelled')
    return
  }
  // Guard the prompt-injection seam: subset must be non-empty and every slug must be in the catalog.
  if (
    subsetSlugs.length === 0 ||
    !subsetSlugs.every((s) => modelsRes.models.some((m) => m.slug === s))
  ) {
    clack.log.error('Invalid model selection')
    clack.outro('Aborted')
    return
  }
  const slugs: string[] = subsetSlugs
  const subset = modelsRes.models.filter((m) => slugs.includes(m.slug))

  // 6. Select default model (skip the prompt when the subset has a single model).
  let defaultSlug: string
  if (subset.length === 1) {
    defaultSlug = subset[0]!.slug
  } else {
    let picked: string | null
    try {
      picked = await prompts.selectDefaultModel(subset)
    } catch (err) {
      clack.log.error(
        `Default model selection failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      clack.outro('Aborted')
      return
    }
    if (picked === null) {
      clack.cancel('Operation cancelled')
      return
    }
    // Guard the prompt-injection seam: the default must be one of the selected models.
    if (!subset.some((m) => m.slug === picked)) {
      clack.log.error(`Selected default model "${picked}" is not in the selection`)
      clack.outro('Aborted')
      return
    }
    defaultSlug = picked
  }

  // 7. Read every input before the first write, so preflight failures leave CODEX_HOME unchanged.
  let rawConfig: string
  let promptContents: string[]
  try {
    ;[rawConfig, promptContents] = await Promise.all([
      fs.readFile(configPath),
      Promise.all(CODEX_PROMPT_ASSETS.map((asset) => fs.readFile(asset.sourcePath))),
    ])
  } catch (err) {
    clack.log.error(`Failed to read install inputs: ${formatError(err)}`)
    clack.outro('Aborted')
    return
  }
  const { providerId, providerName, requiresOpenaiAuth, checkForUpdateOnStartup } =
    settings.codex.install
  // 从已构建 catalog 中取默认模型的 default_reasoning_level（非空字符串时写入 config.toml）
  const defaultModel = modelsRes.models.find((m) => m.slug === defaultSlug)
  const reasoningLevel = defaultModel?.default_reasoning_level
  const { content: newConfig, overwritten } = applyCodexConfigEdits(rawConfig, {
    catalogFilename: DEFAULT_CATALOG_FILENAME,
    providerId,
    providerName,
    baseUrl,
    wireApi: 'responses',
    modelSlug: defaultSlug,
    ...(settings.codex.install.systemPrompt
      ? {
          modelInstructionsFile: `${PROMPTS_DIRECTORY}/${getCodexPromptAsset(settings.codex.install.systemPrompt).filename}`,
        }
      : {}),
    requiresOpenaiAuth,
    checkForUpdateOnStartup,
    ...(reasoningLevel ? { modelReasoningEffort: reasoningLevel } : {}),
  })
  for (const report of overwritten) {
    clack.log.warn(`Overwrote ${report.key}: ${report.oldValue} → ${report.newValue}`)
  }
  // 8. Install prompts, catalog, and config. The legacy catalog remains until all writes succeed.
  try {
    await fs.mkdir(resolveCodexPromptsDirectory(codexHome), { recursive: true })
    for (const [index, asset] of CODEX_PROMPT_ASSETS.entries()) {
      await fs.writeFile(resolveCodexPromptPath(asset.filename, codexHome), promptContents[index]!)
    }
    await fs.writeFile(catalogPath, JSON.stringify({ models: subset }, null, 2))
    await fs.writeFile(configPath, newConfig)
  } catch (err) {
    clack.log.error(`Failed to write Codex install files: ${formatError(err)}`)
    clack.outro('Aborted')
    return
  }
  clack.log.step(`Installed system prompts → ${resolveCodexPromptsDirectory(codexHome)}`)
  clack.log.step(
    `Wrote catalog (${subset.length} model${subset.length === 1 ? '' : 's'}) → ${catalogPath}`,
  )
  clack.log.success(`Updated ${configPath}`)

  // 9. Remove the old root-level catalog only after the new installation is active.
  const legacyCatalogPath = resolveLegacyCodexCatalogPath(codexHome)
  try {
    await fs.unlink(legacyCatalogPath)
    clack.log.step(`Removed legacy catalog → ${legacyCatalogPath}`)
  } catch (err) {
    if (!isNotFoundError(err)) {
      clack.log.error(`Install succeeded, but legacy catalog cleanup failed: ${formatError(err)}`)
      clack.outro('Done with cleanup warning. Restart codex to load the new configuration.')
      return
    }
  }
  clack.outro('Done. Restart codex to load the new catalog and provider.')
}

function formatError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err)
}

function isNotFoundError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

/** Map catalog build errors to user-facing messages. */
function mapCatalogError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // execFile 失败：codex CLI 未装（ENOENT）/ 超时 / 非零退出
  if (message.includes('ENOENT')) {
    return `Failed to run 'codex debug models --bundled': codex CLI not found. Is it installed and on PATH?`
  }
  // buildCodexModelsResponse：settings 配的 templateSlug 不在 catalog
  if (message.includes('template slug not in catalog')) {
    return `${message} — check the 'codex.models_catalog.templateSlug' setting (global/provider/model layers).`
  }
  // CodexCatalogCache：stdout 畸形 / schema 校验失败 / 其他
  return `Failed to build codex catalog: ${message}`
}
