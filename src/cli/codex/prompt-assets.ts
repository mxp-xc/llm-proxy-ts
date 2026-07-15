import { fileURLToPath } from 'node:url'
import type { CodexPromptId } from '../../codex-types.js'

export interface CodexPromptAsset {
  id: CodexPromptId
  filename: string
  sourcePath: string
}

export const CODEX_PROMPT_ASSETS: readonly CodexPromptAsset[] = [
  {
    id: 'gpt-5.6',
    filename: 'gpt-5.6.md',
    sourcePath: fileURLToPath(new URL('./prompt-assets/gpt-5.6.md', import.meta.url)),
  },
  {
    id: 'gpt-5.5',
    filename: 'gpt-5.5.md',
    sourcePath: fileURLToPath(new URL('./prompt-assets/gpt-5.5.md', import.meta.url)),
  },
]

export function getCodexPromptAsset(id: CodexPromptId): CodexPromptAsset {
  return CODEX_PROMPT_ASSETS.find((asset) => asset.id === id)!
}
