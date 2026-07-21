import { describe, expect, it } from 'vitest'
import { anthropicStrategy } from '../../../src/providers/anthropic/strategy.js'
import {
  applyUnsupportedAnthropicVisionInput,
  planUnsupportedAnthropicVisionInput,
} from '../../../src/providers/anthropic/vision-input.js'
import type { VisionToolResultReplacement } from '../../../src/providers/shared/strategy.js'

const storedReplacement = (text: string, artifactId: string): VisionToolResultReplacement => ({
  text,
  artifactStatus: 'stored',
  artifactId,
})

const unavailableReplacement = (text: string): VisionToolResultReplacement => ({
  text,
  artifactStatus: 'unavailable',
  unavailableReason: 'storage_not_configured',
})

describe('Anthropic vision input filtering', () => {
  it('is mounted on the protocol strategy', () => {
    expect(anthropicStrategy.visionInputProtocol).toBe('anthropic-messages')
    expect(anthropicStrategy.planUnsupportedVisionInput).toBe(planUnsupportedAnthropicVisionInput)
    expect(anthropicStrategy.applyUnsupportedVisionInput).toBe(applyUnsupportedAnthropicVisionInput)
  })

  it('preserves identity for strings and image lookalikes inside tool input', () => {
    const body = {
      model: 'text-only',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'data:image/png;base64,leave-me-alone' },
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'read',
              input: { file_path: 'image.png', nested: { type: 'image' } },
            },
            { type: 'text', text: 'keep', metadata: { type: 'image' } },
          ],
        },
      ],
    }

    const plan = planUnsupportedAnthropicVisionInput(body)
    const result = applyUnsupportedAnthropicVisionInput(plan, new Map())

    expect(plan).toEqual({ body, imageCount: 0, toolResultImages: [] })
    expect(result.body).toBe(body)
    expect(result).toEqual({
      body,
      changes: [],
      removedImageCount: 0,
      affectedMessageCount: 0,
      fallbackNoticeCount: 0,
    })
  })

  it('classifies tool-result image sources and records their original paths', () => {
    const body = {
      model: 'text-only',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_sources',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                },
                {
                  type: 'image',
                  source: { type: 'url', url: 'data:image/jpeg;base64,BBBB' },
                },
                {
                  type: 'image',
                  source: { type: 'url', url: 'https://example.test/image.png' },
                },
                { type: 'image', source: { type: 'file', file_id: 'file_1' } },
              ],
            },
          ],
        },
      ],
    }

    const plan = planUnsupportedAnthropicVisionInput(body)

    expect(plan.body).toBe(body)
    expect(plan.imageCount).toBe(4)
    expect(plan.toolResultImages).toEqual([
      {
        path: '/messages/0/content/0/content/0',
        source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' },
      },
      {
        path: '/messages/0/content/0/content/1',
        source: { type: 'data_url', dataUrl: 'data:image/jpeg;base64,BBBB' },
      },
      {
        path: '/messages/0/content/0/content/2',
        source: { type: 'unavailable', reason: 'remote_url' },
      },
      {
        path: '/messages/0/content/0/content/3',
        source: { type: 'unavailable', reason: 'unsupported_source' },
      },
    ])
    expect(plan.rejection).toBeUndefined()
  })

  it('replaces tool-result images with notices in place and preserves correlation fields', () => {
    const body = {
      model: 'text-only',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'first' },
            },
            { type: 'text', text: 'keep this text' },
            { type: 'image', source: { type: 'url', url: 'second' } },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'unchanged' }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_mixed',
              is_error: false,
              content: [
                { type: 'text', text: 'before' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'nested' },
                },
                { type: 'text', text: 'after' },
              ],
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_image_only',
              is_error: false,
              content: [
                {
                  type: 'image',
                  source: { type: 'url', url: 'https://example.test/image.png' },
                },
              ],
            },
          ],
        },
      ],
    }
    const original = structuredClone(body)
    const plan = planUnsupportedAnthropicVisionInput(body)
    const replacements = new Map<string, VisionToolResultReplacement>([
      [
        '/messages/2/content/0/content/1',
        storedReplacement('Image saved at /shared/vision/artifact-1.png', 'artifact-1'),
      ],
      [
        '/messages/3/content/0/content/0',
        unavailableReplacement('Image could not be saved; use a text-capable MCP tool.'),
      ],
    ])

    const result = applyUnsupportedAnthropicVisionInput(plan, replacements)
    const filtered = result.body as typeof body
    const mixedToolResult = filtered.messages[2]!.content[0] as {
      tool_use_id: string
      is_error: boolean
      content: unknown
    }
    const imageOnlyToolResult = filtered.messages[3]!.content[0] as {
      tool_use_id: string
      is_error: boolean
      content: unknown
    }

    expect(plan.imageCount).toBe(4)
    expect(result.body).not.toBe(body)
    expect(filtered.messages).not.toBe(body.messages)
    expect(filtered.messages[0]).not.toBe(body.messages[0])
    expect(filtered.messages[1]).toBe(body.messages[1])
    expect(filtered.messages[2]).not.toBe(body.messages[2])
    expect(filtered.messages[3]).not.toBe(body.messages[3])
    expect(body).toEqual(original)
    expect(filtered.messages[0]!.content).toEqual([{ type: 'text', text: 'keep this text' }])
    expect(mixedToolResult).toMatchObject({
      tool_use_id: 'tool_mixed',
      is_error: false,
      content: [
        { type: 'text', text: 'before' },
        { type: 'text', text: '\n\nImage saved at /shared/vision/artifact-1.png\n\n' },
        { type: 'text', text: 'after' },
      ],
    })
    expect(imageOnlyToolResult).toMatchObject({
      tool_use_id: 'tool_image_only',
      is_error: false,
      content: 'Image could not be saved; use a text-capable MCP tool.',
    })
    expect(result).toMatchObject({
      removedImageCount: 2,
      affectedMessageCount: 3,
      fallbackNoticeCount: 2,
    })
    expect(result.rejection).toBeUndefined()
    expect(result.changes).toEqual([
      {
        action: 'remove_image',
        path: '/messages/0/content/0',
        role: 'user',
        blockType: 'image',
      },
      {
        action: 'remove_image',
        path: '/messages/0/content/2',
        role: 'user',
        blockType: 'image',
      },
      {
        action: 'replace_tool_result_image',
        path: '/messages/2/content/0/content/1',
        role: 'user',
        blockType: 'image',
        containerType: 'tool_result',
        artifactStatus: 'stored',
      },
      {
        action: 'replace_tool_result_image',
        path: '/messages/3/content/0/content/0',
        role: 'user',
        blockType: 'image',
        containerType: 'tool_result',
        artifactStatus: 'unavailable',
        unavailableReason: 'storage_not_configured',
      },
    ])
  })

  it('rejects a direct-image ordinary user message left with only blank text', () => {
    const body = {
      model: 'text-only',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'only-image' },
            },
            { type: 'text', text: ' \n ' },
          ],
        },
      ],
    }

    const plan = planUnsupportedAnthropicVisionInput(body)
    const result = applyUnsupportedAnthropicVisionInput(plan, new Map())

    expect(plan.rejection).toBe('unsupported_vision_input')
    expect(result.rejection).toBe('unsupported_vision_input')
    expect((result.body as typeof body).messages[0]!.content).toEqual([
      { type: 'text', text: ' \n ' },
    ])
    expect(result.removedImageCount).toBe(1)
    expect(result.affectedMessageCount).toBe(1)
    expect(result.fallbackNoticeCount).toBe(0)
  })

  it('does not reject a user message that maps only to tool results', () => {
    const body = {
      model: 'text-only',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'direct-image' },
            },
            { type: 'tool_result', tool_use_id: 'tool_1', content: '' },
          ],
        },
      ],
    }

    const plan = planUnsupportedAnthropicVisionInput(body)
    const result = applyUnsupportedAnthropicVisionInput(plan, new Map())

    expect(plan.rejection).toBeUndefined()
    expect((result.body as typeof body).messages[0]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tool_1', content: '' },
    ])
  })

  it('throws when a tool-result image replacement is missing', () => {
    const body = {
      model: 'text-only',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_1',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                },
              ],
            },
          ],
        },
      ],
    }
    const plan = planUnsupportedAnthropicVisionInput(body)

    expect(() => applyUnsupportedAnthropicVisionInput(plan, new Map())).toThrow(
      'Missing tool-result vision replacement for /messages/0/content/0/content/0',
    )
  })
})
