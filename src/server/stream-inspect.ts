import type { Settings, ProviderConfig } from '../config.js'
import type { ResolvedPlugin, ProxyPlugin, PluginResponse, Plugin } from '../plugins/types.js'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'

/** inspectFirstStreamChunk 需要的插件上下文切片 */
export interface StreamInspectContext {
  requestId: string
  settings: Settings
  provider: { id: string; provider: ProviderConfig }
}

function isProxyPluginWithInspect(plugin: Plugin): plugin is ProxyPlugin {
  return typeof (plugin as ProxyPlugin).inspectStreamChunk === 'function'
}

function isPluginResponse(value: unknown): value is PluginResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    'status' in value &&
    typeof (value as PluginResponse).status === 'number'
  )
}

export async function inspectFirstStreamChunk(
  plugins: ResolvedPlugin[],
  stream: AsyncIterable<ProxyStreamPart>,
  ctx: StreamInspectContext,
) {
  const inspectors = plugins.filter((rp) => isProxyPluginWithInspect(rp.plugin))

  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) {
    return { stream: replayStream(undefined, iterator, plugins, ctx) }
  }

  if (inspectors.length > 0) {
    try {
      for (const rp of inspectors) {
        const plugin = rp.plugin as ProxyPlugin
        const result = await plugin.inspectStreamChunk!({
          requestId: ctx.requestId,
          settings: ctx.settings,
          provider: ctx.provider,
          config: rp.config,
          chunk: first.value,
        })
        if (isPluginResponse(result)) {
          await iterator.return?.()
          return {
            error: result,
          }
        }
      }
    } catch (err) {
      await iterator.return?.()
      throw err
    }
  }

  return { stream: replayStream(first.value, iterator, plugins, ctx) }
}

async function* replayStream(
  first: ProxyStreamPart | undefined,
  iterator: AsyncIterator<ProxyStreamPart>,
  plugins: ResolvedPlugin[] = [],
  ctx: StreamInspectContext,
): AsyncIterable<ProxyStreamPart> {
  if (first !== undefined) {
    yield first
  }
  while (true) {
    const next = await iterator.next()
    if (next.done) {
      return
    }
    let error: PluginResponse | undefined
    try {
      error = await inspectStreamChunk(plugins, next.value, ctx)
    } catch (err) {
      await iterator.return?.()
      throw err
    }
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
  ctx: StreamInspectContext,
): Promise<PluginResponse | undefined> {
  for (const rp of plugins) {
    if (!isProxyPluginWithInspect(rp.plugin)) continue
    const plugin = rp.plugin as ProxyPlugin
    const result = await plugin.inspectStreamChunk!({
      requestId: ctx.requestId,
      settings: ctx.settings,
      provider: ctx.provider,
      config: rp.config,
      chunk,
    })
    if (isPluginResponse(result)) {
      return result
    }
  }
  return undefined
}
