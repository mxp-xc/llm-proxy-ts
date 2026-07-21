import type { Settings, ProviderConfig } from '../config.js'
import {
  PluginHookError,
  type ResolvedPlugin,
  type ProxyPlugin,
  type PluginResponse,
  type Plugin,
} from '../plugins/types.js'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import type { RequestTelemetryContext } from './types.js'

/** inspectFirstStreamChunk 需要的插件上下文切片 */
export interface StreamInspectContext {
  requestId: string
  settings: Settings
  provider: { id: string; provider: ProviderConfig }
  firstChunkStartedAt?: number
  telemetry?: RequestTelemetryContext
  abortSignal?: AbortSignal
  onCleanupError?: (error: unknown) => void
}

interface IteratorCleanup {
  close(): Promise<void>
  detach(): void
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

function buildPluginContext(rp: ResolvedPlugin, ctx: StreamInspectContext, chunk: ProxyStreamPart) {
  return {
    requestId: ctx.requestId,
    settings: ctx.settings,
    provider: ctx.provider,
    config: rp.config,
    chunk,
  }
}

function wrapPluginHookError(plugin: string, provider: string, cause: unknown): PluginHookError {
  return cause instanceof PluginHookError
    ? cause
    : new PluginHookError(plugin, provider, 'inspectStreamChunk', cause)
}

function createIteratorCleanup(
  iterator: AsyncIterator<ProxyStreamPart>,
  ctx: StreamInspectContext,
): IteratorCleanup {
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= Promise.resolve(iterator.return?.()).then(
      () => undefined,
      (error) => {
        ctx.onCleanupError?.(error)
      },
    )
    return closePromise
  }
  const onAbort = (): void => {
    void close()
  }
  ctx.abortSignal?.addEventListener('abort', onAbort, { once: true })
  if (ctx.abortSignal?.aborted) onAbort()

  return {
    close,
    detach() {
      ctx.abortSignal?.removeEventListener('abort', onAbort)
    },
  }
}

export async function inspectFirstStreamChunk(
  plugins: ResolvedPlugin[],
  stream: AsyncIterable<ProxyStreamPart>,
  ctx: StreamInspectContext,
) {
  const inspectors = plugins.filter((rp) => isProxyPluginWithInspect(rp.plugin))

  const iterator = stream[Symbol.asyncIterator]()
  const cleanup = createIteratorCleanup(iterator, ctx)
  try {
    const first = await iterator.next()
    if (first.done) {
      return { stream: replayStream(undefined, iterator, plugins, ctx, cleanup) }
    }
    const telemetry = ctx.telemetry
    if (
      ctx.firstChunkStartedAt !== undefined &&
      telemetry !== undefined &&
      telemetry.firstChunkMs === undefined
    ) {
      telemetry.firstChunkMs = Math.round(performance.now() - ctx.firstChunkStartedAt)
    }

    if (inspectors.length > 0) {
      for (const rp of inspectors) {
        const plugin = rp.plugin as ProxyPlugin
        let result: PluginResponse | void
        try {
          result = await plugin.inspectStreamChunk!(buildPluginContext(rp, ctx, first.value))
        } catch (cause) {
          throw wrapPluginHookError(rp.plugin.name, ctx.provider.id, cause)
        }
        if (isPluginResponse(result)) {
          await cleanup.close()
          cleanup.detach()
          return {
            error: result,
          }
        }
      }
    }

    return { stream: replayStream(first.value, iterator, plugins, ctx, cleanup) }
  } catch (error) {
    await cleanup.close()
    cleanup.detach()
    throw error
  }
}

async function* replayStream(
  first: ProxyStreamPart | undefined,
  iterator: AsyncIterator<ProxyStreamPart>,
  plugins: ResolvedPlugin[] = [],
  ctx: StreamInspectContext,
  cleanup: IteratorCleanup = createIteratorCleanup(iterator, ctx),
): AsyncIterable<ProxyStreamPart> {
  try {
    if (first !== undefined) {
      yield first
    }
    while (true) {
      const next = await iterator.next()
      if (next.done) {
        return
      }
      const error = await inspectStreamChunk(plugins, next.value, ctx)
      if (error) {
        yield { type: 'openai-error', body: error.body, status: error.status }
        return
      }
      yield next.value
    }
  } finally {
    cleanup.detach()
    await cleanup.close()
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
    let result: PluginResponse | void
    try {
      result = await plugin.inspectStreamChunk!(buildPluginContext(rp, ctx, chunk))
    } catch (cause) {
      throw wrapPluginHookError(rp.plugin.name, ctx.provider.id, cause)
    }
    if (isPluginResponse(result)) {
      return result
    }
  }
  return undefined
}
