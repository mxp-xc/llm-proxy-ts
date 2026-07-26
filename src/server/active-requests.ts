export interface ActiveRequestRegistry {
  register(controller: AbortController): () => void
  abortAll(reason: unknown): void
  drain(): Promise<void>
  size(): number
}

export function createActiveRequestRegistry(): ActiveRequestRegistry {
  const controllers = new Set<AbortController>()
  const drainWaiters = new Set<() => void>()
  const resolveDrain = (): void => {
    if (controllers.size !== 0) return
    for (const resolve of drainWaiters) resolve()
    drainWaiters.clear()
  }
  return {
    register(controller) {
      controllers.add(controller)
      return () => {
        controllers.delete(controller)
        resolveDrain()
      }
    },
    abortAll(reason) {
      for (const controller of controllers) {
        if (!controller.signal.aborted) controller.abort(reason)
      }
    },
    drain() {
      if (controllers.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => drainWaiters.add(resolve))
    },
    size: () => controllers.size,
  }
}
