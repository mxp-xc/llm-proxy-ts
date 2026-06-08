import { modify, applyEdits } from 'jsonc-parser'
import { writeFile } from 'node:fs/promises'
import type { ModelRouteInput } from '../config.js'

export interface WriteModelsOptions {
  settingsPath: string
  rawText: string
  providerName: string
  newModels: Record<string, ModelRouteInput>
}

export function computeModelsEdits(
  rawText: string,
  providerName: string,
  newModels: Record<string, ModelRouteInput>,
): string {
  const edits = modify(rawText, ['providers', providerName, 'models'], newModels, {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
    },
  })
  return applyEdits(rawText, edits)
}

export function applyMultipleProviderModels(
  rawText: string,
  changes: Array<{ providerName: string; newModels: Record<string, ModelRouteInput> }>,
): string {
  let current = rawText
  for (const { providerName, newModels } of changes) {
    current = computeModelsEdits(current, providerName, newModels)
  }
  return current
}

export async function writeSettingsFile(settingsPath: string, modifiedText: string): Promise<void> {
  await writeFile(settingsPath, modifiedText, 'utf8')
}
