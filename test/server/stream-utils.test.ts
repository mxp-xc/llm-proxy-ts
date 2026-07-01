import { describe, expect, it } from 'vitest'
import { readableStreamFromAsyncIterable } from '../../src/server/stream-utils.js'
import type { SSEOutput } from '../../src/providers/shared/sse-utils.js'

describe('readableStreamFromAsyncIterable', () => {
  it('正常消费：SSE 帧格式化为字节流并以 [DONE] 结束', async () => {
    async function* gen(): AsyncIterable<SSEOutput<unknown>> {
      yield { data: { v: 1 } }
      yield { type: 'done' }
    }
    const stream = readableStreamFromAsyncIterable(gen(), () => {})
    const reader = stream.getReader()
    const chunks: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(new TextDecoder().decode(value))
    }
    expect(chunks).toEqual(['data: {"v":1}\n\n', 'data: [DONE]\n\n'])
  })

  it('cancel 时取消上游迭代器并 abort 上游 fetch', async () => {
    const ac = new AbortController()
    let returnCalled = false
    const iterable: AsyncIterable<SSEOutput<unknown>> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ value: { data: { v: 1 } }, done: false }),
          return: async () => {
            returnCalled = true
            return { value: undefined, done: true }
          },
        }
      },
    }

    const stream = readableStreamFromAsyncIterable(iterable, () => {}, ac)
    const reader = stream.getReader()
    await reader.read() // 触发一次 pull
    await reader.cancel('client disconnected')

    expect(returnCalled).toBe(true)
    expect(ac.signal.aborted).toBe(true)
  })

  it('cancel 后飞行中的 pull 不往已关闭 controller enqueue（治 ERR_INVALID_STATE）', async () => {
    const ac = new AbortController()
    let resolveNext: ((v: { value: SSEOutput<unknown>; done: false }) => void) | undefined
    const iterable: AsyncIterable<SSEOutput<unknown>> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<{ value: SSEOutput<unknown>; done: false }>((resolve) => {
              resolveNext = resolve
            }),
          return: async () => ({ value: undefined, done: true }),
        }
      },
    }

    const errors: unknown[] = []
    const stream = readableStreamFromAsyncIterable(iterable, (e) => errors.push(e), ac)
    const reader = stream.getReader()

    const readPromise = reader.read() // 触发 pull，await next（挂起）
    await new Promise((r) => setTimeout(r, 0)) // 让 pull 进入 await

    await reader.cancel('client gone')

    // 上游迟到数据到达：修复前会 enqueue 到已关闭 controller 抛 ERR_INVALID_STATE 并走 onError。
    resolveNext?.({ value: { data: { v: 1 } }, done: false })
    await new Promise((r) => setTimeout(r, 0)) // 让 pull 后续逻辑跑完

    const result = await readPromise
    expect(result.done).toBe(true)
    expect(errors).toHaveLength(0)
  })

  it('上游迭代器抛错时走 onError', async () => {
    async function* gen(): AsyncIterable<SSEOutput<unknown>> {
      yield { data: { v: 1 } }
      throw new Error('upstream boom')
    }
    const errors: unknown[] = []
    const stream = readableStreamFromAsyncIterable(gen(), (e) => errors.push(e))
    const reader = stream.getReader()
    await reader.read() // 第一个 chunk
    // 触发下一次 pull，上游 throw → onError + controller.error（reader.read reject）
    await reader.read().catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('upstream boom')
  })
})
