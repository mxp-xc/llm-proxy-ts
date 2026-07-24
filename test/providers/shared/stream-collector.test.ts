import { describe, it, expect } from 'vitest'
import { collectStreamResult } from '../../../src/providers/shared/stream-collector.js'
import type { ProxyStreamPart } from '../../../src/providers/shared/aisdk-types.js'

/** 构造 AI SDK fullStream 风格的 async iterable */
async function* chunks(...items: unknown[]): AsyncIterable<unknown> {
  for (const item of items) yield item
}

describe('collectStreamResult', () => {
  it('collects text from text-delta chunks', async () => {
    const stream = chunks(
      { type: 'text-delta', text: 'Hello' },
      { type: 'text-delta', text: ' world' },
      { type: 'finish', finishReason: 'stop', totalUsage: {} },
    )
    const result = await collectStreamResult(stream as AsyncIterable<ProxyStreamPart>)
    expect(result.text).toBe('Hello world')
  })

  it('collects reasoning from reasoning-delta chunks', async () => {
    const stream = chunks(
      { type: 'reasoning-start', id: 'reasoning-0' },
      { type: 'reasoning-delta', id: 'reasoning-0', text: 'thinking ' },
      { type: 'reasoning-delta', id: 'reasoning-0', text: 'step by step' },
      { type: 'reasoning-end', id: 'reasoning-0' },
      { type: 'finish', finishReason: 'stop', totalUsage: {} },
    )

    const result = await collectStreamResult(stream as AsyncIterable<ProxyStreamPart>)

    expect(result.reasoningText).toBe('thinking step by step')
  })

  it('collects finishReason and usage from finish chunk', async () => {
    const stream = chunks(
      { type: 'text-delta', text: 'hi' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    )
    const result = await collectStreamResult(stream as AsyncIterable<ProxyStreamPart>)
    expect(result.finishReason).toBe('stop')
    expect(result.usage?.inputTokens).toBe(10)
    expect(result.usage?.outputTokens).toBe(5)
    expect(result.usage?.totalTokens).toBe(15)
  })

  it('collects response id from finish chunk', async () => {
    const stream = chunks(
      { type: 'text-delta', text: 'hi' },
      {
        type: 'finish',
        finishReason: 'stop',
        response: { id: 'chatcmpl-123' },
        totalUsage: {},
      },
    )
    const result = await collectStreamResult(stream as AsyncIterable<ProxyStreamPart>)
    expect(result.response?.id).toBe('chatcmpl-123')
  })

  it('collects tool calls from tool-call chunks', async () => {
    const stream = chunks(
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        input: '{"city":"Tokyo"}',
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: {},
      },
    )
    const result = await collectStreamResult(stream as AsyncIterable<ProxyStreamPart>)
    expect(result.toolCalls).toEqual([
      { toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Tokyo' } },
    ])
    expect(result.finishReason).toBe('tool-calls')
  })

  it('returns empty text and undefined usage when stream has no relevant chunks', async () => {
    const stream = chunks({ type: 'finish', finishReason: 'stop', totalUsage: {} })
    const result = await collectStreamResult(stream as AsyncIterable<ProxyStreamPart>)
    expect(result.text).toBe('')
    expect(result.finishReason).toBe('stop')
  })

  it('rejects a stream that ends without a finish chunk', async () => {
    const stream = chunks()
    await expect(
      collectStreamResult(stream as AsyncIterable<ProxyStreamPart>),
    ).rejects.toMatchObject({ name: 'IncompleteStreamError' })
  })

  it('rejects in-band error chunks with the original error', async () => {
    const error = new Error('stream failed')
    const stream = chunks({ type: 'error', error })

    await expect(collectStreamResult(stream as AsyncIterable<ProxyStreamPart>)).rejects.toBe(error)
  })

  it('rejects openai-error chunks with their upstream status', async () => {
    const stream = chunks({ type: 'openai-error', body: {}, status: 429 })

    await expect(
      collectStreamResult(stream as AsyncIterable<ProxyStreamPart>),
    ).rejects.toMatchObject({ message: 'Upstream stream error', statusCode: 429 })
  })

  it('rejects abort chunks as AbortError', async () => {
    const stream = chunks({ type: 'abort', reason: 'upstream closed' })

    await expect(
      collectStreamResult(stream as AsyncIterable<ProxyStreamPart>),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'upstream closed' })
  })

  it('preserves cacheReadTokens and reasoningTokens from finish chunk', async () => {
    const stream = chunks(
      { type: 'text-delta', text: 'hi' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          inputTokenDetails: { cacheReadTokens: 80 },
          outputTokenDetails: { reasoningTokens: 20 },
        },
      },
    )
    const result = await collectStreamResult(stream as AsyncIterable<ProxyStreamPart>)
    expect(result.usage?.inputTokens).toBe(100)
    expect(result.usage?.outputTokens).toBe(50)
    expect(result.usage?.totalTokens).toBe(150)
    expect(result.usage?.cacheReadTokens).toBe(80)
    expect(result.usage?.reasoningTokens).toBe(20)
  })

  it('captures response timestamp from finish chunk', async () => {
    const ts = new Date('2025-06-13T12:00:00Z')
    const stream = chunks(
      { type: 'text-delta', text: 'hi' },
      {
        type: 'finish',
        finishReason: 'stop',
        response: { id: 'chatcmpl-123', timestamp: ts },
        totalUsage: {},
      },
    )
    const result = await collectStreamResult(stream as AsyncIterable<ProxyStreamPart>)
    expect(result.response?.id).toBe('chatcmpl-123')
    expect(result.response?.timestamp).toEqual(ts)
  })

  it('preserves providerExecuted on tool-call for hosted tools', async () => {
    async function* stream() {
      yield {
        type: 'tool-call',
        toolCallId: 'ws_1',
        toolName: 'web_search',
        input: '{}',
        providerExecuted: true,
      } as ProxyStreamPart
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 1, outputTokens: 1 },
      } as ProxyStreamPart
    }
    const result = await collectStreamResult(stream())
    expect(result.toolCalls).toEqual([
      { toolCallId: 'ws_1', toolName: 'web_search', input: {}, providerExecuted: true },
    ])
  })
})
