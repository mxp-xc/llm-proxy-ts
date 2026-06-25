import { Command } from 'commander'
import * as clack from '@clack/prompts'
import { z } from 'zod/v3'
import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { codexModelInfoSchema } from '../codex-types.js'
import type { CodexModelInfo } from '../codex-types.js'
import { loadSettingsFromFile } from '../config.js'
import type { Settings } from '../config.js'
import { resolveCliContext } from './context.js'
import { resolveCodexHome, resolveCodexConfigPath, resolveCodexCatalogPath, DEFAULT_CATALOG_FILENAME } from './codex-home.js'
import { applyCodexConfigEdits } from './codex-toml.js'

const codexModelsResponseSchema = z.object({ models: z.array(codexModelInfoSchema) })

export type CodexEndpointErrorKind = 'network' | 'http503' | 'http' | 'parse'

export class CodexEndpointError extends Error {
  constructor(
    public kind: CodexEndpointErrorKind,
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message)
    this.name = 'CodexEndpointError'
  }
}

/** Build the codex base URL from service settings (no trailing slash; IPv6 bracketed). */
export function buildCodexBaseUrl(settings: Settings): string {
  const { host, port } = settings.service
  const bracketed = host.includes(':') ? `[${host}]` : host
  return `http://${bracketed}:${port}/codex/v1`
}

/** Fetch and validate the /codex/v1/models response. Throws typed CodexEndpointError. */
export async function fetchCodexModelsResponse(args: {
  url: string
  fetchImpl?: typeof fetch
}): Promise<{ models: CodexModelInfo[] }> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch
  let res: Response
  try {
    res = await fetchImpl(args.url)
  } catch (err) {
    throw new CodexEndpointError('network', err instanceof Error ? err.message : String(err))
  }
  if (res.status === 503) {
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error?: { message?: string } }).error?.message ?? 'unknown')
        : 'unknown'
    throw new CodexEndpointError('http503', message, 503, body)
  }
  if (!res.ok) {
    // Consume the response body to avoid leaking the connection (mirrors the 503 branch).
    await res.text().catch(() => {})
    throw new CodexEndpointError('http', `HTTP ${res.status}`, res.status)
  }
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    throw new CodexEndpointError('parse', err instanceof Error ? err.message : String(err))
  }
  const parsed = codexModelsResponseSchema.safeParse(json)
  if (!parsed.success) {
    throw new CodexEndpointError('parse', parsed.error.message)
  }
  return { models: parsed.data.models }
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
  fetchImpl?: typeof fetch
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

  // 3. Fetch catalog.
  const baseUrl = buildCodexBaseUrl(settings)
  clack.log.step(`Fetching model catalog from ${baseUrl}...`)
  let modelsRes: { models: CodexModelInfo[] }
  try {
    const fetchArgs: { url: string; fetchImpl?: typeof fetch } = { url: `${baseUrl}/models` }
    if (options.fetchImpl !== undefined) fetchArgs.fetchImpl = options.fetchImpl
    modelsRes = await fetchCodexModelsResponse(fetchArgs)
  } catch (err) {
    if (err instanceof CodexEndpointError) {
      const msg = mapEndpointError(err)
      clack.log.error(msg)
    } else {
      clack.log.error(`Failed to fetch catalog: ${err instanceof Error ? err.message : String(err)}`)
    }
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

function mapEndpointError(err: CodexEndpointError): string {
  switch (err.kind) {
    case 'network':
      return `Could not connect to the proxy at the configured address. Is it running? Start it with: pnpm dev serve`
    case 'http503':
      return `Proxy could not build the codex catalog (${err.message}). Is codex CLI installed and on PATH on the host?`
    case 'http':
      return `Unexpected response from /codex/v1/models: ${err.status}`
    case 'parse':
      return `Malformed response from proxy: ${err.message}`
  }
}

export function createCodexInstallCommand(): Command {
  return new Command('install')
    .description('Install llm-proxy as a codex model provider in ~/.codex/config.toml')
    .action(async () => {
      const { settingsPath } = resolveCliContext()
      await runCodexInstall({ settingsPath })
    })
}
