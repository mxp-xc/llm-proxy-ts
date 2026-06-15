import { describe, expect, it } from 'vitest'
import type { ProxyStreamPart } from '../../../src/providers/shared/aisdk-types.js'
import {
  renderOpenAIChatCompletion,
  renderOpenAIChatCompletionSSE,
} from '../../../src/providers/openai-compatible/renderer.js'
import { collectSSEEvents } from '../../helpers/sse.js'

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
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 5 } }
    }

    const stream = renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEEvents(stream)

    // Verify text deltas present in raw data
    const dataJsons = events.map((e) => JSON.stringify(e.data))
    expect(dataJsons.some((j) => j.includes('"hel"'))).toBe(true)
    expect(dataJsons.some((j) => j.includes('"lo"'))).toBe(true)

    // Verify usage in the finish event
    const finishEvent = events.find((e: any) => e.data?.choices?.[0]?.finish_reason === 'stop')
    expect(finishEvent!.data.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })

    // Verify [DONE] sentinel
    const chunks: string[] = []
    for await (const chunk of renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })) {
      chunks.push(new TextDecoder().decode(chunk))
    }
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n')
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
    const events = await collectSSEEvents(stream)
    const finishEvent = events.find((e: any) => e.data?.choices?.[0]?.finish_reason === 'stop')
    expect(finishEvent!.data.usage).toBeUndefined()
  })

  it('uses upstream totalTokens in SSE finish chunk when available', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 20 } }
    }

    const stream = renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEEvents(stream)
    const finishEvent = events.find((e: any) => e.data?.choices?.[0]?.finish_reason === 'stop')
    expect(finishEvent!.data.usage.total_tokens).toBe(20)
  })

  it('keeps a stable SSE tool call index across complete tool call events', async () => {
    async function* parts() {
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        args: { city: 'NYC' },
      }
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        args: { unit: 'fahrenheit' },
      }
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 5, outputTokens: 3 } }
    }

    const stream = renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEEvents(stream)
    const toolCalls = events
      .flatMap((event) => event.data?.choices ?? [])
      .flatMap((choice: any) => choice.delta?.tool_calls ?? [])

    expect(toolCalls.map((toolCall: any) => toolCall.index)).toEqual([0, 0])
    const lastEvent = events.at(-1)
    expect(lastEvent!.data?.choices?.[0]?.finish_reason).toBe('tool_calls')
  })

  it('renders complete tool call arguments when no argument deltas were emitted', async () => {
    async function* parts() {
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' }
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        args: { city: 'NYC' },
      }
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 5, outputTokens: 3 } }
    }

    const stream = renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEEvents(stream)
    const toolCalls = events
      .flatMap((event) => event.data?.choices ?? [])
      .flatMap((choice: any) => choice.delta?.tool_calls ?? [])

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
        args: { city: 'NYC' },
      }
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 5, outputTokens: 3 } }
    }

    const stream = renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEEvents(stream)
    const toolCalls = events
      .flatMap((event) => event.data?.choices ?? [])
      .flatMap((choice: any) => choice.delta?.tool_calls ?? [])

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
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', args: { city: 'NYC' } }
      yield { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 5, outputTokens: 3 } }
    }

    const stream = renderOpenAIChatCompletionSSE({
      model: 'openrouter/chat',
      stream: parts() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEEvents(stream)
    const toolCalls = events
      .flatMap((event) => event.data?.choices ?? [])
      .flatMap((choice: any) => choice.delta?.tool_calls ?? [])

    expect(toolCalls).toMatchObject([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
      { index: 0, function: { arguments: '{"city"' } },
      { index: 0, function: { arguments: ':"NYC"}' } },
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
    ])
    expect(toolCalls.at(-1)?.function).not.toHaveProperty('arguments')
  })
})
