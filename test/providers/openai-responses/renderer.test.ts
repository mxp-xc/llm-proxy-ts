import { describe, expect, it } from 'vitest'
import type { ProxyStreamPart } from '../../../src/providers/shared/aisdk-types.js'
import type {
  OpenAIResponseStreamEvent,
  ResponseOutputTextDeltaEvent,
  ResponseCompletedEvent,
  ResponseOutputItemAddedEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
} from '../../../src/providers/openai-responses/types.js'
import { renderOpenAIResponse, renderOpenAIResponseSSE } from '../../../src/providers/openai-responses/renderer.js'
import { collectSSEFrames } from '../../helpers/sse.js'

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

  it('omits usage in non-streaming when all tokens are zero', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: 'hi',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    expect(result.usage).toBeUndefined()
  })

  it('passes cacheReadTokens and reasoningTokens through in non-streaming response', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: 'hi',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 20, cacheReadTokens: 3, reasoningTokens: 7 },
    })
    expect(result.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 20,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 7 },
    })
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
    totalUsage: { inputTokens: 10, outputTokens: 5 },
    response: { id: 'resp_test123' },
  }
}

describe('renderOpenAIResponseSSE', () => {
  it('emits correct event sequence for text streaming', async () => {
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: textStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
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
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: textStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const deltas = events
      .filter(e => e.event === 'response.output_text.delta')
      .map(e => e.data as ResponseOutputTextDeltaEvent)
    expect(deltas[0]!.delta).toBe('Hello')
    expect(deltas[1]!.delta).toBe(' world')
  })

  it('emits completed response with full data', async () => {
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: textStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const completed = events.find(e => e.event === 'response.completed')!.data as ResponseCompletedEvent
    expect(completed.response.object).toBe('response')
    expect(completed.response.status).toBe('completed')
    expect(completed.response.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    })
  })

  it('omits usage in completed response when usage is all zeros', async () => {
    async function* noUsageStream() {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'finish', finishReason: 'stop', response: { id: 'resp_no_usage' } }
    }
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: noUsageStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const completed = events.find(e => e.event === 'response.completed')!.data as ResponseCompletedEvent
    expect(completed.response.usage).toBeUndefined()
  })

  it('passes cacheReadTokens and reasoningTokens through in SSE response.completed', async () => {
    async function* detailStream() {
      yield { type: 'text-delta', text: 'hi' }
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 20,
          inputTokenDetails: { cacheReadTokens: 3 },
          outputTokenDetails: { reasoningTokens: 7 },
        },
        response: { id: 'resp_detail' },
      }
    }
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: detailStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const completed = events.find(e => e.event === 'response.completed')!.data as ResponseCompletedEvent
    expect(completed.response.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 20,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 7 },
    })
  })

  it('includes sequence_number in events', async () => {
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: textStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    for (const event of events) {
      expect(typeof event.data.sequence_number).toBe('number')
    }
  })

  // Bug #3 / #1 — Streaming tool-call with complete part (no deltas)
  async function* toolCallStream() {
    yield { type: 'tool-call', toolCallId: 'call_123', toolName: 'get_weather', args: { location: 'Paris' } }
    yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 10, outputTokens: 5 }, response: { id: 'resp_test' } }
  }

  it('emits tool-call events for complete tool-call part', async () => {
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: toolCallStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
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
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: errorStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const eventTypes = events.map(e => e.event)
    expect(eventTypes).toContain('response.error')
    expect(eventTypes).toContain('response.completed')
    const completed = events.find(e => e.event === 'response.completed')!.data as ResponseCompletedEvent
    expect(completed.response.status).toBe('incomplete')
    // No events after response.completed
    const completedIndex = eventTypes.indexOf('response.completed')
    expect(eventTypes.length).toBe(completedIndex + 1)
  })

  // Bug #1 — response.completed includes tool calls
  it('includes function_call items in response.completed output', async () => {
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: toolCallStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const completed = events.find(e => e.event === 'response.completed')!.data as ResponseCompletedEvent
    const output = completed.response.output
    expect(output.some((item) => item.type === 'function_call')).toBe(true)
  })

  // Bug #3 — Streaming tool-call with incremental deltas
  async function* toolCallDeltaStream() {
    yield { type: 'tool-input-start', id: 'call_abc', toolName: 'search' }
    yield { type: 'tool-input-delta', id: 'call_abc', delta: '{"q":"h' }
    yield { type: 'tool-input-delta', id: 'call_abc', delta: 'ello"}' }
    yield { type: 'tool-call', toolCallId: 'call_abc', toolName: 'search', args: '{"q":"hello"}' }
    yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 5, outputTokens: 10 }, response: { id: 'resp_delta' } }
  }

  it('handles tool-call-start and tool-call-delta incremental events', async () => {
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: toolCallDeltaStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const eventTypes = events.map(e => e.event)
    expect(eventTypes).toContain('response.output_item.added')
    // Two deltas from tool-call-delta parts
    const argDeltas = events
      .filter(e => e.event === 'response.function_call_arguments.delta')
      .map(e => e.data as ResponseFunctionCallArgumentsDeltaEvent)
    expect(argDeltas.length).toBe(2)
    expect(argDeltas[0]!.delta).toBe('{"q":"h')
    expect(argDeltas[1]!.delta).toBe('ello"}')
    expect(eventTypes).toContain('response.function_call_arguments.done')
    expect(eventTypes).toContain('response.output_item.done')
    expect(eventTypes).toContain('response.completed')
  })

  // Bug #12 — new msgId after tool call
  async function* textThenToolCallStream() {
    yield { type: 'text-delta', text: 'Hello' }
    yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'fn', args: {} }
    yield { type: 'text-delta', text: ' world' }
    yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 5 }, response: { id: 'resp_multi' } }
  }

  it('uses different msgId for text after tool call', async () => {
    const stream = renderOpenAIResponseSSE({ model: 'gpt-4o', stream: textThenToolCallStream() as AsyncIterable<ProxyStreamPart> })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const addedItems = events
      .filter(e => e.event === 'response.output_item.added')
      .map(e => e.data as ResponseOutputItemAddedEvent)
    // First text message, then function_call, then second text message
    const msgItems = addedItems.filter(e => e.item?.type === 'message')
    expect(msgItems.length).toBe(2)
    // The two message items should have different ids
    const ids = msgItems.map(e => e.item.id)
    expect(ids[0]).not.toBe(ids[1])
  })
})
