export class RequestTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`)
    this.name = 'RequestTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

const ITERATOR_CLEANUP_BUDGET_MS = 1_000

export class IteratorCleanupTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Iterator cleanup timed out after ${timeoutMs}ms`)
    this.name = 'IteratorCleanupTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class RequestTimeout {
  private readonly timeoutPromise: Promise<never>
  private timeout: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly timeoutMs: number,
    private readonly abortController: AbortController,
  ) {
    this.timeoutPromise = new Promise<never>((_, reject) => {
      this.timeout = setTimeout(() => {
        const timeoutError = new RequestTimeoutError(timeoutMs)
        // Queue the timeout rejection first so a synchronous abort listener cannot win the race.
        reject(timeoutError)
        abortController.abort(timeoutError)
      }, timeoutMs)
    })
    void this.timeoutPromise.catch(() => undefined)
  }

  run<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.timeoutPromise])
  }

  wrap<T>(
    iterable: AsyncIterable<T>,
    onDetachedError?: (error: unknown, phase: 'cleanup' | 'pull') => unknown,
  ): AsyncIterable<T> {
    const requestTimeout = this
    return {
      [Symbol.asyncIterator]() {
        const iterator = iterable[Symbol.asyncIterator]()
        const signal = requestTimeout.abortController.signal
        let cleanupPromise: Promise<IteratorResult<T> | undefined> | undefined
        let boundedCleanupPromise: Promise<IteratorResult<T>> | undefined
        let cleanupFailureClaimedByCaller = false
        let cleanupFailureReported = false
        let nextFailed = false
        let naturallyDone = false
        let detached = false
        let resolveCancellation: (result: IteratorResult<T>) => void = () => undefined
        const cancellationPromise = new Promise<IteratorResult<T>>((resolve) => {
          resolveCancellation = resolve
        })

        const detach = () => {
          if (detached) return
          detached = true
          signal.removeEventListener('abort', onAbort)
        }

        const startCleanup = (value?: unknown) => {
          if (cleanupPromise === undefined) {
            try {
              cleanupPromise = Promise.resolve(iterator.return?.(value))
            } catch (error) {
              cleanupPromise = Promise.reject(error)
            }
          }
          return cleanupPromise
        }

        const reportDetachedError = (error: unknown, phase: 'cleanup' | 'pull') => {
          try {
            void Promise.resolve(onDetachedError?.(error, phase)).catch((reportError: unknown) => {
              console.error('Failed to report detached iterator error', reportError)
            })
          } catch (reportError) {
            console.error('Failed to report detached iterator error', reportError)
          }
        }

        const reportDetachedPullError = (error: unknown) => {
          const record =
            typeof error === 'object' && error !== null
              ? (error as { name?: unknown; code?: unknown })
              : undefined
          const isExpectedAbort =
            signal.aborted &&
            (error === signal.reason ||
              record?.name === 'AbortError' ||
              record?.code === 'ABORT_ERR')
          if (!isExpectedAbort) reportDetachedError(error, 'pull')
        }

        const boundedCleanup = (value?: unknown): Promise<IteratorResult<T>> => {
          boundedCleanupPromise ??= (async () => {
            let budgetTimeout: ReturnType<typeof setTimeout> | undefined
            const cleanupOutcome = startCleanup(value).then(
              (result) => ({ type: 'completed' as const, result }),
              (error: unknown) => ({ type: 'failed' as const, error }),
            )
            const deadlineOutcome = requestTimeout.timeoutPromise.then(
              () => ({ type: 'deadline' as const }),
              () => ({ type: 'deadline' as const }),
            )
            const budgetOutcome = new Promise<{ type: 'budget' }>((resolve) => {
              budgetTimeout = setTimeout(
                () => resolve({ type: 'budget' }),
                ITERATOR_CLEANUP_BUDGET_MS,
              )
            })

            try {
              const outcome = await Promise.race([cleanupOutcome, deadlineOutcome, budgetOutcome])
              if (outcome.type === 'failed') {
                if (!cleanupFailureClaimedByCaller) {
                  cleanupFailureReported = true
                  reportDetachedError(outcome.error, 'cleanup')
                }
                throw outcome.error
              }
              if (outcome.type === 'completed') {
                return outcome.result ?? { done: true, value: undefined }
              }
              void startCleanup(value).catch((error: unknown) =>
                reportDetachedError(error, 'cleanup'),
              )
              if (outcome.type === 'budget') {
                const timeoutError = new IteratorCleanupTimeoutError(ITERATOR_CLEANUP_BUDGET_MS)
                reportDetachedError(timeoutError, 'cleanup')
                if (!signal.aborted) requestTimeout.abortController.abort(timeoutError)
              } else if (!signal.aborted) {
                requestTimeout.abortController.abort(
                  new RequestTimeoutError(requestTimeout.timeoutMs),
                )
              }
              return { done: true, value: undefined }
            } finally {
              if (budgetTimeout !== undefined) clearTimeout(budgetTimeout)
              detach()
              requestTimeout.clear()
            }
          })()
          void boundedCleanupPromise.catch(() => undefined)
          return boundedCleanupPromise
        }

        function onAbort() {
          void boundedCleanup().catch(() => undefined)
          if (signal.reason instanceof RequestTimeoutError) return

          // Let abort-aware upstream pulls settle first so their real outcome wins the race.
          setTimeout(() => resolveCancellation({ done: true, value: undefined }), 0)
        }

        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()

        return {
          async next() {
            const pullOutcome = Promise.resolve()
              .then(() => iterator.next())
              .then(
                (result) => ({ type: 'pull' as const, result }),
                (error: unknown) => ({ type: 'pull_error' as const, error }),
              )
            const cancellationOutcome = cancellationPromise.then((result) => ({
              type: 'cancel' as const,
              result,
            }))
            let outcome: Awaited<typeof pullOutcome> | Awaited<typeof cancellationOutcome>
            try {
              outcome = await Promise.race([
                pullOutcome,
                requestTimeout.timeoutPromise,
                cancellationOutcome,
              ])
            } catch (error) {
              nextFailed = true
              void pullOutcome.then((lateOutcome) => {
                if (lateOutcome.type === 'pull_error') {
                  reportDetachedPullError(lateOutcome.error)
                }
              })
              void boundedCleanup().catch(() => undefined)
              throw error
            }

            if (outcome.type === 'cancel') {
              void pullOutcome.then((lateOutcome) => {
                if (lateOutcome.type === 'pull_error') {
                  reportDetachedPullError(lateOutcome.error)
                }
              })
              return outcome.result
            }
            if (outcome.type === 'pull_error') {
              nextFailed = true
              void boundedCleanup().catch(() => undefined)
              throw outcome.error
            }

            const next = outcome.result
            if (next.done) {
              naturallyDone = !signal.aborted
              if (naturallyDone) {
                detach()
                requestTimeout.clear()
              }
            }
            return next
          },
          async return(value?: unknown) {
            if (naturallyDone) return { done: true, value: undefined }
            if (nextFailed || cleanupFailureReported) {
              void boundedCleanup(value).catch(() => undefined)
              return { done: true, value: undefined }
            }
            cleanupFailureClaimedByCaller = true
            return boundedCleanup(value)
          },
        }
      },
    }
  }

  clear(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout)
      this.timeout = undefined
    }
  }
}

export async function withRequestTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<T> {
  const requestTimeout = new RequestTimeout(timeoutMs, abortController)

  try {
    return await requestTimeout.run(promise)
  } finally {
    requestTimeout.clear()
  }
}
