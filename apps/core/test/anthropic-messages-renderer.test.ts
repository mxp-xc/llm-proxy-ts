import { describe, expect, it } from 'vitest'
import { renderAnthropicMessage, renderAnthropicMessageSSE } from '../src/providers/anthropic/renderer.js'

describe('Anthropic Messages renderer', () => {
  it('renders text completions', () => {
    const body = renderAnthropicMessage({
      model: 'claude-sonnet-4-5',
      text: 'hello',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
      response: { id: 'msg_test123', timestamp: new Date(0) },
    })

    expect(body).toMatchObject({
      id: 'msg_test123',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    expect(body.content[0]).toEqual({ type: 'text', text: 'hello' })
  })

  it('renders non-streaming tool calls', () => {
    const body = renderAnthropicMessage({
      model: 'claude-sonnet-4-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'toolu_1', toolName: 'get_weather', input: { city: 'NYC' } }],
    })

    expect(body.content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
    ])
    expect(body.stop_reason).toBe('tool_use')
  })

  it('renders text and tool calls together', () => {
    const body = renderAnthropicMessage({
      model: 'claude-sonnet-4-5',
      text: 'Let me check.',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'toolu_1', toolName: 'get_weather', input: { city: 'NYC' } }],
    })

    expect(body.content).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'NYC' } },
    ])
  })

  it('maps finish reasons correctly', () => {
    expect(
      renderAnthropicMessage({ model: 'm', text: 'x', finishReason: 'stop' }).stop_reason,
    ).toBe('end_turn')
    expect(
      renderAnthropicMessage({ model: 'm', text: 'x', finishReason: 'length' }).stop_reason,
    ).toBe('max_tokens')
    expect(
      renderAnthropicMessage({ model: 'm', text: 'x', finishReason: 'content-filter' }).stop_reason,
    ).toBe('refusal')
    expect(
      renderAnthropicMessage({ model: 'm', text: 'x', finishReason: 'tool-calls' }).stop_reason,
    ).toBe('tool_use')
  })

  it('renders streaming text SSE with Anthropic named events', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hel' }
      yield { type: 'text-delta', text: 'lo' }
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 5 } }
    }

    const events = await collectAnthropicSSEEvents(parts())

    // Verify event sequence
    expect(events.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])

    // Verify message_start
    expect(events[0]!.message.role).toBe('assistant')
    expect(events[0]!.message.stop_reason).toBeNull()

    // Verify content_block_start
    expect(events[1]!.content_block.type).toBe('text')
    expect(events[1]!.index).toBe(0)

    // Verify text deltas
    expect(events[2]!.delta).toEqual({ type: 'text_delta', text: 'hel' })
    expect(events[3]!.delta).toEqual({ type: 'text_delta', text: 'lo' })

    // Verify message_delta
    expect(events[5]!.delta.stop_reason).toBe('end_turn')
    expect(events[5]!.usage.input_tokens).toBe(10)
    expect(events[5]!.usage.output_tokens).toBe(5)
  })

  it('omits usage in streaming message_delta when usage is all zeros', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'finish', finishReason: 'stop' }
    }

    const events = await collectAnthropicSSEEvents(parts())
    const messageDelta = events.find((e) => e.type === 'message_delta')
    expect(messageDelta!.delta.stop_reason).toBe('end_turn')
    expect(messageDelta!.usage).toBeUndefined()
  })

  it('omits usage in fallback message_delta when stream ends without finish part', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hi' }
      // no finish part — stream just ends
    }

    const events = await collectAnthropicSSEEvents(parts())
    const messageDelta = events.find((e) => e.type === 'message_delta')
    expect(messageDelta!.delta.stop_reason).toBe('end_turn')
    expect(messageDelta!.usage).toBeUndefined()
  })

  it('renders streaming tool use SSE events', async () => {
    async function* parts() {
      yield { type: 'tool-call-start', toolCallId: 'toolu_1', toolName: 'get_weather' }
      yield { type: 'tool-call-args-delta', toolCallId: 'toolu_1', argsTextDelta: '{"city"' }
      yield { type: 'tool-input-delta', toolCallId: 'toolu_1', inputTextDelta: ':"NYC"}' }
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 20, outputTokens: 10 } }
    }

    const events = await collectAnthropicSSEEvents(parts())

    // Verify tool_use block start
    const blockStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use')
    expect(blockStart).toBeDefined()
    expect(blockStart!.content_block).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'get_weather',
      input: {},
    })

    // Verify input_json_delta events
    const deltas = events.filter(
      (e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta',
    )
    expect(deltas.map((d) => d.delta.partial_json)).toEqual(['{"city"', ':"NYC"}'])

    // Verify stop reason
    const messageDelta = events.find((e) => e.type === 'message_delta')
    expect(messageDelta!.delta.stop_reason).toBe('tool_use')
  })

  it('renders complete tool-call events (non-streaming input)', async () => {
    async function* parts() {
      yield { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'get_weather', input: { city: 'NYC' } }
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 15, outputTokens: 8 } }
    }

    const events = await collectAnthropicSSEEvents(parts())

    // Should have content_block_start with tool_use, then input_json_delta, then stop
    const blockStart = events.find((e) => e.type === 'content_block_start')
    expect(blockStart!.content_block.type).toBe('tool_use')

    const jsonDelta = events.find((e) => e.delta?.type === 'input_json_delta')
    expect(jsonDelta!.delta.partial_json).toBe('{"city":"NYC"}')
  })

  it('uses named SSE events format', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 1 } }
    }

    const chunks: string[] = []
    for await (const chunk of renderAnthropicMessageSSE({ model: 'm', stream: parts() })) {
      chunks.push(new TextDecoder().decode(chunk))
    }
    const raw = chunks.join('')

    // Anthropic SSE uses "event: <type>\ndata: <json>\n\n"
    expect(raw).toContain('event: message_start\ndata: ')
    expect(raw).toContain('event: content_block_start\ndata: ')
    expect(raw).toContain('event: content_block_delta\ndata: ')
    expect(raw).toContain('event: content_block_stop\ndata: ')
    expect(raw).toContain('event: message_delta\ndata: ')
    expect(raw).toContain('event: message_stop\ndata: ')
  })
})

async function collectAnthropicSSEEvents(stream: AsyncIterable<unknown>): Promise<Array<any>> {
  const chunks: string[] = []
  for await (const chunk of renderAnthropicMessageSSE({ model: 'test-model', stream })) {
    chunks.push(new TextDecoder().decode(chunk))
  }
  const raw = chunks.join('')

  // Parse Anthropic named SSE events: "event: <type>\ndata: <json>\n\n"
  const events: Array<any> = []
  const parts = raw.split('\n\n').filter((p) => p.trim())

  for (const part of parts) {
    const dataLine = part.split('\n').find((line) => line.startsWith('data: '))
    if (dataLine) {
      try {
        events.push(JSON.parse(dataLine.slice('data: '.length)))
      } catch {
        // skip unparseable
      }
    }
  }

  return events
}
