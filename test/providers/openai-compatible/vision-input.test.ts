import { describe, expect, it } from 'vitest'
import { openaiCompatibleStrategy } from '../../../src/providers/openai-compatible/strategy.js'
import {
  applyUnsupportedOpenAIChatVisionInput,
  planUnsupportedOpenAIChatVisionInput,
} from '../../../src/providers/openai-compatible/vision-input.js'
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

describe('OpenAI Chat vision input filtering', () => {
  it('is mounted on the protocol strategy', () => {
    expect(openaiCompatibleStrategy.visionInputProtocol).toBe('openai-chat-completions')
    expect(openaiCompatibleStrategy.planUnsupportedVisionInput).toBe(
      planUnsupportedOpenAIChatVisionInput,
    )
    expect(openaiCompatibleStrategy.applyUnsupportedVisionInput).toBe(
      applyUnsupportedOpenAIChatVisionInput,
    )
  })

  it('preserves identity when no allowlisted image block is present', () => {
    const body = {
      model: 'text-only',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'leave-me-alone' },
            { type: 'text', text: 'data:image/png;base64,leave-me-alone' },
            { type: 'custom', payload: { type: 'image_url' } },
          ],
        },
      ],
    }

    const plan = planUnsupportedOpenAIChatVisionInput(body)
    const result = applyUnsupportedOpenAIChatVisionInput(plan, new Map())

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
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_sources',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'image_url', image_url: 'data:image/jpeg;base64,BBBB' },
            { type: 'image_url', image_url: { url: 'https://example.test/image.png' } },
            { type: 'image_url', image_url: { detail: 'high' } },
          ],
        },
      ],
    }

    const plan = planUnsupportedOpenAIChatVisionInput(body)

    expect(plan.body).toBe(body)
    expect(plan.imageCount).toBe(4)
    expect(plan.toolResultImages).toEqual([
      {
        path: '/messages/0/content/0',
        source: { type: 'data_url', dataUrl: 'data:image/png;base64,AAAA' },
      },
      {
        path: '/messages/0/content/1',
        source: { type: 'data_url', dataUrl: 'data:image/jpeg;base64,BBBB' },
      },
      {
        path: '/messages/0/content/2',
        source: { type: 'unavailable', reason: 'remote_url' },
      },
      {
        path: '/messages/0/content/3',
        source: { type: 'unavailable', reason: 'unsupported_source' },
      },
    ])
    expect(plan.rejection).toBeUndefined()
  })

  it('replaces tool-result images with notices in place and preserves correlation fields', () => {
    const body = {
      model: 'text-only',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'first' } },
            { type: 'text', text: 'keep this text' },
            { type: 'image_url', image_url: { url: 'second' } },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'unchanged' }] },
        {
          role: 'tool',
          tool_call_id: 'call_mixed',
          content: [
            { type: 'text', text: 'before' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'text', text: 'after' },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_image_only',
          content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }],
        },
      ],
    }
    const original = structuredClone(body)
    const plan = planUnsupportedOpenAIChatVisionInput(body)
    const replacements = new Map<string, VisionToolResultReplacement>([
      [
        '/messages/2/content/1',
        storedReplacement('Image saved at /shared/vision/artifact-1.png', 'artifact-1'),
      ],
      [
        '/messages/3/content/0',
        unavailableReplacement('Image could not be saved; use a text-capable MCP tool.'),
      ],
    ])

    const result = applyUnsupportedOpenAIChatVisionInput(plan, replacements)
    const filtered = result.body as typeof body

    expect(plan.imageCount).toBe(4)
    expect(result.body).not.toBe(body)
    expect(filtered.messages).not.toBe(body.messages)
    expect(filtered.messages[0]).not.toBe(body.messages[0])
    expect(filtered.messages[1]).toBe(body.messages[1])
    expect(filtered.messages[2]).not.toBe(body.messages[2])
    expect(filtered.messages[3]).not.toBe(body.messages[3])
    expect(body).toEqual(original)
    expect(filtered.messages[0]!.content).toEqual([{ type: 'text', text: 'keep this text' }])
    expect(filtered.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_mixed',
      content: [
        { type: 'text', text: 'before' },
        { type: 'text', text: '\n\nImage saved at /shared/vision/artifact-1.png\n\n' },
        { type: 'text', text: 'after' },
      ],
    })
    expect(filtered.messages[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_image_only',
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
        blockType: 'image_url',
      },
      {
        action: 'remove_image',
        path: '/messages/0/content/2',
        role: 'user',
        blockType: 'image_url',
      },
      {
        action: 'replace_tool_result_image',
        path: '/messages/2/content/1',
        role: 'tool',
        blockType: 'image_url',
        containerType: 'tool_message',
        artifactStatus: 'stored',
      },
      {
        action: 'replace_tool_result_image',
        path: '/messages/3/content/0',
        role: 'tool',
        blockType: 'image_url',
        containerType: 'tool_message',
        artifactStatus: 'unavailable',
        unavailableReason: 'storage_not_configured',
      },
    ])
  })

  it('rejects an ordinary user message left with only blank text', () => {
    const body = {
      model: 'text-only',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: ' \t ' },
            { type: 'image_url', image_url: { url: 'only-image' } },
          ],
        },
      ],
    }

    const plan = planUnsupportedOpenAIChatVisionInput(body)
    const result = applyUnsupportedOpenAIChatVisionInput(plan, new Map())

    expect(plan.rejection).toBe('unsupported_vision_input')
    expect(result.rejection).toBe('unsupported_vision_input')
    expect((result.body as typeof body).messages[0]!.content).toEqual([
      { type: 'text', text: ' \t ' },
    ])
    expect(result.removedImageCount).toBe(1)
    expect(result.affectedMessageCount).toBe(1)
    expect(result.fallbackNoticeCount).toBe(0)
  })

  it('throws when a tool-result image replacement is missing', () => {
    const body = {
      model: 'text-only',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
    }
    const plan = planUnsupportedOpenAIChatVisionInput(body)

    expect(() => applyUnsupportedOpenAIChatVisionInput(plan, new Map())).toThrow(
      'Missing tool-result vision replacement for /messages/0/content/0',
    )
  })
})
