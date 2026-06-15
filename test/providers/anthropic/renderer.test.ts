import { describe, expect, it } from 'vitest'
import type { ProxyStreamPart } from '../../../src/providers/shared/aisdk-types.js'
import type { SSEFrame, SSEOutput } from '../../../src/providers/shared/sse-utils.js'
import { formatSSE } from '../../../src/providers/shared/sse-utils.js'
import { renderAnthropicMessage, renderAnthropicMessageSSE } from '../../../src/providers/anthropic/renderer.js'
import type {
  AnthropicSSEData,
  AnthropicSSEMessageStart,
  AnthropicSSEContentBlockStart,
  AnthropicSSEContentBlockDelta,
  AnthropicSSEMessageDelta,
} from '../../../src/providers/anthropic/types.js'

/** Type guard: narrows SSEOutput to SSEFrame (excludes SSEDone) */
function isFrame<T>(output: SSEOutput<T>): output is SSEFrame<T> {
  return !('type' in output && output.type === 'done')
}

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

    const frames = await collectFrames(parts() as AsyncIterable<ProxyStreamPart>)

    // Verify event sequence
    expect(frames.map((f) => f.data.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])

    // Verify message_start
    const msgStart = frames[0]!.data as AnthropicSSEMessageStart
    expect(msgStart.message.role).toBe('assistant')
    expect(msgStart.message.stop_reason).toBeNull()

    // Verify content_block_start
    const blockStart = frames[1]!.data as AnthropicSSEContentBlockStart
    expect(blockStart.content_block.type).toBe('text')
    expect(blockStart.index).toBe(0)

    // Verify text deltas
    const delta0 = frames[2]!.data as AnthropicSSEContentBlockDelta
    const delta1 = frames[3]!.data as AnthropicSSEContentBlockDelta
    expect(delta0.delta).toEqual({ type: 'text_delta', text: 'hel' })
    expect(delta1.delta).toEqual({ type: 'text_delta', text: 'lo' })

    // Verify message_delta
    const msgDelta = frames[5]!.data as AnthropicSSEMessageDelta
    expect(msgDelta.delta.stop_reason).toBe('end_turn')
    expect(msgDelta.usage!.input_tokens).toBe(10)
    expect(msgDelta.usage!.output_tokens).toBe(5)
  })

  it('omits usage in streaming message_delta when usage is all zeros', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'finish', finishReason: 'stop' }
    }

    const frames = await collectFrames(parts() as AsyncIterable<ProxyStreamPart>)
    const messageDelta = frames.find((f) => f.data.type === 'message_delta')!.data as AnthropicSSEMessageDelta
    expect(messageDelta.delta.stop_reason).toBe('end_turn')
    expect(messageDelta.usage).toBeUndefined()
  })

  it('omits usage in fallback message_delta when stream ends without finish part', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hi' }
      // no finish part — stream just ends
    }

    const frames = await collectFrames(parts() as AsyncIterable<ProxyStreamPart>)
    const messageDelta = frames.find((f) => f.data.type === 'message_delta')!.data as AnthropicSSEMessageDelta
    expect(messageDelta.delta.stop_reason).toBe('end_turn')
    expect(messageDelta.usage).toBeUndefined()
  })

  it('renders streaming tool use SSE events', async () => {
    async function* parts() {
      yield { type: 'tool-input-start', id: 'toolu_1', toolName: 'get_weather' }
      yield { type: 'tool-input-delta', id: 'toolu_1', delta: '{"city"' }
      yield { type: 'tool-input-delta', id: 'toolu_1', delta: ':"NYC"}' }
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 20, outputTokens: 10 } }
    }

    const frames = await collectFrames(parts() as AsyncIterable<ProxyStreamPart>)

    // Verify tool_use block start
    const blockStart = frames.find(
      (f) => f.data.type === 'content_block_start' && f.data.content_block?.type === 'tool_use',
    )!.data as AnthropicSSEContentBlockStart
    expect(blockStart.content_block).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'get_weather',
      input: {},
    })

    // Verify input_json_delta events
    const deltas = frames.filter(
      (f) => f.data.type === 'content_block_delta' && f.data.delta?.type === 'input_json_delta',
    )
    expect(deltas.map((d) => (d.data as AnthropicSSEContentBlockDelta & { delta: { type: 'input_json_delta'; partial_json: string } }).delta.partial_json)).toEqual(['{"city"', ':"NYC"}'])

    // Verify stop reason
    const messageDelta = frames.find((f) => f.data.type === 'message_delta')!.data as AnthropicSSEMessageDelta
    expect(messageDelta.delta.stop_reason).toBe('tool_use')
  })

  it('renders complete tool-call events (non-streaming input)', async () => {
    async function* parts() {
      yield { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'get_weather', args: { city: 'NYC' } }
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 15, outputTokens: 8 } }
    }

    const frames = await collectFrames(parts() as AsyncIterable<ProxyStreamPart>)

    // Should have content_block_start with tool_use, then input_json_delta, then stop
    const blockStart = frames.find((f) => f.data.type === 'content_block_start')!.data as AnthropicSSEContentBlockStart
    expect(blockStart.content_block.type).toBe('tool_use')

    const jsonDelta = frames.find(
      (f) => f.data.type === 'content_block_delta' && f.data.delta?.type === 'input_json_delta',
    )!.data as AnthropicSSEContentBlockDelta & { delta: { type: 'input_json_delta'; partial_json: string } }
    expect(jsonDelta.delta.partial_json).toBe('{"city":"NYC"}')
  })

  it('uses named SSE events format', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 1 } }
    }

    const outputs: SSEOutput<AnthropicSSEData>[] = []
    for await (const chunk of renderAnthropicMessageSSE({ model: 'm', stream: parts() as AsyncIterable<ProxyStreamPart> })) {
      outputs.push(chunk)
    }
    const raw = outputs.map((o) => formatSSE(o)).join('')

    // Anthropic SSE uses "event: <type>\ndata: <json>\n\n"
    expect(raw).toContain('event: message_start\ndata: ')
    expect(raw).toContain('event: content_block_start\ndata: ')
    expect(raw).toContain('event: content_block_delta\ndata: ')
    expect(raw).toContain('event: content_block_stop\ndata: ')
    expect(raw).toContain('event: message_delta\ndata: ')
    expect(raw).toContain('event: message_stop\ndata: ')
  })
})

/** Collect SSEFrame items from the renderer (filters out SSEDone) */
async function collectFrames(stream: AsyncIterable<ProxyStreamPart>): Promise<SSEFrame<AnthropicSSEData>[]> {
  const frames: SSEFrame<AnthropicSSEData>[] = []
  for await (const output of renderAnthropicMessageSSE({ model: 'test-model', stream })) {
    if (isFrame(output)) frames.push(output)
  }
  return frames
}
