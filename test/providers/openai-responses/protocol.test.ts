import { describe, expect, it } from 'vitest'
import { mapResponsesRequestToAISDKInput, validateOpenAIResponsesRequest } from '../../../src/providers/openai-responses/protocol.js'

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

  it('accepts reasoning items in input (multi-turn)', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking...' }], content: null, encrypted_content: null },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      ],
    })
    expect(Array.isArray(result.input)).toBe(true)
    const items = result.input as Exclude<typeof result.input, string>
    expect(items[1]?.type).toBe('reasoning')
  })

  it('accepts function tools with flat structure', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: 'hello',
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object' } }],
    })
    expect(result.tools![0]).toEqual({ type: 'function', name: 'get_weather', parameters: { type: 'object' } })
  })

  it('accepts non-function tools (web_search, custom, namespace, tool_search) alongside function tools', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: 'hi',
      tools: [
        { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
        { type: 'web_search', search_content_types: ['text'] },
        { type: 'custom', name: 'apply_patch', description: 'apply patch', format: { type: 'grammar' } },
        { type: 'namespace', name: 'mcp__node_repl', description: 'node repl' },
        { type: 'tool_search', execution: 'client' },
      ],
    })
    expect(result.tools).toHaveLength(5)
    expect(result.tools!.map((t) => t.type)).toEqual([
      'function', 'web_search', 'custom', 'namespace', 'tool_search',
    ])
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

  it('maps input_image content to text placeholder (ProtocolMessagePart has no image variant)', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/img.png' }] }],
    })
    expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'https://example.com/img.png' }] }]
    )
  })

  it('extracts URL from input_image image_url object', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: { url: 'https://example.com/img.png', detail: 'auto' } }],
      }],
    })
    expect(result.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'https://example.com/img.png' }] }])
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
      input: [
        { type: 'function_call', call_id: 'call_123', name: 'get_weather', arguments: '{"location":"Paris"}' },
        { type: 'function_call_output', call_id: 'call_123', output: 'sunny' },
      ],
    })
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_123', toolName: 'get_weather', input: { location: 'Paris' } }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_123',
          toolName: 'get_weather',
          output: { type: 'text', value: 'sunny' },
        }],
      },
    ])
  })

  it('maps custom_tool_call and custom_tool_call_output (apply_patch round-trip)', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: [
        { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n...' },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: 'applied' },
      ],
    })
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'apply_patch', input: '*** Begin Patch\n...' }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'apply_patch',
          output: { type: 'text', value: 'applied' },
        }],
      },
    ])
  })

  it('falls back toolName to call_id when no matching function_call exists', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [{ type: 'function_call_output', call_id: 'call_456', output: 'orphan' }],
    })
    expect(result.messages).toEqual([{
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call_456',
        toolName: 'call_456',
        output: { type: 'text', value: 'orphan' },
      }],
    }])
  })

  it('maps reasoning items with encrypted_content to reasoning parts (transparent passthrough)', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking...' }], content: null, encrypted_content: 'enc-blob' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      ],
    })
    expect(result.messages).toHaveLength(3)
    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: 'thinking...',
        providerOptions: { openai: { reasoningEncryptedContent: 'enc-blob' } },
      }],
    })
  })

  it('maps reasoning items without encrypted_content to reasoning parts (summary fallback)', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking...' }], content: null, encrypted_content: null },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      ],
    })
    expect(result.messages).toHaveLength(3)
    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'thinking...' }],
    })
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

  it('ignores non-function tools when building ToolSet', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o', input: 'hi',
      tools: [
        { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
        { type: 'web_search' },
        { type: 'custom', name: 'apply_patch' },
        { type: 'namespace', name: 'mcp__node_repl' },
        { type: 'tool_search' },
      ],
    })
    expect(Object.keys(result.tools!)).toEqual(['get_weather'])
  })

  it('passes apply_patch custom tool through for openai provider', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5', input: 'hi',
      tools: [
        { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
        { type: 'custom', name: 'apply_patch', description: 'apply patch', format: { type: 'grammar', syntax: 'lark', definition: 'start:' } },
      ],
    }, { providerType: 'openai' })
    expect(Object.keys(result.tools!).sort()).toEqual(['apply_patch', 'shell_command'])
  })

  it('skips apply_patch custom tool for openai-compatible provider', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5', input: 'hi',
      tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start:' } }],
    }, { providerType: 'openai-compatible' })
    expect(result.tools).toBeUndefined()
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
