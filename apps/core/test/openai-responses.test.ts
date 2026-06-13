import { describe, expect, it } from 'vitest'
import { mapResponsesRequestToAISDKInput, validateOpenAIResponsesRequest } from '../src/providers/openai-responses/protocol.js'

describe('validateOpenAIResponsesRequest', () => {
  it('rejects request without model', () => {
    expect(() => validateOpenAIResponsesRequest({ input: 'hello' })).toThrow()
  })

  it('rejects request without input', () => {
    expect(() => validateOpenAIResponsesRequest({ model: 'gpt-4o' })).toThrow()
  })

  it('accepts string input', () => {
    const result = validateOpenAIResponsesRequest({ model: 'gpt-4o', input: 'hello' })
    expect(result.model).toBe('gpt-4o')
    expect(result.input).toBe('hello')
  })

  it('accepts array of message items', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: [{ role: 'user', content: 'hello' }],
    })
    expect(result.input).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('accepts function_call_output item', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: [{ type: 'function_call_output', call_id: 'call_123', output: 'result' }],
    })
    expect(result.input).toEqual([{ type: 'function_call_output', call_id: 'call_123', output: 'result' }])
  })

  it('accepts function tools with flat structure', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: 'hello',
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
    })
    expect(result.tools![0]).toEqual({ type: 'function', name: 'get_weather', parameters: { type: 'object' } })
  })

  it('accepts tool_choice as string', () => {
    const result = validateOpenAIResponsesRequest({ model: 'gpt-4o', input: 'hi', tool_choice: 'auto' })
    expect(result.tool_choice).toBe('auto')
  })

  it('accepts tool_choice as function object', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o', input: 'hi',
      tool_choice: { type: 'function', name: 'get_weather' },
    })
    expect(result.tool_choice).toEqual({ type: 'function', name: 'get_weather' })
  })

  it('passes through unknown fields via passthrough', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o', input: 'hi', custom_field: 'value',
    })
    expect((result as any).custom_field).toBe('value')
  })
})

describe('mapResponsesRequestToAISDKInput', () => {
  it('maps string input to user message', () => {
    const result = mapResponsesRequestToAISDKInput({ model: 'gpt-4o', input: 'hello' })
    expect(result.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('maps instructions to system option', () => {
    const result = mapResponsesRequestToAISDKInput({ model: 'gpt-4o', input: 'hi', instructions: 'Be helpful' })
    expect(result.system).toBe('Be helpful')
    expect(result.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('maps message items preserving role', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    })
    expect(result.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('maps developer role to system option', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [{ role: 'developer', content: 'Be precise' }],
    })
    expect(result.system).toBe('Be precise')
    expect(result.messages).toEqual([])
  })

  it('merges instructions and developer role into system', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [{ type: 'message', role: 'developer', content: 'Be precise' }],
      instructions: 'Be helpful',
    })
    expect(result.system).toBe('Be helpful\nBe precise')
  })

  it('maps input_text content to AI SDK text type', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    })
    expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  })

  it('maps input_image content to AI SDK image type', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/img.png' }] }],
    })
    expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'image', image: 'https://example.com/img.png' }] }])
  })

  it('falls back tool_choice to auto when referencing non-function tool', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: 'hi',
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'web_search' },
    })
    expect(result.toolChoice).toBe('auto')
  })

  it('maps function_call_output to tool message', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [{ type: 'function_call_output', call_id: 'call_123', output: 'sunny' }],
    })
    expect(result.messages).toEqual([{
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call_123',
        toolName: 'call_123',
        output: { type: 'text', value: 'sunny' },
      }],
    }])
  })

  it('maps parameters — temperature, top_p, max_output_tokens', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o', input: 'hi',
      temperature: 0.7, top_p: 0.9, max_output_tokens: 100,
    })
    expect(result.temperature).toBe(0.7)
    expect(result.topP).toBe(0.9)
    expect(result.maxOutputTokens).toBe(100)
  })

  it('maps function tools — flat to ToolSet', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o', input: 'hi',
      tools: [{
        type: 'function', name: 'get_weather',
        description: 'Get weather', parameters: { type: 'object', properties: { location: { type: 'string' } } },
      }],
    })
    expect(result.tools).toBeDefined()
    expect(result.tools!['get_weather']).toBeDefined()
    expect(result.tools!['get_weather']!.description).toBe('Get weather')
  })

  it('maps tool_choice string values', () => {
    for (const choice of ['auto', 'none', 'required'] as const) {
      const result = mapResponsesRequestToAISDKInput({ model: 'gpt-4o', input: 'hi', tool_choice: choice })
      expect(result.toolChoice).toBe(choice)
    }
  })

  it('maps tool_choice function object', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o', input: 'hi',
      tool_choice: { type: 'function', name: 'get_weather' },
    })
    expect(result.toolChoice).toEqual({ type: 'tool', toolName: 'get_weather' })
  })

  it('passes unknown fields as providerOptions.openai', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o', input: 'hi', custom_param: 'value',
    })
    expect(result.providerOptions).toEqual({ openai: { custom_param: 'value' } })
  })

  it('maps parallel_tool_calls to providerOptions.openai.parallelToolCalls', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o', input: 'hi', parallel_tool_calls: false,
    })
    expect(result.providerOptions).toEqual({ openai: { parallelToolCalls: false } })
  })

  it('omits providerOptions when no unknown fields', () => {
    const result = mapResponsesRequestToAISDKInput({ model: 'gpt-4o', input: 'hi' })
    expect(result.providerOptions).toBeUndefined()
  })
})
