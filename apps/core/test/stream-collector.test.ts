import { describe, it, expect } from 'vitest'
import { collectStreamResult } from '../src/providers/shared/stream-collector.js'

/** 构造 AI SDK fullStream 风格的 async iterable */
async function* chunks(...items: unknown[]): AsyncIterable<unknown> {
  for (const item of items) yield item
}

describe('collectStreamResult', () => {
  it('collects text from text-delta chunks', async () => {
    const stream = chunks(
      { type: 'text-delta', textDelta: 'Hello' },
      { type: 'text-delta', textDelta: ' world' },
    )
    const result = await collectStreamResult(stream)
    expect(result.text).toBe('Hello world')
  })

  it('collects finishReason and usage from finish chunk', async () => {
    const stream = chunks(
      { type: 'text-delta', textDelta: 'hi' },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    )
    const result = await collectStreamResult(stream)
    expect(result.finishReason).toBe('stop')
    expect(result.usage?.inputTokens).toBe(10)
    expect(result.usage?.outputTokens).toBe(5)
    expect(result.usage?.totalTokens).toBe(15)
  })

  it('collects response id from finish chunk', async () => {
    const stream = chunks(
      { type: 'text-delta', textDelta: 'hi' },
      {
        type: 'finish',
        finishReason: 'stop',
        response: { id: 'chatcmpl-123' },
        totalUsage: {},
      },
    )
    const result = await collectStreamResult(stream)
    expect(result.response?.id).toBe('chatcmpl-123')
  })

  it('collects tool calls from tool-call chunks', async () => {
    const stream = chunks(
      {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'get_weather',
        args: '{"city":"Tokyo"}',
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: {},
      },
    )
    const result = await collectStreamResult(stream)
    expect(result.toolCalls).toEqual([
      { toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Tokyo' } },
    ])
    expect(result.finishReason).toBe('tool-calls')
  })

  it('returns empty text and undefined usage when stream has no relevant chunks', async () => {
    const stream = chunks({ type: 'finish', finishReason: 'stop', totalUsage: {} })
    const result = await collectStreamResult(stream)
    expect(result.text).toBe('')
    expect(result.finishReason).toBe('stop')
  })

  it('handles empty stream gracefully', async () => {
    const stream = chunks()
    const result = await collectStreamResult(stream)
    expect(result.text).toBe('')
    expect(result.finishReason).toBeUndefined()
    expect(result.usage).toBeUndefined()
  })

  it('preserves cacheReadTokens and reasoningTokens from finish chunk', async () => {
    const stream = chunks(
      { type: 'text-delta', textDelta: 'hi' },
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
    const result = await collectStreamResult(stream)
    expect(result.usage?.inputTokens).toBe(100)
    expect(result.usage?.outputTokens).toBe(50)
    expect(result.usage?.totalTokens).toBe(150)
    expect(result.usage?.cacheReadTokens).toBe(80)
    expect(result.usage?.reasoningTokens).toBe(20)
  })

  it('captures response timestamp from finish chunk', async () => {
    const ts = new Date('2025-06-13T12:00:00Z')
    const stream = chunks(
      { type: 'text-delta', textDelta: 'hi' },
      {
        type: 'finish',
        finishReason: 'stop',
        response: { id: 'chatcmpl-123', timestamp: ts },
        totalUsage: {},
      },
    )
    const result = await collectStreamResult(stream)
    expect(result.response?.id).toBe('chatcmpl-123')
    expect(result.response?.timestamp).toEqual(ts)
  })
})
