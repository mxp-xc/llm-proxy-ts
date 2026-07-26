import type { ResolvedPlugin } from '../plugins/registry.js'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import { RequestTimeout } from '../request-timeout.js'
import { inspectFirstStreamChunk, type StreamInspectContext } from './stream-inspect.js'
import type { ModelGateway } from './types.js'

interface UpstreamStreamExecutionContext {
  timeoutMs: number
  abortController: AbortController
  onDetachedError: (error: unknown, phase: 'cleanup' | 'pull') => void
  plugins: ResolvedPlugin[]
  inspectContext: Omit<StreamInspectContext, 'abortSignal' | 'firstChunkStartedAt'>
}

type AcquiredUpstreamStream =
  | { stream: AsyncIterable<ProxyStreamPart>; upstreamStartedAt: number }
  | { inspectionResponse: { body: unknown; status: number } }

interface PreparedStreamResponse {
  stream: AsyncIterable<ProxyStreamPart>
  headers: Headers
}

export async function acquireUpstreamStream(
  gateway: Pick<ModelGateway, 'stream'>,
  input: Omit<Parameters<ModelGateway['stream']>[0], 'abortSignal'>,
  context: UpstreamStreamExecutionContext,
): Promise<AcquiredUpstreamStream> {
  const upstreamStartedAt = performance.now()
  const requestTimeout = new RequestTimeout(context.timeoutMs, context.abortController)
  let stream: AsyncIterable<ProxyStreamPart>
  try {
    stream = requestTimeout.wrap(
      gateway.stream({ ...input, abortSignal: context.abortController.signal }),
      context.onDetachedError,
    )
  } catch (error) {
    requestTimeout.clear()
    throw error
  }

  const inspection = await requestTimeout.run(
    inspectFirstStreamChunk(context.plugins, stream, {
      ...context.inspectContext,
      ...(context.inspectContext.telemetry !== undefined && {
        firstChunkStartedAt: upstreamStartedAt,
      }),
      abortSignal: context.abortController.signal,
    }),
  )
  if (inspection.error) {
    return {
      inspectionResponse: {
        body: inspection.error.body,
        status: inspection.error.status,
      },
    }
  }
  return { stream: inspection.stream, upstreamStartedAt }
}

const STREAM_RESPONSE_HEADER_PROBE_CHUNKS = 8

export async function prepareStreamResponseHeaders(
  stream: AsyncIterable<ProxyStreamPart>,
  getHeaders: (() => HeadersInit | undefined) | undefined,
): Promise<PreparedStreamResponse> {
  const initialHeaders = new Headers(getHeaders?.())
  if (hasAnyHeader(initialHeaders) || getHeaders === undefined) {
    if (!initialHeaders.has('content-type')) initialHeaders.set('content-type', 'text/event-stream')
    return { stream, headers: initialHeaders }
  }

  const iterator = stream[Symbol.asyncIterator]()
  const buffered: ProxyStreamPart[] = []
  for (let i = 0; i < STREAM_RESPONSE_HEADER_PROBE_CHUNKS; i += 1) {
    const next = await iterator.next()
    if (next.done) break
    buffered.push(next.value)

    const probedHeaders = new Headers(getHeaders())
    if (hasAnyHeader(probedHeaders)) {
      if (!probedHeaders.has('content-type')) probedHeaders.set('content-type', 'text/event-stream')
      return { stream: replayStreamParts(buffered, iterator), headers: probedHeaders }
    }
  }

  initialHeaders.set('content-type', 'text/event-stream')
  return { stream: replayStreamParts(buffered, iterator), headers: initialHeaders }
}

function replayStreamParts(
  buffered: ProxyStreamPart[],
  iterator: AsyncIterator<ProxyStreamPart>,
): AsyncIterable<ProxyStreamPart> {
  return (async function* () {
    try {
      for (const part of buffered) {
        yield part
      }
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        yield next.value
      }
    } finally {
      await iterator.return?.()
    }
  })()
}

function hasAnyHeader(headers: Headers): boolean {
  return headers.keys().next().done !== true
}
