import { describe, expect, it } from 'vitest'
import {
  getResponsesCustomToolNames,
  getResponsesNamespaceFlatMap,
  mapResponsesRequestToAISDKInput,
  validateOpenAIResponsesRequest,
} from '../../../src/providers/openai-responses/protocol.js'

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
    expect(result.input).toEqual([
      { type: 'function_call_output', call_id: 'call_123', output: 'result' },
    ])
  })

  it('accepts reasoning items in input (multi-turn)', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'thinking...' }],
          content: null,
          encrypted_content: null,
        },
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
    expect(result.tools![0]).toEqual({
      type: 'function',
      name: 'get_weather',
      parameters: { type: 'object' },
    })
  })

  it('accepts non-function tools (web_search, custom, namespace, tool_search) alongside function tools', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: 'hi',
      tools: [
        { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
        { type: 'web_search', search_content_types: ['text'] },
        {
          type: 'custom',
          name: 'apply_patch',
          description: 'apply patch',
          format: { type: 'grammar' },
        },
        { type: 'namespace', name: 'mcp__node_repl', description: 'node repl' },
        { type: 'tool_search', execution: 'client' },
      ],
    })
    expect(result.tools).toHaveLength(5)
    expect(result.tools!.map((t) => t.type)).toEqual([
      'function',
      'web_search',
      'custom',
      'namespace',
      'tool_search',
    ])
  })

  it('accepts tool_choice as string', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: 'hi',
      tool_choice: 'auto',
    })
    expect(result.tool_choice).toBe('auto')
  })

  it('accepts tool_choice as function object', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: 'hi',
      tool_choice: { type: 'function', name: 'get_weather' },
    })
    expect(result.tool_choice).toEqual({ type: 'function', name: 'get_weather' })
  })

  it('passes through unknown fields via passthrough', () => {
    const result = validateOpenAIResponsesRequest({
      model: 'gpt-4o',
      input: 'hi',
      custom_field: 'value',
    })
    expect((result as any).custom_field).toBe('value')
  })

  it('accepts Codex agent_message items for multi-agent turns', () => {
    expect(() =>
      validateOpenAIResponsesRequest({
        model: 'gpt-4o',
        input: [
          {
            type: 'agent_message',
            author: '/root',
            recipient: '/root/worker',
            content: [{ type: 'input_text', text: 'compute 19 + 23' }],
          },
        ],
      }),
    ).not.toThrow()
  })
})

