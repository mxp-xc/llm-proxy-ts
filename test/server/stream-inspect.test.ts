import { describe, expect, it, vi } from 'vitest'
import { PluginHookError, type ProxyPlugin, type ResolvedPlugin } from '../../src/plugins/types.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import {
  inspectFirstStreamChunk,
  type StreamInspectContext,
} from '../../src/server/stream-inspect.js'
import { makeSettings } from '../helpers/settings.js'

const firstChunk: ProxyStreamPart = { type: 'text-delta', id: 'txt-1', text: 'first' }
const secondChunk: ProxyStreamPart = { type: 'text-delta', id: 'txt-1', text: 'second' }

function makeContext(overrides: Partial<StreamInspectContext> = {}): StreamInspectContext {
  const settings = makeSettings({
    p1: {
      type: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      apiKey: 'test',
      headers: {},
      plugins: [],
      models: {},
    },
  })
  const provider = settings.providers.p1
  if (!provider) throw new Error('test provider is missing')

  return {
    requestId: 'req-1',
    settings,
    provider: { id: 'p1', provider },
    ...overrides,
  }
}

function makeInspector(
  inspectStreamChunk: NonNullable<ProxyPlugin['inspectStreamChunk']>,
): ResolvedPlugin {
  const plugin: ProxyPlugin = { name: 'test-inspector', inspectStreamChunk }
  return {
    plugin,
    config: {},
    providers: ['p1'],
  }
}

describe('inspectFirstStreamChunk iterator cleanup', () => {
  it('runs the underlying generator finally when the replay consumer cancels', async () => {
    let finalized = false
    async function* source(): AsyncIterable<ProxyStreamPart> {
      try {
        yield firstChunk
        yield secondChunk
      } finally {
        finalized = true
      }
    }

    const result = await inspectFirstStreamChunk([], source(), makeContext())
    expect(result.stream).toBeDefined()

    const replayIterator = result.stream![Symbol.asyncIterator]()
    await expect(replayIterator.next()).resolves.toEqual({ done: false, value: firstChunk })
    await replayIterator.return?.()

    expect(finalized).toBe(true)
  })

  it('returns the underlying iterator and runs its finally when aborted', async () => {
    let finalized = false
    async function* source(): AsyncGenerator<ProxyStreamPart> {
      try {
        yield firstChunk
        yield secondChunk
      } finally {
        finalized = true
      }
    }
    const iterator = source()
    const returnSpy = vi.spyOn(iterator, 'return')
    const stream: AsyncIterable<ProxyStreamPart> = {
      [Symbol.asyncIterator]: () => iterator,
    }
    const abortController = new AbortController()

    const result = await inspectFirstStreamChunk(
      [],
      stream,
      makeContext({ abortSignal: abortController.signal }),
    )
    expect(result.stream).toBeDefined()

    abortController.abort()

    await vi.waitFor(() => expect(finalized).toBe(true))
    expect(returnSpy).toHaveBeenCalledTimes(1)
  })

  it('preserves an existing PluginHookError instead of wrapping it again', async () => {
    async function* source(): AsyncIterable<ProxyStreamPart> {
      yield firstChunk
    }
    const cause = new Error('original plugin failure')
    const pluginError = new PluginHookError('origin-plugin', 'p1', 'inspectStreamChunk', cause)
    const plugin = makeInspector(async () => {
      throw pluginError
    })

    await expect(inspectFirstStreamChunk([plugin], source(), makeContext())).rejects.toBe(
      pluginError,
    )
    expect(pluginError.cause).toBe(cause)
  })

  it('passes the complete iterator cleanup error to onCleanupError', async () => {
    const rootCause = new Error('socket close failed')
    const cleanupError = Object.assign(new Error('iterator cleanup failed', { cause: rootCause }), {
      code: 'EITERATORCLOSE',
    })
    const onCleanupError = vi.fn()
    const iterator: AsyncIterator<ProxyStreamPart> = {
      next: vi.fn().mockResolvedValue({ done: false, value: firstChunk }),
      return: vi.fn().mockRejectedValue(cleanupError),
    }
    const stream: AsyncIterable<ProxyStreamPart> = {
      [Symbol.asyncIterator]: () => iterator,
    }

    const result = await inspectFirstStreamChunk([], stream, makeContext({ onCleanupError }))
    expect(result.stream).toBeDefined()

    const replayIterator = result.stream![Symbol.asyncIterator]()
    await replayIterator.next()
    await replayIterator.return?.()

    expect(iterator.return).toHaveBeenCalledTimes(1)
    expect(onCleanupError).toHaveBeenCalledTimes(1)
    expect(onCleanupError).toHaveBeenCalledWith(cleanupError)
    const [reportedError] = onCleanupError.mock.calls[0]!
    expect(reportedError).toBe(cleanupError)
    expect((reportedError as Error).cause).toBe(rootCause)
    expect((reportedError as typeof cleanupError).code).toBe('EITERATORCLOSE')
    expect((reportedError as Error).stack).toBe(cleanupError.stack)
  })
})
