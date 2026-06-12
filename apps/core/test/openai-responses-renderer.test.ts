import { describe, expect, it } from 'vitest'
import { renderOpenAIResponse, renderOpenAIResponseSSE } from '../src/providers/openai-responses/renderer.js'

describe('renderOpenAIResponse', () => {
  it('renders text response', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: 'Hello world',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
    expect(result.object).toBe('response')
    expect(result.model).toBe('gpt-4o')
    expect(result.status).toBe('completed')
    expect(result.output_text).toBe('Hello world')
    expect(result.output).toHaveLength(1)
    const first = result.output[0]!
    expect(first.type).toBe('message')
    if (first.type === 'message') {
      expect(first.role).toBe('assistant')
      expect(first.content[0]).toEqual({
        type: 'output_text',
        text: 'Hello world',
        annotations: [],
      })
    }
    expect(result.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    })
  })

  it('renders tool calls', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'call_123', toolName: 'get_weather', input: { location: 'Paris' } },
      ],
    })
    expect(result.status).toBe('incomplete')
    const fc = result.output.find((o) => o.type === 'function_call')
    expect(fc).toBeDefined()
    if (fc && fc.type === 'function_call') {
      expect(fc.call_id).toBe('call_123')
      expect(fc.name).toBe('get_weather')
      expect(fc.arguments).toBe('{"location":"Paris"}')
    }
  })

  it('renders text + tool calls together', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: 'Let me check',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'call_123', toolName: 'get_weather', input: { location: 'Paris' } },
      ],
    })
    expect(result.output).toHaveLength(2)
    expect(result.output[0]!.type).toBe('message')
    expect(result.output[1]!.type).toBe('function_call')
    expect(result.status).toBe('incomplete')
  })

  it('maps finishReason to status', () => {
    expect(renderOpenAIResponse({ model: 'gpt-4o', text: 'hi', finishReason: 'stop' }).status).toBe(
      'completed',
    )
    expect(
      renderOpenAIResponse({ model: 'gpt-4o', text: 'hi', finishReason: 'length' }).status,
    ).toBe('incomplete')
    expect(
      renderOpenAIResponse({ model: 'gpt-4o', text: 'hi', finishReason: 'content-filter' }).status,
    ).toBe('incomplete')
  })

  it('uses response id and timestamp when provided', () => {
    const ts = new Date('2024-01-01T00:00:00Z')
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: 'hi',
      finishReason: 'stop',
      response: { id: 'resp_abc123', timestamp: ts },
    })
    expect(result.id).toBe('resp_abc123')
    expect(result.created_at).toBe(Math.floor(ts.getTime() / 1000))
  })

  it('generates resp_ prefixed id when no response id', () => {
    const result = renderOpenAIResponse({ model: 'gpt-4o', text: 'hi', finishReason: 'stop' })
    expect(result.id).toMatch(/^resp_/)
  })

  it('generates msg_ prefixed id for message output items', () => {
    const result = renderOpenAIResponse({ model: 'gpt-4o', text: 'hi', finishReason: 'stop' })
    expect(result.output[0]!.id).toMatch(/^msg_/)
  })

  it('generates fc_ prefixed id for function_call output items', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'call_123', toolName: 'get_weather', input: {} }],
    })
    const fc = result.output.find((o) => o.type === 'function_call')
    expect(fc!.id).toMatch(/^fc_/)
  })

  // Bug #5 — empty-string text should still produce a message output item
  it('produces message output item for empty-string text', () => {
    const result = renderOpenAIResponse({ model: 'gpt-4o', text: '', finishReason: 'stop' })
    expect(result.output).toHaveLength(1)
    expect(result.output[0]!.type).toBe('message')
    expect(result.output_text).toBe('')
  })

  // Bug #9 — string args should not be double-encoded
  it('does not double-encode string tool call input', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o', text: '', finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'call_1', toolName: 'test', input: '{"already":"serialized"}' }],
    })
    const fc = result.output.find(o => o.type === 'function_call')
    if (fc && fc.type === 'function_call') {
      expect(fc.arguments).toBe('{"already":"serialized"}')
    }
  })
})

// ─── Streaming SSE Renderer Tests ─────────────────────────────

async function* textStream() {
  yield { type: 'text-delta', text: 'Hello' }
  yield { type: 'text-delta', text: ' world' }
  yield {
    type: 'finish',
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5 },
    response: { id: 'resp_test123' },
  }
}

async function collectSSEEvents(stream: AsyncIterable<unknown>): Promise<Array<{ event: string; data: any }>> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(new TextDecoder().decode(chunk as Uint8Array))
  }
  const raw = chunks.join('')
  const results: Array<{ event: string; data: any }> = []
  const parts = raw.split('\n\n').filter(p => p.trim())
  for (const part of parts) {
    const lines = part.split('\n')
    const eventLine = lines.find(l => l.startsWith('event: '))
    const dataLine = lines.find(l => l.startsWith('data: '))
    if (eventLine && dataLine) {
      results.push({
        event: eventLine.slice('event: '.length),
        data: JSON.parse(dataLine.slice('data: '.length)),
      })
    }
  }
  return results
}

