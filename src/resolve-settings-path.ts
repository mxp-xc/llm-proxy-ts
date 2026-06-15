import { resolve } from 'node:path'

export interface ResolveSettingsPathOptions {
  rootDir: string
  cwd?: string
  envSettingsFile?: string
}

export function resolveSettingsPath({
  rootDir,
  cwd = process.cwd(),
  envSettingsFile = process.env.LLM_PROXY_SETTINGS_FILE,
}: ResolveSettingsPathOptions): string {
  if (envSettingsFile) {
    return resolve(cwd, envSettingsFile)
  }
  return resolve(rootDir, 'config/settings.jsonc')
}