describe('mapResponsesRequestToAISDKInput', () => {
  it('maps string input to user message', () => {
    const result = mapResponsesRequestToAISDKInput({ model: 'gpt-4o', input: 'hello' })
    expect(result.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('maps instructions to system option', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: 'hi',
      instructions: 'Be helpful',
    })
    expect(result.system).toBe('Be helpful')
    expect(result.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('maps message items preserving role', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
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

  it('maps Codex agent_message items to labeled user context', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [
        {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/worker',
          content: [{ type: 'input_text', text: 'compute 19 + 23' }],
        } as any,
      ],
    })
    expect(result.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Agent message from /root to /root/worker:' },
          { type: 'text', text: 'compute 19 + 23' },
        ],
      },
    ])
  })

  it('maps outgoing historical agent_message items as assistant context', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [
        {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/worker',
          content: [{ type: 'input_text', text: 'compute 19 + 23' }],
        },
        {
          type: 'agent_message',
          author: '/root/worker',
          recipient: '/root',
          content: [{ type: 'input_text', text: '42' }],
        },
      ] as any,
    })
    expect(result.messages.map((m) => m.role)).toEqual(['assistant', 'user'])
  })

  it('maps input_image content to text placeholder (ProtocolMessagePart has no image variant)', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'https://example.com/img.png' }],
        },
      ],
    })
    expect(result.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'https://example.com/img.png' }] },
    ])
  })

  it('extracts URL from input_image image_url object', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: { url: 'https://example.com/img.png', detail: 'auto' },
            },
          ],
        },
      ],
    })
    expect(result.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'https://example.com/img.png' }] },
    ])
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

  it('falls back tool_choice to auto when referencing a hosted tool (in toolSet but not selectable)', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: 'hi',
        tools: [{ type: 'web_search', external_web_access: true }],
        tool_choice: { type: 'function', name: 'web_search' },
      },
      'openai',
    )
    expect(result.toolChoice).toBe('auto')
  })

  it('maps function_call_output to tool message', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [
        {
          type: 'function_call',
          call_id: 'call_123',
          name: 'get_weather',
          arguments: '{"location":"Paris"}',
        },
        { type: 'function_call_output', call_id: 'call_123', output: 'sunny' },
      ],
    })
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_123',
            toolName: 'get_weather',
            input: { location: 'Paris' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_123',
            toolName: 'get_weather',
            output: { type: 'text', value: 'sunny' },
          },
        ],
      },
    ])
  })

  it('maps custom_tool_call and custom_tool_call_output (apply_patch round-trip)', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: [
        {
          type: 'custom_tool_call',
          call_id: 'call_1',
          name: 'apply_patch',
          input: '*** Begin Patch\n...',
        },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: 'applied' },
      ],
    })
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'apply_patch',
            input: { input: '*** Begin Patch\n...' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'apply_patch',
            output: { type: 'text', value: 'applied' },
          },
        ],
      },
    ])
  })

  it('falls back toolName to call_id when no matching function_call exists', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [{ type: 'function_call_output', call_id: 'call_456', output: 'orphan' }],
    })
    expect(result.messages).toEqual([
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_456',
            toolName: 'call_456',
            output: { type: 'text', value: 'orphan' },
          },
        ],
      },
    ])
  })

  it('maps reasoning items with encrypted_content to reasoning parts (transparent passthrough)', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'thinking...' }],
          content: null,
          encrypted_content: 'enc-blob',
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
      ],
    })
    expect(result.messages).toHaveLength(3)
    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'thinking...',
          providerOptions: { openai: { reasoningEncryptedContent: 'enc-blob' } },
        },
      ],
    })
  })

  it('maps reasoning items without encrypted_content to reasoning parts (summary fallback)', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'thinking...' }],
          content: null,
          encrypted_content: null,
        },
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
      model: 'gpt-4o',
      input: 'hi',
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 100,
    })
    expect(result.temperature).toBe(0.7)
    expect(result.topP).toBe(0.9)
    expect(result.maxOutputTokens).toBe(100)
  })

  it('maps function tools — flat to ToolSet', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: 'hi',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { location: { type: 'string' } } },
        },
      ],
    })
    expect(result.tools).toBeDefined()
    expect(result.tools!['get_weather']).toBeDefined()
    expect(result.tools!['get_weather']!.description).toBe('Get weather')
  })

  it('ignores non-function hosted tools but shims custom/tool_search for non-openai providers', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: 'hi',
      tools: [
        { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
        { type: 'web_search' },
        { type: 'custom', name: 'apply_patch' },
        { type: 'namespace', name: 'mcp__node_repl' },
        { type: 'tool_search', execution: 'server' },
      ],
    })
    expect(Object.keys(result.tools!).sort()).toEqual(['apply_patch', 'get_weather'])
  })

  it('flattens namespace tools into top-level function tools with mcp__ prefix', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      tools: [
        { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
        {
          type: 'namespace',
          name: 'mcp__node_repl',
          description: 'node repl',
          tools: [
            {
              type: 'function',
              name: 'js',
              description: 'run js',
              parameters: { type: 'object', properties: { code: { type: 'string' } } },
            },
            { type: 'function', name: 'js_reset', parameters: { type: 'object' } },
          ],
        },
      ],
    })
    expect(Object.keys(result.tools!).sort()).toEqual([
      'mcp__node_repl__js',
      'mcp__node_repl__js_reset',
      'shell_command',
    ])
    expect(result.tools!['mcp__node_repl__js']!.description).toBe('run js')
  })

  it('skips non-function sub-tools in namespace (only function sub-tools are flattened)', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      tools: [
        {
          type: 'namespace',
          name: 'mcp__x',
          description: 'x',
          tools: [
            { type: 'function', name: 'fn', parameters: { type: 'object' } },
            { type: 'custom', name: 'patch', format: { type: 'grammar' } },
          ],
        },
      ],
    })
    expect(Object.keys(result.tools!)).toEqual(['mcp__x__fn'])
  })

  it('skips namespace tool without tools array', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      tools: [{ type: 'namespace', name: 'mcp__empty', description: 'empty' }],
    })
    expect(result.tools).toBeUndefined()
  })

  // Fix 4: namespace sub-tool 缺 name 时跳过，避免生成 `mcp__x__undefined`
  it('skips namespace sub-tool lacking name', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      tools: [
        {
          type: 'namespace',
          name: 'mcp__node_repl',
          tools: [
            { type: 'function', name: 'js', parameters: { type: 'object' } },
            { type: 'function', parameters: { type: 'object' } as { type: string } }, // 无 name
          ],
        },
      ],
    })
    expect(Object.keys(result.tools!)).toEqual(['mcp__node_repl__js'])
  })

  it('passes apply_patch custom tool through for openai provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: 'hi',
        tools: [
          { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
          {
            type: 'custom',
            name: 'apply_patch',
            description: 'apply patch',
            format: { type: 'grammar', syntax: 'lark', definition: 'start:' },
          },
        ],
      },
      'openai',
    )
    expect(Object.keys(result.tools!).sort()).toEqual(['apply_patch', 'shell_command'])
  })

  it('shims apply_patch custom tool as function for openai-compatible provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: 'hi',
        tools: [
          {
            type: 'custom',
            name: 'apply_patch',
            description: 'apply patch',
            format: { type: 'grammar', syntax: 'lark', definition: 'start:' },
          },
        ],
      },
      'openai-compatible',
    )
    expect(result.tools).toBeDefined()
    expect(Object.keys(result.tools!)).toEqual(['apply_patch'])
    const tool = result.tools!['apply_patch']!
    expect(tool.inputSchema).toBeDefined()
    expect(tool.description).toContain('apply patch')
    expect(tool.description).toContain('lark grammar')
    expect(tool.description).toContain('start:')
  })

  it('shims non-apply_patch custom tool as function for openai-compatible provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: 'hi',
        tools: [
          {
            type: 'custom',
            name: 'my_grammar_tool',
            description: 'my tool',
            format: { type: 'grammar', syntax: 'lark', definition: 'start:' },
          },
        ],
      },
      'openai-compatible',
    )
    expect(Object.keys(result.tools!)).toEqual(['my_grammar_tool'])
    expect(result.tools!['my_grammar_tool']!.description).toContain('my tool')
    expect(result.tools!['my_grammar_tool']!.description).toContain('lark grammar')
  })

  it('wraps custom_tool_call input as {input: text} for shimmed (non-openai) provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: [
          {
            type: 'custom_tool_call',
            call_id: 'call_1',
            name: 'apply_patch',
            input: '*** Begin Patch\n*** End Patch',
          },
          { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' },
        ],
      },
      'openai-compatible',
    )
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'apply_patch',
          input: { input: '*** Begin Patch\n*** End Patch' },
        },
      ],
    })
  })

  it('preserves custom_tool_call input as-is for openai provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: [
          {
            type: 'custom_tool_call',
            call_id: 'call_1',
            name: 'apply_patch',
            input: '*** Begin Patch\n*** End Patch',
          },
        ],
      },
      'openai',
    )
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch',
        },
      ],
    })
  })

  it('maps tool_search_call input item for shimmed provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: [
          { type: 'tool_search_call', call_id: 'ts_1', arguments: { query: 'browser', limit: 5 } },
          { type: 'tool_search_output', call_id: 'ts_1', tools: [{ name: 'open_page' }] },
        ],
      },
      'openai-compatible',
    )
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'ts_1',
          toolName: 'tool_search',
          input: { query: 'browser', limit: 5 },
        },
      ],
    })
    expect(result.messages[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'ts_1',
          toolName: 'tool_search',
          output: { type: 'text', value: JSON.stringify([{ name: 'open_page' }]) },
        },
      ],
    })
  })

  it('passes web_search tool through for openai provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: 'hi',
        tools: [
          { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
          {
            type: 'web_search',
            external_web_access: true,
            search_content_types: ['text', 'image'],
          },
        ],
      },
      'openai',
    )
    expect(Object.keys(result.tools!).sort()).toEqual(['shell_command', 'web_search'])
  })

  it('skips web_search tool for openai-compatible provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: 'hi',
        tools: [{ type: 'web_search', external_web_access: true }],
      },
      'openai-compatible',
    )
    expect(result.tools).toBeUndefined()
  })

  it('passes tool_search tool through for openai provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: 'hi',
        tools: [
          {
            type: 'tool_search',
            execution: 'client',
            description: 'Tool discovery',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      },
      'openai',
    )
    expect(Object.keys(result.tools!)).toEqual(['tool_search'])
  })

  it('shims client-executed tool_search as function for openai-compatible provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: 'hi',
        tools: [
          {
            type: 'tool_search',
            execution: 'client',
            description: 'Tool discovery',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      },
      'openai-compatible',
    )
    expect(result.tools).toBeDefined()
    expect(Object.keys(result.tools!)).toEqual(['tool_search'])
    expect(result.tools!['tool_search']!.description).toBe('Tool discovery')
  })

  it('skips server-executed tool_search for openai-compatible provider', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: 'hi',
        tools: [{ type: 'tool_search', execution: 'server' }],
      },
      'openai-compatible',
    )
    expect(result.tools).toBeUndefined()
  })

  it('maps tool_choice string values', () => {
    for (const choice of ['auto', 'none', 'required'] as const) {
      const result = mapResponsesRequestToAISDKInput({
        model: 'gpt-4o',
        input: 'hi',
        tool_choice: choice,
      })
      expect(result.toolChoice).toBe(choice)
    }
  })

  it('maps tool_choice function object', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: 'hi',
      tool_choice: { type: 'function', name: 'get_weather' },
    })
    expect(result.toolChoice).toEqual({ type: 'tool', toolName: 'get_weather' })
  })

  // Fix 5: tool_choice 引用 flattened MCP 工具名（mcp__server__tool）应映射到
  // {type:'tool', toolName:'mcp__server__tool'}，而非静默回退 'auto'。
  // 之前只查 request.tools（不含 namespace 内嵌的 flattened 名）导致回退。
  it('maps tool_choice referencing a flattened MCP tool name (not fall back to auto)', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      tools: [
        {
          type: 'namespace',
          name: 'mcp__node_repl',
          tools: [{ type: 'function', name: 'js', parameters: { type: 'object' } }],
        },
      ],
      tool_choice: { type: 'function', name: 'mcp__node_repl__js' },
    })
    expect(result.toolChoice).toEqual({ type: 'tool', toolName: 'mcp__node_repl__js' })
  })

  it('passes unknown fields as providerOptions.openai', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: 'hi',
      custom_param: 'value',
    })
    expect(result.providerOptions).toEqual({ openai: { custom_param: 'value' } })
  })

  it('maps parallel_tool_calls to providerOptions.openai.parallelToolCalls', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-4o',
      input: 'hi',
      parallel_tool_calls: false,
    })
    expect(result.providerOptions).toEqual({ openai: { parallelToolCalls: false } })
  })

  it('maps reasoning.effort to providerOptions.openai.reasoningEffort', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      reasoning: { effort: 'xhigh' },
    })
    expect(result.providerOptions).toEqual({ openai: { reasoningEffort: 'xhigh' } })
  })

  it('maps reasoning.summary to providerOptions.openai.reasoningSummary', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      reasoning: { effort: 'high', summary: 'detailed' },
    })
    expect(result.providerOptions).toEqual({
      openai: { reasoningEffort: 'high', reasoningSummary: 'detailed' },
    })
  })

  it('maps text.verbosity to providerOptions.openai.textVerbosity', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      text: { verbosity: 'low' },
    })
    expect(result.providerOptions).toEqual({ openai: { textVerbosity: 'low' } })
  })

  it('maps prompt_cache_key to providerOptions.openai.promptCacheKey', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      prompt_cache_key: 'abc123',
    })
    expect(result.providerOptions).toEqual({ openai: { promptCacheKey: 'abc123' } })
  })

  it('maps store to providerOptions.openai.store', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      store: false,
    })
    expect(result.providerOptions).toEqual({ openai: { store: false } })
  })

  it('does not forward Codex client_metadata to upstream metadata', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      client_metadata: { session_id: 's1', turn_id: 't1' },
    })
    expect(result.providerOptions).toBeUndefined()
  })

  it('combines camelCase mapped fields with passthrough unknown fields', () => {
    const result = mapResponsesRequestToAISDKInput({
      model: 'gpt-5',
      input: 'hi',
      reasoning: { effort: 'high' },
      custom_param: 'value',
    })
    expect(result.providerOptions).toEqual({
      openai: { reasoningEffort: 'high', custom_param: 'value' },
    })
  })

  it('omits providerOptions when no unknown fields', () => {
    const result = mapResponsesRequestToAISDKInput({ model: 'gpt-4o', input: 'hi' })
    expect(result.providerOptions).toBeUndefined()
  })

  // Codex CLI sends explicit null for optional fields it wants to "unset".
  // validateOpenAIResponsesRequest strips top-level nulls so schema + mapping see undefined.
  it('strips top-level null fields in validate (Codex CLI compatibility)', () => {
    const validated = validateOpenAIResponsesRequest({
      model: 'gpt-5',
      input: 'hi',
      reasoning: null,
      text: null,
      store: null,
      prompt_cache_key: null,
      client_metadata: null,
      parallel_tool_calls: null,
      instructions: null,
      temperature: null,
      top_p: null,
      max_output_tokens: null,
    })
    // All null fields removed, schema-defined fields are undefined
    expect(validated.reasoning).toBeUndefined()
    expect(validated.store).toBeUndefined()
    expect(validated.temperature).toBeUndefined()
    expect(validated.parallel_tool_calls).toBeUndefined()

    // Mapping then works without crash
    const result = mapResponsesRequestToAISDKInput(validated)
    expect(result.providerOptions).toBeUndefined()
    expect(result.system).toBeUndefined()
    expect(result.temperature).toBeUndefined()
  })

  describe('historical function_call namespace → flattened toolName', () => {
    it('maps function_call with namespace to flattened toolName', () => {
      const result = mapResponsesRequestToAISDKInput(
        {
          model: 'gpt-5',
          input: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'spawn_agent',
              namespace: 'multi_agent_v1',
              arguments: '{"message":"hi"}',
            },
            { type: 'function_call_output', call_id: 'call_1', output: '{"agent_id":"a1"}' },
          ],
        },
        'openai-compatible',
      )
      expect(result.messages[0]).toEqual({
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'multi_agent_v1__spawn_agent',
            input: { message: 'hi' },
          },
        ],
      })
      expect(result.messages[1]).toEqual({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'multi_agent_v1__spawn_agent',
            output: { type: 'text', value: '{"agent_id":"a1"}' },
          },
        ],
      })
    })

    it('maps function_call without namespace as plain toolName', () => {
      const result = mapResponsesRequestToAISDKInput(
        {
          model: 'gpt-5',
          input: [
            { type: 'function_call', call_id: 'call_1', name: 'exec_command', arguments: '{}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
          ],
        },
        'openai-compatible',
      )
      expect((result.messages[0]!.content as Array<{ toolName: string }>)[0]!.toolName).toBe(
        'exec_command',
      )
    })

    it('maps custom_tool_call with namespace to flattened toolName', () => {
      // custom_tool_call 也读 namespace（customToolCallSchema 是 passthrough，namespace 已保留）
      const result = mapResponsesRequestToAISDKInput(
        {
          model: 'gpt-5',
          input: [
            {
              type: 'custom_tool_call',
              call_id: 'call_1',
              name: 'my_patch',
              namespace: 'custom_ns',
              input: '*** Begin Patch\n*** End Patch',
            },
            { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' },
          ],
        },
        'openai-compatible',
      )
      expect((result.messages[0]!.content as Array<{ toolName: string }>)[0]!.toolName).toBe(
        'custom_ns__my_patch',
      )
    })

    it('maps mcp__ namespace function_call to flattened toolName', () => {
      const result = mapResponsesRequestToAISDKInput(
        {
          model: 'gpt-5',
          input: [
            {
              type: 'function_call',
              call_id: 'call_1',
              name: 'codegraph_search',
              namespace: 'mcp__codegraph',
              arguments: '{"query":"x"}',
            },
            { type: 'function_call_output', call_id: 'call_1', output: '{}' },
          ],
        },
        'openai-compatible',
      )
      expect((result.messages[0]!.content as Array<{ toolName: string }>)[0]!.toolName).toBe(
        'mcp__codegraph__codegraph_search',
      )
    })
  })
})

