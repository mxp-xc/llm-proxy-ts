import type { Settings } from '../index.js'
import type { ResolvedPlugin, ProxyPlugin, PluginResponse } from '../index.js'

export async function inspectFirstStreamChunk(plugins: ResolvedPlugin[], stream: AsyncIterable<unknown>) {
  const inspectors = plugins.filter(
    (rp) => typeof (rp.plugin as ProxyPlugin).inspectStreamChunk === 'function',
  )

  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) {
    return { stream: replayStream(undefined, iterator, plugins) }
  }

  if (inspectors.length > 0) {
    for (const rp of inspectors) {
      const result = await (rp.plugin as ProxyPlugin).inspectStreamChunk!({
        requestId: '',
        settings: {} as Settings,
        provider: { id: '', provider: {} as any },
        config: rp.config,
        chunk: first.value,
      })
      if (result && typeof result === 'object' && 'status' in result) {
        return {
          error: result as PluginResponse,
          stream: replayStream(undefined, iterator, plugins),
        }
      }
    }
  }

  return { stream: replayStream(first.value, iterator, plugins) }
}

async function* replayStream(
  first: unknown,
  iterator: AsyncIterator<unknown>,
  plugins: ResolvedPlugin[] = [],
): AsyncIterable<unknown> {
  if (first !== undefined) {
    yield first
  }
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      return
    }
    const error = await inspectStreamChunk(plugins, next.value)
    if (error) {
      yield { type: 'openai-error', body: error.body }
      await iterator.return?.()
      return
    }
    yield next.value
  }
}

async function inspectStreamChunk(
  plugins: ResolvedPlugin[],
  chunk: unknown,
): Promise<PluginResponse | undefined> {
  for (const rp of plugins) {
    if (typeof (rp.plugin as ProxyPlugin).inspectStreamChunk !== 'function') continue
    const result = await (rp.plugin as ProxyPlugin).inspectStreamChunk!({
      requestId: '',
      settings: {} as Settings,
      provider: { id: '', provider: {} as any },
      config: rp.config,
      chunk,
    })
    if (result && typeof result === 'object' && 'status' in result) {
      return result as PluginResponse
    }
  }
  return undefined
}
