import { homedir } from 'node:os'
import { join } from 'node:path/posix'

export const DEFAULT_CATALOG_FILENAME = 'llm-proxy/model-catalog.json'
export const LEGACY_CATALOG_FILENAME = 'llm-proxy-model-catalog.json'
export const PROMPTS_DIRECTORY = 'llm-proxy/prompts'

/** Resolve $CODEX_HOME (default ~/.codex). Empty env value falls back to default. */
export function resolveCodexHome(): string {
  const env = process.env.CODEX_HOME
  if (env && env.trim() !== '') return env
  return join(homedir(), '.codex')
}

/** Path to ~/.codex/config.toml. */
export function resolveCodexConfigPath(codexHome: string = resolveCodexHome()): string {
  return join(codexHome, 'config.toml')
}

/** Path to the model catalog JSON file inside codex home. */
export function resolveCodexCatalogPath(
  codexHome: string = resolveCodexHome(),
  filename: string = DEFAULT_CATALOG_FILENAME,
): string {
  return join(codexHome, filename)
}

/** Path to the pre-directory-layout catalog, used only for migration cleanup. */
export function resolveLegacyCodexCatalogPath(codexHome: string = resolveCodexHome()): string {
  return join(codexHome, LEGACY_CATALOG_FILENAME)
}

/** Path to an installed system prompt inside the llm-proxy directory. */
export function resolveCodexPromptPath(
  filename: string,
  codexHome: string = resolveCodexHome(),
): string {
  return join(codexHome, PROMPTS_DIRECTORY, filename)
}

/** Directory containing the installed llm-proxy system prompts. */
export function resolveCodexPromptsDirectory(codexHome: string = resolveCodexHome()): string {
  return join(codexHome, PROMPTS_DIRECTORY)
}
