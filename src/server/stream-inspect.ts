import type { Settings, ProviderConfig } from '../index.js'
import type { ResolvedPlugin, ProxyPlugin, PluginResponse, Plugin } from '../index.js'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'

function isProxyPluginWithInspect(plugin: Plugin): plugin is ProxyPlugin {
  return typeof (plugin as ProxyPlugin).inspectStreamChunk === 'function'
}

function isPluginResponse(value: unknown): value is PluginResponse {
  return value !== null && typeof value === 'object' && 'status' in value
    && typeof (value as PluginResponse).status === 'number'
}

export async function inspectFirstStreamChunk(plugins: ResolvedPlugin[], stream: AsyncIterable<ProxyStreamPart>) {
  const inspectors = plugins.filter((rp) => isProxyPluginWithInspect(rp.plugin))

  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) {
    return { stream: replayStream(undefined, iterator, plugins) }
  }

  if (inspectors.length > 0) {
    for (const rp of inspectors) {
      const plugin = rp.plugin as ProxyPlugin
      const result = await plugin.inspectStreamChunk!({
        requestId: '',
        settings: {} as Settings,
        provider: { id: '', provider: {} as ProviderConfig },
        config: rp.config,
        chunk: first.value,
      })
      if (isPluginResponse(result)) {
        return {
          error: result,
          stream: replayStream(undefined, iterator, plugins),
        }
      }
    }
  }

  return { stream: replayStream(first.value, iterator, plugins) }
}

async function* replayStream(
  first: ProxyStreamPart | undefined,
  iterator: AsyncIterator<ProxyStreamPart>,
  plugins: ResolvedPlugin[] = [],
): AsyncIterable<ProxyStreamPart> {
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
  chunk: ProxyStreamPart,
): Promise<PluginResponse | undefined> {
  for (const rp of plugins) {
    if (!isProxyPluginWithInspect(rp.plugin)) continue
    const plugin = rp.plugin as ProxyPlugin
    const result = await plugin.inspectStreamChunk!({
      requestId: '',
      settings: {} as Settings,
      provider: { id: '', provider: {} as ProviderConfig },
      config: rp.config,
      chunk,
    })
    if (isPluginResponse(result)) {
      return result
    }
  }
  return undefined
}
