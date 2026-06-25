import { describe, expect, it } from 'vitest'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import { normalizeStream } from '../../src/server/gateway.js'

/** 把 part 数组包装为 async iterable，模拟 AI SDK fullStream */
async function* from(parts: ProxyStreamPart[]): AsyncIterable<ProxyStreamPart> {
  for (const part of parts) yield part
}

/** 收集 normalizeStream 输出为 part 数组 */
async function collect(stream: AsyncIterable<ProxyStreamPart>): Promise<ProxyStreamPart[]> {
  const out: ProxyStreamPart[] = []
  for await (const part of stream) out.push(part)
  return out
}

/** 构造完整的 LanguageModelUsage（AI SDK v6 所有字段必填） */
const usage = {
  inputTokens: 1,
  outputTokens: 2,
  totalTokens: 3,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
}

describe('normalizeStream', () => {
  it('注入 finish-step.response 到 finish part', async () => {
    const ts = new Date('2026-06-24T00:00:00Z')
    const parts: ProxyStreamPart[] = [
      { type: 'finish-step', response: { id: 'chatcmpl-1', timestamp: ts }, usage, finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage },
    ]

    const out = await collect(normalizeStream(from(parts)))
    expect(out).toHaveLength(2)
    expect(out[0]?.type).toBe('finish-step')
    const finish = out[1]
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') {
      expect(finish.response).toEqual({ id: 'chatcmpl-1', timestamp: ts })
    }
  })

  it('纯 finish（无前置 finish-step）原样输出，不注入 response', async () => {
    const parts: ProxyStreamPart[] = [
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage },
    ]

    const out = await collect(normalizeStream(from(parts)))
    expect(out).toHaveLength(1)
    const finish = out[0]
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') {
      expect(finish.response).toBeUndefined()
    }
  })

  it('多个 finish-step 时，finish 使用最后一个 finish-step 的 response', async () => {
    const ts1 = new Date('2026-06-24T00:00:00Z')
    const ts2 = new Date('2026-06-24T00:01:00Z')
    const parts: ProxyStreamPart[] = [
      { type: 'finish-step', response: { id: 'chatcmpl-1', timestamp: ts1 }, usage, finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined },
      { type: 'finish-step', response: { id: 'chatcmpl-2', timestamp: ts2 }, usage, finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage },
    ]

    const out = await collect(normalizeStream(from(parts)))
    expect(out).toHaveLength(3)
    const finish = out[2]
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') {
      expect(finish.response).toEqual({ id: 'chatcmpl-2', timestamp: ts2 })
    }
  })

  it('非 finish/finish-step part（如 text-delta）原样透传', async () => {
    const parts: ProxyStreamPart[] = [
      { type: 'text-delta', id: 'td-1', text: 'hello' },
      { type: 'text-end', id: 'td-1' },
    ]

    const out = await collect(normalizeStream(from(parts)))
    expect(out).toEqual(parts)
  })

  it('finish-step.response 缺字段时只注入存在的字段', async () => {
    // 只有 id，无 timestamp
    const partsOnlyId: ProxyStreamPart[] = [
      { type: 'finish-step', response: { id: 'chatcmpl-x' }, usage, finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage },
    ]
    const outOnlyId = await collect(normalizeStream(from(partsOnlyId)))
    const finishId = outOnlyId[1]
    if (finishId?.type === 'finish') {
      expect(finishId.response).toEqual({ id: 'chatcmpl-x' })
      expect(finishId.response?.timestamp).toBeUndefined()
    }

    // 只有 timestamp，无 id
    const ts = new Date('2026-06-24T00:00:00Z')
    const partsOnlyTs: ProxyStreamPart[] = [
      { type: 'finish-step', response: { timestamp: ts }, usage, finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage },
    ]
    const outOnlyTs = await collect(normalizeStream(from(partsOnlyTs)))
    const finishTs = outOnlyTs[1]
    if (finishTs?.type === 'finish') {
      expect(finishTs.response).toEqual({ timestamp: ts })
      expect(finishTs.response?.id).toBeUndefined()
    }

    // response 为空对象 → 注入空对象（lastStepResponse 被设为 {}）
    const partsEmpty: ProxyStreamPart[] = [
      { type: 'finish-step', response: {}, usage, finishReason: 'stop', rawFinishReason: 'stop', providerMetadata: undefined },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage },
    ]
    const outEmpty = await collect(normalizeStream(from(partsEmpty)))
    const finishEmpty = outEmpty[1]
    if (finishEmpty?.type === 'finish') {
      expect(finishEmpty.response).toEqual({})
    }
  })
})
