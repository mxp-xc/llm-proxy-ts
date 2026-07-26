import { describe, expect, it, vi } from 'vitest'
import { createActiveRequestRegistry } from '../../src/server/active-requests.js'

describe('active request registry', () => {
  it('aborts registered requests and ignores unregistered requests', () => {
    const registry = createActiveRequestRegistry()
    const active = new AbortController()
    const completed = new AbortController()
    const activeAbort = vi.fn()
    active.signal.addEventListener('abort', activeAbort)
    const unregister = registry.register(completed)
    unregister()
    registry.register(active)

    registry.abortAll('shutdown')

    expect(active.signal.aborted).toBe(true)
    expect(active.signal.reason).toBe('shutdown')
    expect(activeAbort).toHaveBeenCalledOnce()
    expect(completed.signal.aborted).toBe(false)
    expect(registry.size()).toBe(1)
  })

  it('resolves drain after the last request unregisters', async () => {
    const registry = createActiveRequestRegistry()
    const unregisterFirst = registry.register(new AbortController())
    const unregisterSecond = registry.register(new AbortController())
    let drained = false
    const drain = registry.drain().then(() => {
      drained = true
    })

    unregisterFirst()
    await Promise.resolve()
    expect(drained).toBe(false)

    unregisterSecond()
    await drain
    expect(drained).toBe(true)
  })
})
