import { describe, expect, it } from 'vitest'
import { teeStream } from '../../src/server/tee-stream.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'

async function* fromArray(parts: ProxyStreamPart[]): AsyncIterable<ProxyStreamPart> {
  for (const part of parts) yield part
}

const usage = {
  inputTokens: 1,
  outputTokens: 2,
  totalTokens: 3,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
}

describe('teeStream', () => {
  it('buffers all yielded chunks into the buffer array', async () => {
    const chunks: ProxyStreamPart[] = [
      { type: 'text-delta', id: 'txt-1', text: 'hello' },
      { type: 'text-delta', id: 'txt-1', text: ' world' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage },
    ]
    const buffer: ProxyStreamPart[] = []
    const collected: ProxyStreamPart[] = []
    for await (const part of teeStream(fromArray(chunks), buffer)) {
      collected.push(part)
    }
    expect(collected).toEqual(chunks)
    expect(buffer).toEqual(chunks)
  })

  it('buffers partial chunks when source throws mid-stream', async () => {
    const emitted: ProxyStreamPart[] = [{ type: 'text-delta', id: 'txt-1', text: 'partial' }]
    async function* throwingStream(): AsyncIterable<ProxyStreamPart> {
      yield emitted[0]!
      throw new Error('upstream broke')
    }
    const buffer: ProxyStreamPart[] = []
    await expect(async () => {
      for await (const _ of teeStream(throwingStream(), buffer)) {
        // consume
      }
    }).rejects.toThrow('upstream broke')
    expect(buffer).toEqual(emitted)
  })

  it('preserves object identity (stores references not clones)', async () => {
    const chunk: ProxyStreamPart = { type: 'text-delta', id: 'txt-1', text: 'x' }
    const buffer: ProxyStreamPart[] = []
    for await (const part of teeStream(fromArray([chunk]), buffer)) {
      expect(part).toBe(chunk)
    }
    expect(buffer[0]).toBe(chunk)
  })
})
