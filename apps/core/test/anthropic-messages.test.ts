import { describe, expect, it } from 'vitest'
import {
  mapAnthropicMessagesRequestToAISDKInput,
  validateAnthropicMessagesRequest,
} from '../src/providers/anthropic/protocol.js'

describe('Anthropic Messages protocol mapping', () => {
  it('validates required model, messages, and max_tokens', () => {
    const parsed = validateAnthropicMessagesRequest({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(parsed.model).toBe('claude/sonnet')
    expect(parsed.max_tokens).toBe(1024)
    expect(parsed.messages).toHaveLength(1)
  })

  it('rejects request without max_tokens', () => {
    expect(() =>
      validateAnthropicMessagesRequest({
        model: 'claude/sonnet',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).toThrow()
  })

  it('rejects request without messages', () => {
    expect(() =>
      validateAnthropicMessagesRequest({
        model: 'claude/sonnet',
        max_tokens: 1024,
        messages: [],
      }),
    ).toThrow()
  })

  it('maps common Anthropic parameters to AI SDK settings', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ['END'],
    })

    expect(input).toMatchObject({
      temperature: 0.5,
      topP: 0.9,
      maxOutputTokens: 2048,
      stopSequences: ['END'],
    })
  })

  it('maps system prompt to input.system', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(input.system).toBe('You are a helpful assistant.')
    expect(input.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('maps system prompt array by joining text blocks', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      system: [
        { type: 'text', text: 'You are a helpful assistant.' },
        { type: 'text', text: 'Be concise.' },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(input.system).toBe('You are a helpful assistant.\nBe concise.')
  })

  it('maps tool_use content blocks to AI SDK tool-call parts', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
      ],
    })

    expect(input.messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'get_weather', input: { city: 'NYC' } },
      ],
    })
  })

  it('maps tool_result content blocks to AI SDK tool-result parts in role:tool', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'Sunny, 72°F',
            },
          ],
        },
      ],
    })

    // Anthropic 的 tool_result 在 role:'user' 中，映射到 AI SDK 的 role:'tool'
    // toolName 从同请求的 tool_use 块中查找得到
    expect(input.messages).toHaveLength(2)
    expect(input.messages[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'toolu_1',
          toolName: 'get_weather',
          output: { type: 'text', value: 'Sunny, 72°F' },
        },
      ],
    })
  })

  it('maps tool_result with array content to role:tool', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'test' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
            },
          ],
        },
      ],
    })

    // tool_result 在 user 消息中映射为 role:'tool'
    expect(input.messages).toHaveLength(2)
    expect(input.messages[1]!.role).toBe('tool')
    const msg = input.messages[1]! as Record<string, unknown>
    const parts = msg.content as Array<Record<string, unknown>>
    expect(parts[0]?.output).toEqual({ type: 'text', value: 'Part 1Part 2' })
    expect(parts[0]?.toolName).toBe('search')
  })

  it('splits user message with mixed tool_result and text into tool + user messages', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result data' },
            { type: 'text', text: 'What does this mean?' },
          ],
        },
      ],
    })

    // tool_result 部分映射为 role:'tool'，text 部分映射为 role:'user'
    expect(input.messages).toHaveLength(3)
    expect(input.messages[1]!.role).toBe('tool')
    expect(input.messages[2]!.role).toBe('user')
  })

  it('does not emit user message when tool_result has no text blocks', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'query', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result only' },
          ],
        },
      ],
    })

    // 纯 tool_result 的 user 消息只生成一条 role:'tool' 消息
    expect(input.messages).toHaveLength(2)
    expect(input.messages[1]!.role).toBe('tool')
  })

  it('maps is_error:true tool_result to error-text output type', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: 'Rate limit exceeded',
              is_error: true,
            },
          ],
        },
      ],
    })

    const toolMsg = input.messages[1]! as Record<string, unknown>
    const parts = toolMsg.content as Array<Record<string, unknown>>
    expect(parts[0]?.output).toEqual({ type: 'error-text', value: 'Rate limit exceeded' })
  })

  it('falls back to tool_use_id as toolName when no matching tool_use block exists', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_orphan',
              content: 'orphan result',
            },
          ],
        },
      ],
    })

    const toolMsg = input.messages[0]! as Record<string, unknown>
    const parts = toolMsg.content as Array<Record<string, unknown>>
    // 无对应 tool_use 块时，回退到 tool_use_id
    expect(parts[0]?.toolName).toBe('toolu_orphan')
  })

  it('maps Anthropic tools to AI SDK ToolSet', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'weather?' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    })

    expect(Object.keys(input.tools ?? {})).toEqual(['get_weather'])
    expect(input.tools?.get_weather).not.toHaveProperty('execute')
  })

  it('maps tool_choice auto to auto', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'auto' },
    })

    expect(input.toolChoice).toBe('auto')
  })

  it('maps tool_choice any to required', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'any' },
    })

    expect(input.toolChoice).toBe('required')
  })

  it('maps tool_choice none to none', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'none' },
    })

    expect(input.toolChoice).toBe('none')
  })

  it('maps tool_choice named tool to AI SDK toolName', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'tool', name: 'get_weather' },
    })

    expect(input.toolChoice).toEqual({ type: 'tool', toolName: 'get_weather' })
  })

  it('maps Anthropic-specific fields to providerOptions.anthropic', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput(
      {
        model: 'claude/sonnet',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'think' }],
        thinking: { type: 'enabled', budget_tokens: 10000 },
        top_k: 50,
        metadata: { user_id: 'user-123' },
      },
      'anthropic',
    )

    expect(input.providerOptions).toEqual({
      anthropic: {
        thinking: { type: 'enabled', budget_tokens: 10000 },
        topK: 50,
        metadata: { user_id: 'user-123' },
      },
    })
  })

  it('includes passthrough fields in providerOptions', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput(
      {
        model: 'claude/sonnet',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hi' }],
        custom_field: 'value',
      },
      'anthropic',
    )

    expect(input.providerOptions?.anthropic).toMatchObject({
      custom_field: 'value',
    })
  })

  it('does not set providerOptions when provider is unknown', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 10000 },
    })

    expect(input.providerOptions).toBeUndefined()
  })

  it('maps string content messages directly', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    })

    expect(input.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ])
  })

  it('extracts system role messages from messages array and merges with top-level system', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      system: 'Base system prompt.',
      messages: [
        { role: 'system', content: 'You are Claude Code.' },
        { role: 'user', content: 'hello' },
      ],
    })

    // system 角色消息提取到 input.system，不放入 messages
    expect(input.system).toBe('Base system prompt.\nYou are Claude Code.')
    expect(input.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('handles system role messages without top-level system field', () => {
    const input = mapAnthropicMessagesRequestToAISDKInput({
      model: 'claude/sonnet',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hello' },
      ],
    })

    expect(input.system).toBe('You are a helpful assistant.')
    expect(input.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('accepts thinking with display field', () => {
    const parsed = validateAnthropicMessagesRequest({
      model: 'claude/sonnet',
      max_tokens: 16000,
      messages: [{ role: 'user', content: 'think' }],
      thinking: { type: 'enabled', budget_tokens: 10000, display: 'omitted' },
    })

    expect(parsed.thinking).toEqual({ type: 'enabled', budget_tokens: 10000, display: 'omitted' })
  })

  it('accepts adaptive thinking', () => {
    const parsed = validateAnthropicMessagesRequest({
      model: 'claude/sonnet',
      max_tokens: 16000,
      messages: [{ role: 'user', content: 'think' }],
      thinking: { type: 'adaptive' },
    })

    expect(parsed.thinking).toEqual({ type: 'adaptive' })
  })
})