describe('getResponsesCustomToolNames', () => {
  it('collects names of custom tools', () => {
    const names = getResponsesCustomToolNames({
      model: 'gpt-5',
      input: 'hi',
      tools: [
        { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
        { type: 'custom', name: 'apply_patch', format: { type: 'grammar' } },
        { type: 'custom', name: 'my_grammar_tool', format: { type: 'grammar' } },
        { type: 'web_search', external_web_access: true },
      ],
    })
    expect(names).toEqual(new Set(['apply_patch', 'my_grammar_tool']))
  })

  it('returns undefined when no custom tools', () => {
    const names = getResponsesCustomToolNames({
      model: 'gpt-5',
      input: 'hi',
      tools: [{ type: 'function', name: 'f', parameters: {} }],
    })
    expect(names).toBeUndefined()
  })

  it('returns undefined when no tools', () => {
    const names = getResponsesCustomToolNames({ model: 'gpt-5', input: 'hi' })
    expect(names).toBeUndefined()
  })
})

describe('getResponsesNamespaceFlatMap', () => {
  it('collects namespace tools from request.tools', () => {
    const map = getResponsesNamespaceFlatMap({
      model: 'gpt-5',
      input: 'hi',
      tools: [
        { type: 'namespace', name: 'codex_app', tools: [{ type: 'function', name: 'load_ws' }] },
      ],
    })
    expect(map).toBeDefined()
    expect(map!.get('codex_app__load_ws')).toEqual({ namespace: 'codex_app', name: 'load_ws' })
  })

  it('collects namespace tools discovered via tool_search_output in input history', () => {
    const map = getResponsesNamespaceFlatMap({
      model: 'gpt-5',
      input: [
        { type: 'tool_search_call', call_id: 'ts_1', arguments: { query: 'agent' } },
        {
          type: 'tool_search_output',
          call_id: 'ts_1',
          tools: [
            {
              type: 'namespace',
              name: 'multi_agent_v1',
              tools: [{ type: 'function', name: 'spawn_agent' }],
            },
          ],
        },
      ],
    })
    expect(map).toBeDefined()
    expect(map!.get('multi_agent_v1__spawn_agent')).toEqual({
      namespace: 'multi_agent_v1',
      name: 'spawn_agent',
    })
  })

  it('collects top-level function (no namespace) from tool_search_output', () => {
    const map = getResponsesNamespaceFlatMap({
      model: 'gpt-5',
      input: [
        {
          type: 'tool_search_output',
          call_id: 'ts_1',
          tools: [{ type: 'function', name: 'standalone_tool' }],
        },
      ],
    })
    expect(map).toBeDefined()
    expect(map!.get('standalone_tool')).toEqual({ namespace: undefined, name: 'standalone_tool' })
  })

  it('returns undefined when no namespace tools present', () => {
    const map = getResponsesNamespaceFlatMap({ model: 'gpt-5', input: 'hi' })
    expect(map).toBeUndefined()
  })

  it('skips non-function sub-tools in namespace', () => {
    const map = getResponsesNamespaceFlatMap({
      model: 'gpt-5',
      input: [
        {
          type: 'tool_search_output',
          call_id: 'ts_1',
          tools: [
            {
              type: 'namespace',
              name: 'ns',
              tools: [
                { type: 'function', name: 'fn' },
                { type: 'custom', name: 'patch' },
              ],
            },
          ],
        },
      ],
    })
    expect(map!.get('ns__fn')).toEqual({ namespace: 'ns', name: 'fn' })
    expect(map!.has('ns__patch')).toBe(false)
  })
})

describe('tool_search_output discovered tools → tools[]', () => {
  it('flattens namespace tools from tool_search_output into toolSet (openai-compatible)', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: [
          { type: 'tool_search_call', call_id: 'ts_1', arguments: { query: 'agent' } },
          {
            type: 'tool_search_output',
            call_id: 'ts_1',
            tools: [
              {
                type: 'namespace',
                name: 'multi_agent_v1',
                description: 'sub-agents',
                tools: [
                  {
                    type: 'function',
                    name: 'spawn_agent',
                    description: 'spawn',
                    parameters: { type: 'object', properties: { message: { type: 'string' } } },
                  },
                ],
              },
            ],
          },
        ],
      },
      'openai-compatible',
    )
    expect(result.tools).toBeDefined()
    expect(Object.keys(result.tools!)).toContain('multi_agent_v1__spawn_agent')
    expect(result.tools!['multi_agent_v1__spawn_agent']!.description).toBe('spawn')
  })

  it('is idempotent: duplicate tool_search_output does not duplicate toolSet entries', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: [
          {
            type: 'tool_search_output',
            call_id: 'ts_1',
            tools: [
              {
                type: 'namespace',
                name: 'ns',
                tools: [{ type: 'function', name: 'fn', parameters: { type: 'object' } }],
              },
            ],
          },
          {
            type: 'tool_search_output',
            call_id: 'ts_2',
            tools: [
              {
                type: 'namespace',
                name: 'ns',
                tools: [{ type: 'function', name: 'fn', parameters: { type: 'object' } }],
              },
            ],
          },
        ],
      },
      'openai-compatible',
    )
    expect(Object.keys(result.tools!).filter((k) => k === 'ns__fn').length).toBe(1)
  })

  it('appends discovered tools after initial request.tools (stable order)', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: [
          {
            type: 'tool_search_output',
            call_id: 'ts_1',
            tools: [
              {
                type: 'namespace',
                name: 'multi_agent_v1',
                tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
              },
            ],
          },
        ],
        tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
      },
      'openai-compatible',
    )
    // 初始 request.tools 在前，发现的 namespace 工具追加末尾（保缓存前缀稳定）
    expect(Object.keys(result.tools!)).toEqual(['shell', 'multi_agent_v1__spawn_agent'])
  })

  it('scans tool_search_output even when request.tools is undefined', () => {
    // 关键：request.tools 为 undefined 时仍扫描 tool_search_output（代码在 if(request.tools) 块外）
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: [
          {
            type: 'tool_search_output',
            call_id: 'ts_1',
            tools: [
              {
                type: 'namespace',
                name: 'multi_agent_v1',
                tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
              },
            ],
          },
        ],
      },
      'openai-compatible',
    )
    expect(Object.keys(result.tools!)).toEqual(['multi_agent_v1__spawn_agent'])
  })

  it('does not add tools when tool_search_output empty', () => {
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: [] }],
      },
      'openai-compatible',
    )
    expect(result.tools).toBeUndefined()
  })

  it('skips top-level tool without type field (only type:function added)', () => {
    // 钉住现有 protocol.test.ts:449 行为：tool_search_output 顶层元素不带 type（如 open_page）
    // 时，Task 2 用 t.type === 'function' 判断会跳过，不误加入 toolSet
    const result = mapResponsesRequestToAISDKInput(
      {
        model: 'gpt-5',
        input: [{ type: 'tool_search_output', call_id: 'ts_1', tools: [{ name: 'open_page' }] }],
      },
      'openai-compatible',
    )
    expect(result.tools).toBeUndefined()
  })
})