describe('renderOpenAIResponseSSE', () => {
  it('emits correct event sequence for text streaming', async () => {
    const events = await collectSSEEvents(renderOpenAIResponseSSE({ model: 'gpt-4o', stream: textStream() }))
    const eventTypes = events.map(e => e.event)
    expect(eventTypes).toContain('response.created')
    expect(eventTypes).toContain('response.in_progress')
    expect(eventTypes).toContain('response.output_item.added')
    expect(eventTypes).toContain('response.content_part.added')
    expect(eventTypes.filter(t => t === 'response.output_text.delta')).toHaveLength(2)
    expect(eventTypes).toContain('response.output_text.done')
    expect(eventTypes).toContain('response.content_part.done')
    expect(eventTypes).toContain('response.output_item.done')
    expect(eventTypes).toContain('response.completed')
  })

  it('emits text delta content', async () => {
    const events = await collectSSEEvents(renderOpenAIResponseSSE({ model: 'gpt-4o', stream: textStream() }))
    const deltas = events.filter(e => e.event === 'response.output_text.delta')
    expect(deltas[0]!.data.delta).toBe('Hello')
    expect(deltas[1]!.data.delta).toBe(' world')
  })

  it('emits completed response with full data', async () => {
    const events = await collectSSEEvents(renderOpenAIResponseSSE({ model: 'gpt-4o', stream: textStream() }))
    const completed = events.find(e => e.event === 'response.completed')
    expect(completed).toBeDefined()
    expect(completed?.data.response.object).toBe('response')
    expect(completed?.data.response.status).toBe('completed')
  })

  it('includes sequence_number in events', async () => {
    const events = await collectSSEEvents(renderOpenAIResponseSSE({ model: 'gpt-4o', stream: textStream() }))
    for (const event of events) {
      expect(typeof event.data.sequence_number).toBe('number')
    }
  })

  // Bug #3 / #1 — Streaming tool-call with complete part (no deltas)
  async function* toolCallStream() {
    yield { type: 'tool-call', toolCallId: 'call_123', toolName: 'get_weather', input: { location: 'Paris' } }
    yield { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 10, completionTokens: 5 }, response: { id: 'resp_test' } }
  }

  it('emits tool-call events for complete tool-call part', async () => {
    const events = await collectSSEEvents(renderOpenAIResponseSSE({ model: 'gpt-4o', stream: toolCallStream() }))
    const eventTypes = events.map(e => e.event)
    expect(eventTypes).toContain('response.output_item.added')
    expect(eventTypes).toContain('response.function_call_arguments.delta')
    expect(eventTypes).toContain('response.function_call_arguments.done')
    expect(eventTypes).toContain('response.output_item.done')
    expect(eventTypes).toContain('response.completed')
  })

  // Bug #2 — Error terminal behavior
  async function* errorStream() {
    yield { type: 'text-delta', text: 'Hello' }
    yield { type: 'error', error: new Error('upstream failed') }
  }

  it('emits response.completed after error and terminates stream', async () => {
    const events = await collectSSEEvents(renderOpenAIResponseSSE({ model: 'gpt-4o', stream: errorStream() }))
    const eventTypes = events.map(e => e.event)
    expect(eventTypes).toContain('response.error')
    expect(eventTypes).toContain('response.completed')
    const completed = events.find(e => e.event === 'response.completed')
    expect(completed?.data.response.status).toBe('incomplete')
    // No events after response.completed
    const completedIndex = eventTypes.indexOf('response.completed')
    expect(eventTypes.length).toBe(completedIndex + 1)
  })

  // Bug #1 — response.completed includes tool calls
  it('includes function_call items in response.completed output', async () => {
    const events = await collectSSEEvents(renderOpenAIResponseSSE({ model: 'gpt-4o', stream: toolCallStream() }))
    const completed = events.find(e => e.event === 'response.completed')
    const output = completed?.data.response.output
    expect(output.some((item: any) => item.type === 'function_call')).toBe(true)
  })

  // Bug #3 — Streaming tool-call with incremental deltas
  async function* toolCallDeltaStream() {
    yield { type: 'tool-call-start', toolCallId: 'call_abc', toolName: 'search' }
    yield { type: 'tool-call-delta', toolCallId: 'call_abc', argsTextDelta: '{"q":"h' }
    yield { type: 'tool-call-delta', toolCallId: 'call_abc', argsTextDelta: 'ello"}' }
    yield { type: 'tool-call', toolCallId: 'call_abc', toolName: 'search', input: '{"q":"hello"}' }
    yield { type: 'finish', finishReason: 'tool-calls', usage: { promptTokens: 5, completionTokens: 10 }, response: { id: 'resp_delta' } }
  }

  it('handles tool-call-start and tool-call-delta incremental events', async () => {
    const events = await collectSSEEvents(renderOpenAIResponseSSE({ model: 'gpt-4o', stream: toolCallDeltaStream() }))
    const eventTypes = events.map(e => e.event)
    expect(eventTypes).toContain('response.output_item.added')
    // Two deltas from tool-call-delta parts
    const argDeltas = events.filter(e => e.event === 'response.function_call_arguments.delta')
    expect(argDeltas.length).toBe(2)
    expect(argDeltas[0]!.data.delta).toBe('{"q":"h')
    expect(argDeltas[1]!.data.delta).toBe('ello"}')
    expect(eventTypes).toContain('response.function_call_arguments.done')
    expect(eventTypes).toContain('response.output_item.done')
    expect(eventTypes).toContain('response.completed')
  })

  // Bug #12 — new msgId after tool call
  async function* textThenToolCallStream() {
    yield { type: 'text-delta', text: 'Hello' }
    yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'fn', input: {} }
    yield { type: 'text-delta', text: ' world' }
    yield { type: 'finish', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 5 }, response: { id: 'resp_multi' } }
  }

  it('uses different msgId for text after tool call', async () => {
    const events = await collectSSEEvents(renderOpenAIResponseSSE({ model: 'gpt-4o', stream: textThenToolCallStream() }))
    const addedItems = events.filter(e => e.event === 'response.output_item.added')
    // First text message, then function_call, then second text message
    const msgItems = addedItems.filter(e => e.data.item?.type === 'message')
    expect(msgItems.length).toBe(2)
    // The two message items should have different ids
    const ids = msgItems.map(e => e.data.item.id)
    expect(ids[0]).not.toBe(ids[1])
  })
})
