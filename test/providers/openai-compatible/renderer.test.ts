import { describe, expect, it } from 'vitest'
import type { ProxyStreamPart } from '../../../src/providers/shared/aisdk-types.js'
import type { SSEOutput } from '../../../src/providers/shared/sse-utils.js'
import { formatSSE } from '../../../src/providers/shared/sse-utils.js'
import type {
  OpenAIChatChunk,
  OpenAIChatStreamError,
} from '../../../src/providers/openai-compatible/types.js'
import {
  renderOpenAIChatCompletion,
  renderOpenAIChatCompletionSSE,
} from '../../../src/providers/openai-compatible/renderer.js'
import { collectSSEFrames } from '../../helpers/sse.js'

describe('OpenAI chat renderer', () => {
  it('renders text completions', () => {
    const body = renderOpenAIChatCompletion({
      model: 'openrouter/chat',
      text: 'hello',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      response: { id: 'upstream-id', timestamp: new Date(0) },
    })

    expect(body).toMatchObject({
      id: 'upstream-id',
      object: 'chat.completion',
      created: 0,
      model: 'openrouter/chat',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    })
  })

  it('computes totalTokens from inputTokens + outputTokens when totalTokens is undefined', () => {
    const body = renderOpenAIChatCompletion({
      model: 'openrouter/chat',
      text: 'hello',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3 },
    })

    expect(body.usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 })
  })

  it('uses totalTokens when explicitly provided', () => {
    const body = renderOpenAIChatCompletion({
      model: 'openrouter/chat',
      text: 'hello',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 100 },
    })

    expect(body.usage!.total_tokens).toBe(100)
  })

  it('omits usage when not provided', () => {
    const body = renderOpenAIChatCompletion({
      model: 'openrouter/chat',
      text: 'hello',
      finishReason: 'stop',
    })

    expect(body.usage).toBeUndefined()
  })

  it('omits usage in non-streaming when all tokens are zero', () => {
    const body = renderOpenAIChatCompletion({
      model: 'openrouter/chat',
      text: 'hello',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    })

    expect(body.usage).toBeUndefined()
  })

  it('renders non-streaming tool calls', () => {
    const body = renderOpenAIChatCompletion({
      model: 'openrouter/chat',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'NYC' } }],
    })

    expect(body.choices[0]!.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
    ])
    expect(body.choices[0]!.finish_reason).toBe('tool_calls')
  })

  it('renders text and done SSE chunks', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hel' }
      yield { type: 'text-delta', text: 'lo' }
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 10, outputTokens: 5 },
      }
    }

    const stream = renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIChatChunk | OpenAIChatStreamError>(stream)

    // First two are text chunks
    expect(events[0]!.data).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'hel' }, finish_reason: null }],
    })
    expect(events[1]!.data).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }],
    })

    // Verify usage in the finish chunk
    const finishEvent = events.find(
      (e) => (e.data as OpenAIChatChunk).choices?.[0]?.finish_reason === 'stop',
    )
    expect((finishEvent!.data as OpenAIChatChunk).usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    })

    // Verify [DONE] sentinel
    const outputs: Array<SSEOutput<OpenAIChatChunk | OpenAIChatStreamError>> = []
    for await (const chunk of renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })) {
      outputs.push(chunk)
    }
    expect(outputs.at(-1)).toEqual({ type: 'done' })
  })

  it('omits usage in SSE finish chunk when usage is all zeros', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'finish', finishReason: 'stop' }
    }

    const stream = renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIChatChunk | OpenAIChatStreamError>(stream)

    const finishEvent = events.find(
      (e) => (e.data as OpenAIChatChunk).choices?.[0]?.finish_reason === 'stop',
    )
    expect((finishEvent!.data as OpenAIChatChunk).usage).toBeUndefined()
  })

  it('uses upstream totalTokens in SSE finish chunk when available', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hi' }
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 20 },
      }
    }

    const stream = renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIChatChunk | OpenAIChatStreamError>(stream)

    const finishEvent = events.find(
      (e) => (e.data as OpenAIChatChunk).choices?.[0]?.finish_reason === 'stop',
    )
    expect((finishEvent!.data as OpenAIChatChunk).usage!.total_tokens).toBe(20)
  })

  it('keeps a stable SSE tool call index across complete tool call events', async () => {
    async function* parts() {
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        input: { city: 'NYC' },
      }
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        input: { unit: 'fahrenheit' },
      }
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: { inputTokens: 5, outputTokens: 3 },
      }
    }

    const events = await collectSSEFrames<OpenAIChatChunk | OpenAIChatStreamError>(
      renderOpenAIChatCompletionSSE({
        model: 'openrouter/chat',
        stream: parts() as AsyncIterable<ProxyStreamPart>,
      }),
    )
    const toolCalls = events
      .flatMap((event) => (event.data as OpenAIChatChunk).choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? [])

    expect(toolCalls.map((tc) => tc.index)).toEqual([0, 0])
    const lastEvent = events.at(-1)
    expect((lastEvent!.data as OpenAIChatChunk).choices?.[0]?.finish_reason).toBe('tool_calls')
  })

  it('renders complete tool call arguments when no argument deltas were emitted', async () => {
    async function* parts() {
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' }
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        input: { city: 'NYC' },
      }
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: { inputTokens: 5, outputTokens: 3 },
      }
    }

    const events = await collectSSEFrames<OpenAIChatChunk | OpenAIChatStreamError>(
      renderOpenAIChatCompletionSSE({
        model: 'openrouter/chat',
        stream: parts() as AsyncIterable<ProxyStreamPart>,
      }),
    )
    const toolCalls = events
      .flatMap((event) => (event.data as OpenAIChatChunk).choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? [])

    expect(toolCalls).toMatchObject([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
      {
        index: 0,
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
    ])
  })

  it('does not repeat complete tool call arguments after argument deltas were emitted', async () => {
    async function* parts() {
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' }
      yield { type: 'tool-input-delta', id: 'call_1', delta: '{"city"' }
      yield { type: 'tool-input-delta', id: 'call_1', delta: ':"NYC"}' }
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        input: { city: 'NYC' },
      }
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: { inputTokens: 5, outputTokens: 3 },
      }
    }

    const events = await collectSSEFrames<OpenAIChatChunk | OpenAIChatStreamError>(
      renderOpenAIChatCompletionSSE({
        model: 'openrouter/chat',
        stream: parts() as AsyncIterable<ProxyStreamPart>,
      }),
    )
    const toolCalls = events
      .flatMap((event) => (event.data as OpenAIChatChunk).choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? [])

    expect(toolCalls).toMatchObject([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
      { index: 0, function: { arguments: '{"city"' } },
      { index: 0, function: { arguments: ':"NYC"}' } },
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
    ])
    expect(toolCalls.at(-1)?.function).not.toHaveProperty('arguments')
  })

  it('renders AI SDK v6 tool input events and suppresses duplicate complete arguments', async () => {
    async function* parts() {
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' }
      yield { type: 'tool-input-delta', id: 'call_1', delta: '{"city"' }
      yield { type: 'tool-input-delta', id: 'call_1', delta: ':"NYC"}' }
      yield { type: 'tool-input-end', id: 'call_1' }
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        input: { city: 'NYC' },
      }
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: { inputTokens: 5, outputTokens: 3 },
      }
    }

    const events = await collectSSEFrames<OpenAIChatChunk | OpenAIChatStreamError>(
      renderOpenAIChatCompletionSSE({
        model: 'openrouter/chat',
        stream: parts() as AsyncIterable<ProxyStreamPart>,
      }),
    )
    const toolCalls = events
      .flatMap((event) => (event.data as OpenAIChatChunk).choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? [])

    expect(toolCalls).toMatchObject([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
      { index: 0, function: { arguments: '{"city"' } },
      { index: 0, function: { arguments: ':"NYC"}' } },
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
    ])
    expect(toolCalls.at(-1)?.function).not.toHaveProperty('arguments')
  })

  it('yields structured SSEOutput that formats correctly via formatSSE', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'finish', finishReason: 'stop' }
    }

    const outputs: Array<SSEOutput<OpenAIChatChunk | OpenAIChatStreamError>> = []
    for await (const chunk of renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })) {
      outputs.push(chunk)
    }

    // Verify wire format via formatSSE
    const wire = outputs.map((o) => formatSSE(o)).join('')
    expect(wire).toContain('"content":"hi"')
    expect(wire).toContain('data: [DONE]')
  })
})
