import { describe, expect, it } from 'vitest'
import { openaiResponsesStrategy } from '../../../src/providers/openai-responses/strategy.js'
import {
  applyUnsupportedOpenAIResponsesVisionInput,
  planUnsupportedOpenAIResponsesVisionInput,
} from '../../../src/providers/openai-responses/vision-input.js'
import type {
  VisionArtifactUnavailableReason,
  VisionToolResultReplacement,
} from '../../../src/providers/shared/strategy.js'

function storedReplacement(text: string, artifactId: string): VisionToolResultReplacement {
  return { text, artifactStatus: 'stored', artifactId }
}

function unavailableReplacement(
  text: string,
  unavailableReason: VisionArtifactUnavailableReason,
): VisionToolResultReplacement {
  return { text, artifactStatus: 'unavailable', unavailableReason }
}

describe('OpenAI Responses vision input filtering', () => {
  it('is mounted on the protocol strategy', () => {
    expect(openaiResponsesStrategy.visionInputProtocol).toBe('openai-responses')
    expect(openaiResponsesStrategy.planUnsupportedVisionInput).toBe(
      planUnsupportedOpenAIResponsesVisionInput,
    )
    expect(openaiResponsesStrategy.applyUnsupportedVisionInput).toBe(
      applyUnsupportedOpenAIResponsesVisionInput,
    )
  })

  it('keeps input_file, opaque fields, tool arguments, and string lookalikes untouched', () => {
    const body = {
      model: 'text-only',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_file', file_id: 'file_1' },
            { type: 'input_text', text: 'data:image/png;base64,leave-me-alone' },
            { type: 'custom', payload: { type: 'input_image' } },
          ],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'inspect',
          arguments: '{"type":"input_image"}',
        },
        {
          type: 'custom_tool_call',
          call_id: 'call_2',
          name: 'patch',
          input: { nested: { type: 'input_image' }, file_path: 'image.png' },
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '[{"type":"input_image"}]',
        },
        {
          type: 'reasoning',
          opaque: { type: 'input_image' },
          content: [{ type: 'input_image', image_url: 'ignored-container' }],
        },
      ],
    }

    const plan = planUnsupportedOpenAIResponsesVisionInput(body)
    const result = applyUnsupportedOpenAIResponsesVisionInput(plan, new Map())

    expect(plan).toEqual({ body, imageCount: 0, toolResultImages: [] })
    expect(plan.body).toBe(body)
    expect(result).toEqual({
      body,
      changes: [],
      removedImageCount: 0,
      affectedMessageCount: 0,
      fallbackNoticeCount: 0,
    })
    expect(result.body).toBe(body)
  })

  it('removes ordinary easy-input and agent-message images and rejects blank results', () => {
    const body = {
      model: 'text-only',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: 'user-image' },
            { type: 'input_text', text: 'keep user text' },
          ],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'input_image', image_url: 'assistant-image' },
            { type: 'text', text: 'keep assistant text' },
          ],
        },
        {
          type: 'agent_message',
          author: 'agent-a',
          recipient: 'agent-b',
          content: [
            { type: 'output_text', text: 'keep agent text' },
            { type: 'input_image', image_url: 'agent-image' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'input_file', file_id: 'not-usable-as-text' },
            { type: 'input_text', text: ' \t ' },
            { type: 'input_image', image_url: 'user-only-image' },
          ],
        },
        {
          type: 'agent_message',
          author: 'agent-c',
          recipient: 'agent-d',
          content: [
            { type: 'text', text: ' \n ' },
            { type: 'input_image', image_url: 'agent-only-image' },
          ],
        },
        { type: 'reasoning', encrypted_content: 'unchanged' },
      ],
    }
    const original = structuredClone(body)

    const plan = planUnsupportedOpenAIResponsesVisionInput(body)
    const result = applyUnsupportedOpenAIResponsesVisionInput(plan, new Map())
    const filtered = result.body as { input: Array<Record<string, unknown>> }

    expect(plan).toMatchObject({
      body,
      imageCount: 5,
      toolResultImages: [],
      rejection: 'unsupported_vision_input',
    })
    expect(result.body).not.toBe(body)
    expect(filtered.input).not.toBe(body.input)
    expect(filtered.input[0]).not.toBe(body.input[0])
    expect(filtered.input[5]).toBe(body.input[5])
    expect(body).toEqual(original)
    expect(filtered.input[0]!.content).toEqual([{ type: 'input_text', text: 'keep user text' }])
    expect(filtered.input[2]!.content).toEqual([{ type: 'output_text', text: 'keep agent text' }])
    expect(filtered.input[3]!.content).toEqual([
      { type: 'input_file', file_id: 'not-usable-as-text' },
      { type: 'input_text', text: ' \t ' },
    ])
    expect(result).toMatchObject({
      removedImageCount: 5,
      affectedMessageCount: 5,
      fallbackNoticeCount: 0,
      rejection: 'unsupported_vision_input',
    })
    expect(result.changes).toEqual([
      {
        action: 'remove_image',
        path: '/input/0/content/0',
        role: 'user',
        blockType: 'input_image',
      },
      {
        action: 'remove_image',
        path: '/input/1/content/0',
        role: 'assistant',
        blockType: 'input_image',
      },
      {
        action: 'remove_image',
        path: '/input/2/content/1',
        blockType: 'input_image',
      },
      {
        action: 'remove_image',
        path: '/input/3/content/2',
        role: 'user',
        blockType: 'input_image',
      },
      {
        action: 'remove_image',
        path: '/input/4/content/1',
        blockType: 'input_image',
      },
    ])
  })

  it('classifies data URLs, remote URLs, file IDs, and unsupported tool-result sources', () => {
    const body = {
      input: [
        {
          type: 'function_call_output',
          output: [
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'input_image', image_url: { url: 'https://example.com/image.png' } },
            { type: 'input_image', file_id: 'file_123' },
            { type: 'input_image', url: 'data:image/jpeg;base64,BBBB' },
            { type: 'input_image', image_url: { unexpected: true } },
          ],
        },
      ],
    }

    const plan = planUnsupportedOpenAIResponsesVisionInput(body)

    expect(plan.body).toBe(body)
    expect(plan.imageCount).toBe(5)
    expect(plan.toolResultImages).toEqual([
      {
        path: '/input/0/output/0',
        source: { type: 'data_url', dataUrl: 'data:image/png;base64,AAAA' },
      },
      {
        path: '/input/0/output/1',
        source: { type: 'unavailable', reason: 'remote_url' },
      },
      {
        path: '/input/0/output/2',
        source: { type: 'unavailable', reason: 'file_id' },
      },
      {
        path: '/input/0/output/3',
        source: { type: 'data_url', dataUrl: 'data:image/jpeg;base64,BBBB' },
      },
      {
        path: '/input/0/output/4',
        source: { type: 'unavailable', reason: 'unsupported_source' },
      },
    ])
  })

  it('replaces image-only function and custom outputs with string notices', () => {
    const body = {
      input: [
        {
          type: 'function_call_output',
          call_id: 'call_function',
          output: [
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            { type: 'input_image', image_url: 'https://example.com/remote.png' },
          ],
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_custom',
          output: [{ type: 'input_image', file_id: 'file_1' }],
        },
      ],
    }
    const replacements = new Map<string, VisionToolResultReplacement>([
      ['/input/0/output/0', storedReplacement('Stored first image.', 'artifact_1')],
      ['/input/0/output/1', unavailableReplacement('Remote image was not stored.', 'remote_url')],
      ['/input/1/output/0', unavailableReplacement('File ID was not stored.', 'file_id')],
    ])

    const plan = planUnsupportedOpenAIResponsesVisionInput(body)
    const result = applyUnsupportedOpenAIResponsesVisionInput(plan, replacements)
    const filtered = result.body as { input: Array<Record<string, unknown>> }

    expect(filtered.input[0]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_function',
      output: 'Stored first image.\n\nRemote image was not stored.',
    })
    expect(filtered.input[1]).toMatchObject({
      type: 'custom_tool_call_output',
      call_id: 'call_custom',
      output: 'File ID was not stored.',
    })
    expect(result).toMatchObject({
      removedImageCount: 0,
      affectedMessageCount: 2,
      fallbackNoticeCount: 3,
    })
    expect(result.changes).toEqual([
      {
        action: 'replace_tool_result_image',
        path: '/input/0/output/0',
        blockType: 'input_image',
        containerType: 'function_call_output',
        artifactStatus: 'stored',
      },
      {
        action: 'replace_tool_result_image',
        path: '/input/0/output/1',
        blockType: 'input_image',
        containerType: 'function_call_output',
        artifactStatus: 'unavailable',
        unavailableReason: 'remote_url',
      },
      {
        action: 'replace_tool_result_image',
        path: '/input/1/output/0',
        blockType: 'input_image',
        containerType: 'custom_tool_call_output',
        artifactStatus: 'unavailable',
        unavailableReason: 'file_id',
      },
    ])
  })

  it('inserts input_text notices at mixed tool-output image positions copy-on-write', () => {
    const before = { type: 'input_text', text: 'before' }
    const opaque = { type: 'opaque', value: { nested: true } }
    const after = { type: 'output_text', text: 'after' }
    const body = {
      input: [
        {
          type: 'custom_tool_call_output',
          call_id: 'call_1',
          output: [
            before,
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            opaque,
            { type: 'input_image', image_url: 'https://example.com/image.png' },
            after,
          ],
        },
        { type: 'reasoning', encrypted_content: 'unchanged' },
      ],
    }
    const original = structuredClone(body)
    const replacements = new Map<string, VisionToolResultReplacement>([
      ['/input/0/output/1', storedReplacement('Stored at C:\\shared\\image.png.', 'artifact_1')],
      ['/input/0/output/3', unavailableReplacement('Remote image is unavailable.', 'remote_url')],
    ])

    const plan = planUnsupportedOpenAIResponsesVisionInput(body)
    const result = applyUnsupportedOpenAIResponsesVisionInput(plan, replacements)
    const filtered = result.body as { input: Array<Record<string, unknown>> }
    const output = filtered.input[0]!.output as unknown[]

    expect(result.body).not.toBe(body)
    expect(filtered.input).not.toBe(body.input)
    expect(filtered.input[0]).not.toBe(body.input[0])
    expect(filtered.input[1]).toBe(body.input[1])
    expect(output[0]).toBe(before)
    expect(output[2]).toBe(opaque)
    expect(output[4]).toBe(after)
    expect(body).toEqual(original)
    expect(output).toEqual([
      before,
      { type: 'input_text', text: '\n\nStored at C:\\shared\\image.png.\n\n' },
      opaque,
      { type: 'input_text', text: '\n\nRemote image is unavailable.\n\n' },
      after,
    ])
    expect(result).toMatchObject({
      removedImageCount: 0,
      affectedMessageCount: 1,
      fallbackNoticeCount: 2,
    })
    expect(result.changes.map((change) => change.path)).toEqual([
      '/input/0/output/1',
      '/input/0/output/3',
    ])
  })

  it('throws when a planned tool-result image has no replacement', () => {
    const body = {
      input: [
        {
          type: 'function_call_output',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
        },
      ],
    }
    const plan = planUnsupportedOpenAIResponsesVisionInput(body)

    expect(() => applyUnsupportedOpenAIResponsesVisionInput(plan, new Map())).toThrow(
      'Missing tool-result vision replacement for /input/0/output/0',
    )
  })
})
