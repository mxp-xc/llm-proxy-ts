import type { VisionArtifactUnavailableReason, VisionToolResultReplacement } from './strategy.js'

export function isNonArrayRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function hasNonBlankTextBlock(
  content: readonly unknown[],
  textBlockTypes: readonly string[],
): boolean {
  return content.some((block) => {
    if (!isNonArrayRecord(block) || typeof block.type !== 'string') return false
    return (
      textBlockTypes.includes(block.type) &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0
    )
  })
}

export function requireVisionToolResultReplacement(
  replacements: ReadonlyMap<string, VisionToolResultReplacement>,
  path: string,
): VisionToolResultReplacement {
  const replacement = replacements.get(path)
  if (replacement === undefined) {
    throw new Error(`Missing tool-result vision replacement for ${path}`)
  }
  return replacement
}

export function toVisionToolResultChangeMetadata(
  replacement: VisionToolResultReplacement,
):
  | { artifactStatus: 'stored' }
  | { artifactStatus: 'unavailable'; unavailableReason: VisionArtifactUnavailableReason } {
  return replacement.artifactStatus === 'unavailable'
    ? {
        artifactStatus: replacement.artifactStatus,
        unavailableReason: replacement.unavailableReason,
      }
    : { artifactStatus: replacement.artifactStatus }
}
