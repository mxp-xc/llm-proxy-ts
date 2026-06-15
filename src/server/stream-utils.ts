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

export function readableStreamFromAsyncIterable(
  iterable: AsyncIterable<Uint8Array>,
  onError: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) {
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        onError(error)
        controller.error(error)
      }
    },
  })
}
