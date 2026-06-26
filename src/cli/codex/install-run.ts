import * as clack from '@clack/prompts'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import type { CodexModelInfo } from '../../codex-types.js'
import { CodexCatalogCache, buildCodexModelsResponse, type CodexCatalogFetcher } from '../../codex-catalog.js'
import { loadSettingsFromFile } from '../../config.js'
import type { Settings } from '../../config.js'
import { resolveCodexHome, resolveCodexConfigPath, resolveCodexCatalogPath, DEFAULT_CATALOG_FILENAME } from './home.js'
import { applyCodexConfigEdits } from './toml.js'

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
}

function defaultPrompts(): CodexInstallPrompts {
  return {
    async selectModels(models) {
      const slugs = models.map((m) => m.slug)
      const selected = await clack.autocompleteMultiselect({
        message: 'Select models to install',
        options: models.map((m) => ({ value: m.slug, label: m.display_name, hint: m.slug })),
        initialValues: slugs,
        required: true,
        placeholder: 'Type to search models...',
      })
      if (clack.isCancel(selected)) return null
      return selected as string[]
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
    clack.log.error('Proxy returned an empty model catalog. Configure at least one provider/model in settings.jsonc.')
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
      clack.log.error(`Default model selection failed: ${err instanceof Error ? err.message : String(err)}`)
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

  // 7. Write catalog file (only the selected subset).
  try {
    await fs.mkdir(codexHome, { recursive: true })
    await fs.writeFile(catalogPath, JSON.stringify({ models: subset }, null, 2))
  } catch (err) {
    clack.log.error(`Failed to write catalog: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }
  clack.log.step(`Wrote catalog (${subset.length} model${subset.length === 1 ? '' : 's'}) → ${catalogPath}`)

  // 8. Edit config.toml.
  let rawConfig: string
  try {
    rawConfig = await fs.readFile(configPath)
  } catch (err) {
    clack.log.error(`Failed to read config.toml: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }
  const { content: newConfig, overwritten } = applyCodexConfigEdits(rawConfig, {
    catalogFilename: DEFAULT_CATALOG_FILENAME,
    providerId: 'llm-proxy',
    providerName: 'LLM Proxy',
    baseUrl,
    wireApi: 'responses',
    modelSlug: defaultSlug,
  })
  for (const report of overwritten) {
    clack.log.warn(`Overwrote ${report.key}: ${report.oldValue} → ${report.newValue}`)
  }
  try {
    await fs.writeFile(configPath, newConfig)
  } catch (err) {
    clack.log.error(`Failed to write config.toml: ${err instanceof Error ? err.message : String(err)}`)
    clack.outro('Aborted')
    return
  }
  clack.log.success(`Updated ${configPath}`)
  clack.outro('Done. Restart codex to load the new catalog and provider.')
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
    return `${message} — check the 'codex.templateSlug' setting (global/provider/model layers).`
  }
  // CodexCatalogCache：stdout 畸形 / schema 校验失败 / 其他
  return `Failed to build codex catalog: ${message}`
}
