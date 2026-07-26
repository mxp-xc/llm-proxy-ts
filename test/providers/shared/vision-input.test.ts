import { describe, expect, it } from 'vitest'
import type { VisionToolResultReplacement } from '../../../src/providers/shared/strategy.js'
import {
  hasNonBlankTextBlock,
  isNonArrayRecord,
  requireVisionToolResultReplacement,
  toVisionToolResultChangeMetadata,
} from '../../../src/providers/shared/vision-input.js'

describe('shared vision input helpers', () => {
  it('recognizes non-array records', () => {
    expect(isNonArrayRecord({})).toBe(true)
    expect(isNonArrayRecord(Object.create(null))).toBe(true)

    for (const value of [null, undefined, [], 'text', 1, true, () => undefined]) {
      expect(isNonArrayRecord(value)).toBe(false)
    }
  })

  it('finds trimmed text only in allowlisted block types', () => {
    const content = [
      null,
      [],
      { type: 'text', text: ' \t\n ' },
      { type: 'text', text: 42 },
      { type: 'output_text', text: 'available to another protocol' },
    ]

    expect(hasNonBlankTextBlock(content, ['text'])).toBe(false)
    expect(hasNonBlankTextBlock(content, ['text', 'output_text'])).toBe(true)
    expect(hasNonBlankTextBlock([{ type: 'text', text: ' usable ' }], ['text'])).toBe(true)
  })

  it('requires replacements by their original path', () => {
    const replacement: VisionToolResultReplacement = {
      text: 'Stored image.',
      artifactStatus: 'stored',
      artifactId: 'artifact_1',
    }
    const replacements = new Map([['/input/0/output/1', replacement]])

    expect(requireVisionToolResultReplacement(replacements, '/input/0/output/1')).toBe(replacement)
    expect(() => requireVisionToolResultReplacement(replacements, '/input/0/output/2')).toThrow(
      'Missing tool-result vision replacement for /input/0/output/2',
    )
  })

  it('maps stored and unavailable replacements to change metadata', () => {
    expect(
      toVisionToolResultChangeMetadata({
        text: 'Stored image.',
        artifactStatus: 'stored',
        artifactId: 'artifact_1',
      }),
    ).toEqual({ artifactStatus: 'stored' })
    expect(
      toVisionToolResultChangeMetadata({
        text: 'Image unavailable.',
        artifactStatus: 'unavailable',
        unavailableReason: 'remote_url',
      }),
    ).toEqual({ artifactStatus: 'unavailable', unavailableReason: 'remote_url' })
  })
})
