import { homedir } from 'node:os'
import { join } from 'node:path/posix'

export const DEFAULT_CATALOG_FILENAME = 'llm-proxy-model-catalog.json'

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
