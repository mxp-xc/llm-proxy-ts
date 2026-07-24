import { assistantModelMessageSchema, toolModelMessageSchema, userModelMessageSchema } from 'ai'
import { describe, expect, it } from 'vitest'
import type { ProtocolMessagePart } from '../../../src/providers/shared/aisdk-types.js'
import {
  mapOpenAIChatRequestToAISDKInput,
  validateOpenAIChatRequest,
} from '../../../src/providers/openai-compatible/protocol.js'

describe('OpenAI chat protocol mapping', () => {
  it('validates required model and messages', () => {
    const parsed = validateOpenAIChatRequest({
      model: 'openrouter/chat',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(parsed.model).toBe('openrouter/chat')
    expect(parsed.messages).toHaveLength(1)
  })

  it('maps common OpenAI parameters to AI SDK settings', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      top_p: 0.9,
      max_completion_tokens: 123,
      stop: ['END'],
    })

    expect(input).toMatchObject({
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 123,
      stopSequences: ['END'],
    })
  })

  it('maps OpenAI image_url content to AI SDK file parts without changing order', () => {
    const dataUrl = 'data:image/png;base64,AA=='
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'before' },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            { type: 'text', text: 'between' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/image.png', detail: 'auto' },
            },
            { type: 'text', text: 'after' },
          ],
        },
      ],
    })

    expect(input.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'before' },
        {
          type: 'file',
          mediaType: 'image',
          data: dataUrl,
          providerOptions: {
            openai: { imageDetail: 'high' },
            openaiCompatible: { imageDetail: 'high' },
          },
        },
        { type: 'text', text: 'between' },
        {
          type: 'file',
          mediaType: 'image',
          data: new URL('https://example.com/image.png'),
          providerOptions: {
            openai: { imageDetail: 'auto' },
            openaiCompatible: { imageDetail: 'auto' },
          },
        },
        { type: 'text', text: 'after' },
      ],
    })
    expect(userModelMessageSchema.safeParse(input.messages[0]).success).toBe(true)
  })

  it('leaves unsupported image URL schemes and unknown parts unchanged', () => {
    const content = [
      { type: 'image_url', image_url: { url: 'file:///C:/secret.png', detail: 'high' } },
      { type: 'image_url', image_url: { url: 'ftp://example.com/image.png' } },
      { type: 'custom', value: 'kept' },
    ]
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [{ role: 'user', content }],
    })

    expect(input.messages[0]).toEqual({ role: 'user', content })
  })

  it('maps function tools without execute handlers', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    })

    expect(Object.keys(input.tools ?? {})).toEqual(['get_weather'])
    expect(input.toolChoice).toEqual({ type: 'tool', toolName: 'get_weather' })
    expect(input.tools?.get_weather).not.toHaveProperty('execute')
  })

  it('maps assistant tool calls to AI SDK message parts', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
      ],
    })

    expect(input.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            input: { city: 'NYC' },
          },
        ],
      },
    ])
    expect(assistantModelMessageSchema.safeParse(input.messages[0]).success).toBe(true)
  })

  it('keeps assistant text when mapping assistant messages with tool calls', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [
        {
          role: 'assistant',
          content: 'I will call the weather tool.',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
      ],
    })

    expect(input.messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will call the weather tool.' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'get_weather',
          input: { city: 'NYC' },
        },
      ],
    })
    expect(assistantModelMessageSchema.safeParse(input.messages[0]).success).toBe(true)
  })

  it('maps assistant reasoning_content to an AI SDK reasoning part', () => {
    const request = validateOpenAIChatRequest({
      model: 'openrouter/reasoning-model',
      messages: [
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'thinking step by step',
        },
      ],
    })

    const input = mapOpenAIChatRequestToAISDKInput(request)

    expect(input.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'thinking step by step' }],
    })
    expect(assistantModelMessageSchema.safeParse(input.messages[0]).success).toBe(true)
  })

  it('maps assistant content parts and refusal to AI SDK text parts', () => {
    const request = validateOpenAIChatRequest({
      model: 'openrouter/reasoning-model',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'partial answer' },
            { type: 'reasoning', text: 'legacy content reasoning' },
            { type: 'refusal', refusal: 'cannot provide that' },
          ],
          reasoning: 'brief reasoning',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'safe_alternative', arguments: '{}' },
            },
          ],
        },
      ],
    })

    const input = mapOpenAIChatRequestToAISDKInput(request)

    expect(input.messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'brief reasoning' },
        { type: 'text', text: 'partial answer' },
        { type: 'reasoning', text: 'legacy content reasoning' },
        { type: 'text', text: 'cannot provide that' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'safe_alternative',
          input: {},
        },
      ],
    })
    expect(assistantModelMessageSchema.safeParse(input.messages[0]).success).toBe(true)
  })

  it('accepts a top-level assistant refusal without content', () => {
    const request = validateOpenAIChatRequest({
      model: 'openrouter/chat',
      messages: [{ role: 'assistant', content: null, refusal: 'cannot provide that' }],
    })

    const input = mapOpenAIChatRequestToAISDKInput(request)

    expect(input.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'cannot provide that' }],
    })
    expect(assistantModelMessageSchema.safeParse(input.messages[0]).success).toBe(true)
  })

  it('accepts assistant content null with tool_calls', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
      ],
    })
    expect(input.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            input: { city: 'NYC' },
          },
        ],
      },
    ])
  })

  it('resolves toolName from assistant tool_calls for tool result messages', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
    })
    const toolResult = (input.messages[2] as { content: ProtocolMessagePart[] }).content[0]
    expect(toolResult).toEqual({
      type: 'tool-result',
      toolCallId: 'call_1',
      toolName: 'get_weather',
      output: { type: 'text', value: 'sunny' },
    })
  })

  it('rejects assistant null content without tool calls', () => {
    expect(() =>
      validateOpenAIChatRequest({
        model: 'openrouter/chat',
        messages: [{ role: 'assistant', content: null }],
      }),
    ).toThrow()
  })

  it('rejects assistant messages without content or tool calls', () => {
    expect(() =>
      validateOpenAIChatRequest({
        model: 'openrouter/chat',
        messages: [{ role: 'assistant' }],
      }),
    ).toThrow()
  })

  it('rejects tool messages without a non-empty tool_call_id', () => {
    expect(() =>
      validateOpenAIChatRequest({
        model: 'openrouter/chat',
        messages: [{ role: 'tool', content: 'sunny' }],
      }),
    ).toThrow()

    expect(() =>
      validateOpenAIChatRequest({
        model: 'openrouter/chat',
        messages: [{ role: 'tool', tool_call_id: '', content: 'sunny' }],
      }),
    ).toThrow()
  })

  it('rejects tool messages without content', () => {
    expect(() =>
      validateOpenAIChatRequest({
        model: 'openrouter/chat',
        messages: [{ role: 'tool', tool_call_id: 'call_1' }],
      }),
    ).toThrow()
  })

  it('maps tool results to the AI SDK v6 accepted output shape', () => {
    const textInput = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'sunny' }],
    })
    const jsonInput = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_2',
          content: [{ temp: 72 } as Record<string, unknown>],
        },
      ],
    })

    expect(textInput.messages[0]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'call_1',
          output: { type: 'text', value: 'sunny' },
        },
      ],
    })
    expect(jsonInput.messages[0]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_2',
          toolName: 'call_2',
          output: { type: 'json', value: [{ temp: 72 }] },
        },
      ],
    })
    expect(toolModelMessageSchema.safeParse(textInput.messages[0]).success).toBe(true)
    expect(toolModelMessageSchema.safeParse(jsonInput.messages[0]).success).toBe(true)
  })

  it('maps provider-specific fields into providerOptions.openaiCompatible', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [{ role: 'user', content: 'hello' }],
      parallel_tool_calls: false,
      reasoning: { effort: 'high' },
      extra_body: { include_reasoning: true },
    })

    expect(input.providerOptions).toEqual({
      openaiCompatible: {
        parallel_tool_calls: false,
        reasoning: { effort: 'high' },
        extra_body: { include_reasoning: true },
      },
      openai: {
        parallelToolCalls: false,
      },
    })
  })

  it('maps reasoning_effort for an OpenAI Responses cross-route', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openai/reasoning-model',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'high',
    })

    expect(input.providerOptions).toEqual({
      openaiCompatible: { reasoning_effort: 'high' },
      openai: {
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
      },
    })
  })

  it('does not request a reasoning summary when reasoning_effort is none', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openai/reasoning-model',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'none',
    })

    expect(input.providerOptions).toEqual({
      openaiCompatible: { reasoning_effort: 'none' },
      openai: { reasoningEffort: 'none' },
    })
  })

  it('does not set providerOptions when no provider-specific or passthrough fields', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(input.providerOptions).toBeUndefined()
  })

  it('extracts system role messages from messages array into input.system', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hello' },
      ],
    })

    expect(input.system).toBe('You are a helpful assistant.')
    expect(input.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('joins multiple system messages with newline into input.system', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hello' },
      ],
    })

    expect(input.system).toBe('You are a helpful assistant.\nBe concise.')
    expect(input.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('does not set input.system when no system messages are present', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(input.system).toBeUndefined()
  })

  it('extracts system message with array content into input.system', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'You are a helpful assistant.' },
            { type: 'text', text: 'Always respond in JSON.' },
          ],
        },
        { role: 'user', content: 'hello' },
      ],
    })

    expect(input.system).toBe('You are a helpful assistant.\nAlways respond in JSON.')
    expect(input.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('ignores system messages with empty or undefined content', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [{ role: 'system' }, { role: 'user', content: 'hello' }],
    })

    expect(input.system).toBeUndefined()
    expect(input.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('extracts system messages regardless of position in the array', () => {
    const input = mapOpenAIChatRequestToAISDKInput({
      model: 'openrouter/chat',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'system', content: 'Be precise' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ],
    })

    expect(input.system).toBe('Be precise')
    expect(input.messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ])
  })
})
