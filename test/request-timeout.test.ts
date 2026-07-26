import { describe, expect, it, vi } from 'vitest'
import {
  IteratorCleanupTimeoutError,
  RequestTimeout,
  RequestTimeoutError,
  withRequestTimeout,
} from '../src/request-timeout.js'

describe('withRequestTimeout', () => {
  it('preserves the timeout error when an abort listener rejects upstream immediately', async () => {
    const abortController = new AbortController()
    const upstream = new Promise<never>((_resolve, reject) => {
      abortController.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' }))
      })
    })

    await expect(withRequestTimeout(upstream, 1, abortController)).rejects.toMatchObject({
      name: 'RequestTimeoutError',
      timeoutMs: 1,
    })
    expect(abortController.signal.reason).toBeInstanceOf(RequestTimeoutError)
  })

  it('uses one deadline across multiple operations', async () => {
    vi.useFakeTimers()
    try {
      const abortController = new AbortController()
      const requestTimeout = new RequestTimeout(10, abortController)

      await vi.advanceTimersByTimeAsync(6)
      await expect(requestTimeout.run(Promise.resolve('first'))).resolves.toBe('first')
      const stalled = requestTimeout.run(new Promise<never>(() => undefined))
      const rejection = expect(stalled).rejects.toMatchObject({
        name: 'RequestTimeoutError',
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(4)

      await rejection
      expect(abortController.signal.reason).toBeInstanceOf(RequestTimeoutError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the deadline when a wrapped iterable finishes', async () => {
    vi.useFakeTimers()
    try {
      const abortController = new AbortController()
      const requestTimeout = new RequestTimeout(10, abortController)
      const values: string[] = []

      for await (const value of requestTimeout.wrap(
        (async function* () {
          yield 'done'
        })(),
      )) {
        values.push(value)
      }
      await vi.advanceTimersByTimeAsync(10)

      expect(values).toEqual(['done'])
      expect(abortController.signal.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not abort when consumer cleanup finishes within the cleanup budget', async () => {
    vi.useFakeTimers()
    try {
      const abortController = new AbortController()
      const requestTimeout = new RequestTimeout(10_000, abortController)
      const upstreamReturn = vi.fn(() =>
        Promise.resolve<IteratorResult<string>>({ done: true, value: undefined }),
      )
      const iterator = requestTimeout
        .wrap<string>({
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.resolve({ done: false, value: 'first' }),
              return: upstreamReturn,
            }
          },
        })
        [Symbol.asyncIterator]()

      await expect(iterator.next()).resolves.toEqual({ done: false, value: 'first' })
      await expect(iterator.return!()).resolves.toMatchObject({ done: true })
      await vi.advanceTimersByTimeAsync(10_000)

      expect(upstreamReturn).toHaveBeenCalledTimes(1)
      expect(abortController.signal.aborted).toBe(false)

      const controllerWithoutReturn = new AbortController()
      const iteratorWithoutReturn = new RequestTimeout(10_000, controllerWithoutReturn)
        .wrap<string>({
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.resolve({ done: false, value: 'first' }),
            }
          },
        })
        [Symbol.asyncIterator]()
      await iteratorWithoutReturn.next()
      await expect(iteratorWithoutReturn.return!()).resolves.toMatchObject({ done: true })
      expect(controllerWithoutReturn.signal.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    {
      behavior: 'throws synchronously',
      cleanup: (error: Error) => {
        throw error
      },
    },
    {
      behavior: 'rejects within the cleanup budget',
      cleanup: (error: Error) => Promise.reject(error),
    },
  ])('propagates cleanup that $behavior without reporting it', async ({ cleanup }) => {
    const cleanupError = new Error('cleanup failed')
    const onCleanupError = vi.fn()
    const requestTimeout = new RequestTimeout(10_000, new AbortController())
    const iterator = requestTimeout
      .wrap<string>(
        {
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.resolve({ done: false, value: 'first' }),
              return: () => cleanup(cleanupError),
            }
          },
        },
        onCleanupError,
      )
      [Symbol.asyncIterator]()

    try {
      await iterator.next()
      await expect(iterator.return!()).rejects.toBe(cleanupError)
      expect(onCleanupError).not.toHaveBeenCalled()
    } finally {
      requestTimeout.clear()
    }
  })

  it('aborts upstream when consumer cleanup exceeds the cleanup budget', async () => {
    vi.useFakeTimers()
    try {
      const abortController = new AbortController()
      const requestTimeout = new RequestTimeout(10_000, abortController)
      const onCleanupError = vi.fn()
      const iterator = requestTimeout
        .wrap<string>(
          {
            [Symbol.asyncIterator]() {
              return {
                next: () => Promise.resolve({ done: false, value: 'first' }),
                return: () => new Promise<IteratorResult<string>>(() => undefined),
              }
            },
          },
          onCleanupError,
        )
        [Symbol.asyncIterator]()

      await iterator.next()
      const returned = iterator.return!()
      expect(abortController.signal.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(1_000)

      await expect(returned).resolves.toMatchObject({ done: true })
      expect(abortController.signal.aborted).toBe(true)
      expect(abortController.signal.reason).toBeInstanceOf(IteratorCleanupTimeoutError)
      expect(abortController.signal.reason).toMatchObject({ timeoutMs: 1_000 })
      expect(onCleanupError).toHaveBeenCalledTimes(1)
      expect(onCleanupError).toHaveBeenCalledWith(abortController.signal.reason, 'cleanup')

      await vi.advanceTimersByTimeAsync(10_000)
      expect(onCleanupError).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts with the request timeout reason when its deadline bounds cleanup', async () => {
    vi.useFakeTimers()
    try {
      const abortController = new AbortController()
      const requestTimeout = new RequestTimeout(10, abortController)
      const onCleanupError = vi.fn()
      const iterator = requestTimeout
        .wrap<string>(
          {
            [Symbol.asyncIterator]() {
              return {
                next: () => Promise.resolve({ done: false, value: 'first' }),
                return: () => new Promise<IteratorResult<string>>(() => undefined),
              }
            },
          },
          onCleanupError,
        )
        [Symbol.asyncIterator]()

      await iterator.next()
      const returned = iterator.return!()
      await vi.advanceTimersByTimeAsync(10)

      await expect(returned).resolves.toMatchObject({ done: true })
      expect(abortController.signal.reason).toBeInstanceOf(RequestTimeoutError)
      expect(onCleanupError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a stalled next without waiting for iterator cleanup', async () => {
    vi.useFakeTimers()
    try {
      const abortController = new AbortController()
      const requestTimeout = new RequestTimeout(10, abortController)
      const stream: AsyncIterable<string> = {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<string>>(() => undefined),
            return: () => new Promise<IteratorResult<string>>(() => undefined),
          }
        },
      }
      const next = requestTimeout.wrap(stream)[Symbol.asyncIterator]().next()
      const rejection = expect(next).rejects.toMatchObject({
        name: 'RequestTimeoutError',
        timeoutMs: 10,
      })

      await vi.advanceTimersByTimeAsync(10)

      await rejection
      expect(abortController.signal.reason).toBeInstanceOf(RequestTimeoutError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates a timeout through forwarding cleanup when iterator.return hangs', async () => {
    vi.useFakeTimers()
    try {
      const abortController = new AbortController()
      const requestTimeout = new RequestTimeout(10, abortController)
      const wrapped = requestTimeout.wrap<string>({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<string>>(() => undefined),
            return: () => new Promise<IteratorResult<string>>(() => undefined),
          }
        },
      })
      const forwarded = (async function* () {
        const iterator = wrapped[Symbol.asyncIterator]()
        try {
          const next = await iterator.next()
          if (!next.done) yield next.value
        } finally {
          await iterator.return?.()
        }
      })()
      const outcome = Promise.race([
        forwarded.next().then(
          () => ({ state: 'resolved' as const }),
          (error: unknown) => ({ state: 'rejected' as const, error }),
        ),
        new Promise<{ state: 'pending' }>((resolve) => {
          setTimeout(() => resolve({ state: 'pending' }), 20)
        }),
      ])

      await vi.advanceTimersByTimeAsync(20)

      expect(await outcome).toMatchObject({
        state: 'rejected',
        error: { name: 'RequestTimeoutError', timeoutMs: 10 },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves an iterator error when iterator.return hangs', async () => {
    vi.useFakeTimers()
    try {
      const upstreamError = new Error('upstream failed')
      const abortController = new AbortController()
      const requestTimeout = new RequestTimeout(10_000, abortController)
      const wrapped = requestTimeout.wrap<string>({
        [Symbol.asyncIterator]() {
          return {
            next: () => Promise.reject(upstreamError),
            return: () => new Promise<IteratorResult<string>>(() => undefined),
          }
        },
      })
      const forwarded = (async function* () {
        const iterator = wrapped[Symbol.asyncIterator]()
        try {
          const next = await iterator.next()
          if (!next.done) yield next.value
        } finally {
          await iterator.return?.()
        }
      })()

      await expect(forwarded.next()).rejects.toBe(upstreamError)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(abortController.signal.reason).toBeInstanceOf(IteratorCleanupTimeoutError)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    {
      behavior: 'throws synchronously',
      cleanup: (error: Error) => {
        throw error
      },
    },
    {
      behavior: 'rejects within the cleanup budget',
      cleanup: (error: Error) => Promise.reject(error),
    },
  ])('reports cleanup that $behavior after iterator.next fails', async ({ cleanup }) => {
    const nextError = new Error('upstream next failed')
    const cleanupError = new Error('cleanup after next failed')
    const onCleanupError = vi.fn()
    const requestTimeout = new RequestTimeout(10_000, new AbortController())
    const iterator = requestTimeout
      .wrap<string>(
        {
          [Symbol.asyncIterator]() {
            return {
              next: () => Promise.reject(nextError),
              return: () => cleanup(cleanupError),
            }
          },
        },
        onCleanupError,
      )
      [Symbol.asyncIterator]()

    try {
      await expect(iterator.next()).rejects.toBe(nextError)
      await vi.waitFor(() => expect(onCleanupError).toHaveBeenCalledTimes(1))
      expect(onCleanupError).toHaveBeenCalledWith(cleanupError, 'cleanup')
      await expect(iterator.return!()).resolves.toMatchObject({ done: true })
      expect(onCleanupError).toHaveBeenCalledTimes(1)
    } finally {
      requestTimeout.clear()
    }
  })

  it('reports bounded and late cleanup failures after external cancellation', async () => {
    vi.useFakeTimers()
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const abortController = new AbortController()
      const requestTimeout = new RequestTimeout(10_000, abortController)
      const callbackError = new Error('cleanup error callback failed')
      const onCleanupError = vi.fn((_error: unknown, _phase: 'cleanup' | 'pull') => {
        throw callbackError
      })
      let rejectCleanup: ((error: unknown) => void) | undefined
      const cleanupError = new Error('late cleanup rejection')
      const iterator = requestTimeout
        .wrap<string>(
          {
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise<IteratorResult<string>>(() => undefined),
                return: () =>
                  new Promise<IteratorResult<string>>((_resolve, reject) => {
                    rejectCleanup = reject
                  }),
              }
            },
          },
          onCleanupError,
        )
        [Symbol.asyncIterator]()
      const next = iterator.next()
      const cancellationReason = new Error('client disconnected')

      abortController.abort(cancellationReason)
      const returned = iterator.return?.()
      const outcome = Promise.race([
        returned!.then(() => 'returned'),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 1_000)),
      ])
      await vi.advanceTimersByTimeAsync(1_000)

      await expect(next).resolves.toMatchObject({ done: true })
      await expect(outcome).resolves.toBe('returned')
      expect(abortController.signal.reason).toBe(cancellationReason)
      expect(onCleanupError).toHaveBeenCalledTimes(1)
      expect(onCleanupError.mock.calls[0]?.[0]).toBeInstanceOf(IteratorCleanupTimeoutError)
      expect(onCleanupError.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 1_000 })
      expect(onCleanupError.mock.calls[0]?.[1]).toBe('cleanup')

      rejectCleanup?.(cleanupError)
      await vi.runAllTimersAsync()
      expect(onCleanupError).toHaveBeenCalledTimes(2)
      expect(onCleanupError.mock.calls[1]?.[0]).toBe(cleanupError)
      expect(onCleanupError.mock.calls[1]?.[1]).toBe('cleanup')
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
      vi.useRealTimers()
    }
  })

  it('reports a non-abort pull rejection that arrives after external cancellation', async () => {
    const abortController = new AbortController()
    const pullError = new Error('upstream failed after cancellation')
    const onDetachedError = vi.fn()
    let rejectPull: ((error: unknown) => void) | undefined
    const iterator = new RequestTimeout(10_000, abortController)
      .wrap<string>(
        {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<string>>((_resolve, reject) => {
                  rejectPull = reject
                }),
              return: () => Promise.resolve({ done: true, value: undefined }),
            }
          },
        },
        onDetachedError,
      )
      [Symbol.asyncIterator]()
    const next = iterator.next()

    abortController.abort(new Error('client disconnected'))
    await expect(next).resolves.toMatchObject({ done: true })
    rejectPull?.(pullError)
    await vi.waitFor(() => expect(onDetachedError).toHaveBeenCalledTimes(1))

    expect(onDetachedError).toHaveBeenCalledWith(pullError, 'pull')
  })

  it('does not report an expected AbortError after external cancellation', async () => {
    const abortController = new AbortController()
    const onDetachedError = vi.fn()
    let rejectPull: ((error: unknown) => void) | undefined
    const iterator = new RequestTimeout(10_000, abortController)
      .wrap<string>(
        {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<string>>((_resolve, reject) => {
                  rejectPull = reject
                }),
              return: () => Promise.resolve({ done: true, value: undefined }),
            }
          },
        },
        onDetachedError,
      )
      [Symbol.asyncIterator]()
    const next = iterator.next()

    abortController.abort(new Error('client disconnected'))
    await expect(next).resolves.toMatchObject({ done: true })
    rejectPull?.(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(onDetachedError).not.toHaveBeenCalled()
  })
})
