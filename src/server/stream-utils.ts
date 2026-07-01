import { formatSSE, type SSEOutput } from '../providers/shared/sse-utils.js'

const textEncoder = new TextEncoder()

export class RequestTimeoutError extends Error {
  constructor() {
    super('Request timed out')
  }
}

export async function withRequestTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      abortController.abort()
      reject(new RequestTimeoutError())
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export function readableStreamFromAsyncIterable<T>(
  iterable: AsyncIterable<SSEOutput<T>>,
  onError: (error: unknown) => void,
  abortController?: AbortController,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]()
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return
      try {
        const next = await iterator.next()
        // await 期间下游可能已 cancel（客户端断开）：跳过 enqueue，
        // 否则往已关闭的 controller enqueue 会抛 ERR_INVALID_STATE。
        if (cancelled || controller.desiredSize === null) return
        if (next.done) {
          controller.close()
        } else {
          controller.enqueue(textEncoder.encode(formatSSE(next.value)))
        }
      } catch (error) {
        if (cancelled) return
        onError(error)
        controller.error(error)
      }
    },
    async cancel(reason) {
      cancelled = true
      // 立即中断上游 fetch：释放 socket、停止上游计费。
      if (abortController && !abortController.signal.aborted) {
        abortController.abort(reason)
      }
      // 取消迭代器链，触发上游 async generator 的 finally 清理。
      try {
        await iterator.return?.(reason)
      } catch {
        // cancel 期间上游清理抛错忽略，不再走 onError。
      }
    },
  })
}
