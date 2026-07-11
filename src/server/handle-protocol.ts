import type { LanguageModel } from 'ai'
import type { Context } from 'hono'
import { OAuthError } from '../oauth/types.js'
import { RoutingError } from '../routing.js'
import { flattenUsage } from '../providers/shared/renderer-utils.js'
import { collectStreamResult } from '../providers/shared/stream-collector.js'
import type {
  ProtocolPassthroughCapability,
  ProtocolRenderEnrichment,
  ProtocolStrategy,
} from '../providers/shared/strategy.js'
import type { ProtocolErrorFormatter } from '../providers/shared/error-format.js'
import type { AISDKInput } from '../providers/shared/aisdk-types.js'
import type { Settings } from '../config.js'
import type { RoutingTable } from '../routing.js'
import type { ResolvedPlugin } from '../plugins/registry.js'
import type { AppEnv, ModelGateway } from './types.js'
import type { ProviderRegistry } from '../providers/registry.js'
import { RequestTimeoutError, withRequestTimeout } from '../request-timeout.js'
import { inspectFirstStreamChunk, type StreamInspectContext } from './stream-inspect.js'
import { readableStreamFromAsyncIterable } from './stream-utils.js'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import { type ErrorLogger, type ErrorPhase, normalizeErrorForLog } from './error-logger.js'
import { buildOAuthLoginUrl } from './oauth/urls.js'

export interface ProtocolContext {
  routingTable: RoutingTable
  settings: Settings
  gateway: ModelGateway
  providerRegistry: Pick<ProviderRegistry, 'languageModel' | 'passthroughTransport'>
  errorLogger: ErrorLogger
}

interface AcquireStreamOptions {
  gateway: ModelGateway
  model: LanguageModel
  callInput: AISDKInput
  requestModel: string
  plugins: ResolvedPlugin[]
  timeoutMs: number
  abortController: AbortController
  formatErrors: ProtocolErrorFormatter
  inspectCtx: StreamInspectContext
}

type AcquireStreamResult =
  | { stream: AsyncIterable<ProxyStreamPart> }
  | { rateLimitResponse: { body: unknown; status: number } }

async function acquireStream(opts: AcquireStreamOptions): Promise<AcquireStreamResult> {
  const stream = opts.gateway.stream({
    model: opts.model,
    callInput: opts.callInput,
    requestModel: opts.requestModel,
    abortSignal: opts.abortController.signal,
  })
  const inspection = await withRequestTimeout(
    inspectFirstStreamChunk(opts.plugins, stream, opts.inspectCtx),
    opts.timeoutMs,
    opts.abortController,
  )
  if (inspection.error) {
    const { body, status } = opts.formatErrors.rateLimit(
      inspection.error.body,
      inspection.error.status,
    )
    return { rateLimitResponse: { body, status } }
  }
  return { stream: inspection.stream }
}

function bufferStreamForErrorLogging<T>(
  stream: AsyncIterable<T>,
  enabled: boolean,
  maxBodyLength: number,
): { stream: AsyncIterable<T>; buffer: unknown[] } {
  const buffer: unknown[] = []
  if (!enabled) {
    return { stream, buffer }
  }
  let truncated = false

  return {
    buffer,
    stream: (async function* () {
      for await (const part of stream) {
        if (!truncated) {
          if (canAppendStreamPreview(buffer, part, maxBodyLength)) {
            buffer.push(part)
          } else {
            appendTruncatedStreamPreview(buffer, maxBodyLength)
            truncated = true
          }
        }
        yield part
      }
    })(),
  }
}

const TRUNCATED_STREAM_PREVIEW = {
  _truncated: true,
  reason: 'stream error preview exceeded maxBodyLength',
}

function appendTruncatedStreamPreview(buffer: unknown[], maxBodyLength: number): void {
  while (
    buffer.length > 0 &&
    !canAppendStreamPreview(buffer, TRUNCATED_STREAM_PREVIEW, maxBodyLength)
  ) {
    buffer.pop()
  }
  if (canAppendStreamPreview(buffer, TRUNCATED_STREAM_PREVIEW, maxBodyLength)) {
    buffer.push(TRUNCATED_STREAM_PREVIEW)
  }
}

function canAppendStreamPreview(buffer: unknown[], value: unknown, maxBodyLength: number): boolean {
  return getStreamPreviewLength(buffer, value) <= maxBodyLength
}

function getStreamPreviewLength(buffer: unknown[], nextValue?: unknown): number {
  let length = 2
  const count = nextValue === undefined ? buffer.length : buffer.length + 1
  for (let index = 0; index < count; index += 1) {
    const value = index < buffer.length ? buffer[index] : nextValue
    length += (index > 0 ? 1 : 0) + stringifyForPreview(value).length
  }
  return length
}

function stringifyForPreview(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return String(value)
  }
}

function getPassthroughCapability<TRequest>(
  strategy: ProtocolStrategy<TRequest, unknown, unknown, object>,
): ProtocolPassthroughCapability<TRequest> | undefined {
  const candidate = strategy as Partial<ProtocolPassthroughCapability<TRequest>>
  return typeof candidate.passthrough === 'function'
    ? (candidate as ProtocolPassthroughCapability<TRequest>)
    : undefined
}

function getRenderEnrichmentCapability<TRequest, TEnrichment extends object>(
  strategy: ProtocolStrategy<TRequest, unknown, unknown, TEnrichment>,
): ProtocolRenderEnrichment<TRequest, TEnrichment> | undefined {
  const candidate = strategy as Partial<ProtocolRenderEnrichment<TRequest, TEnrichment>>
  return typeof candidate.prepareEnrichment === 'function'
    ? (candidate as ProtocolRenderEnrichment<TRequest, TEnrichment>)
    : undefined
}

interface ExecuteUpstreamOptions<TRequest, TSSEData, TResult, TEnrichment extends object> {
  c: Context<AppEnv>
  strategy: ProtocolStrategy<TRequest, TSSEData, TResult, TEnrichment>
  ctx: ProtocolContext
  route: ReturnType<RoutingTable['resolve']>
  model: LanguageModel
  callInput: AISDKInput
  requestModel: string
  request: TRequest
  enrichment: TEnrichment | undefined
  loginUrl: string
  abortController: AbortController
  inspectCtx: StreamInspectContext
}

async function executeUpstream<TRequest, TSSEData, TResult, TEnrichment extends object>(
  opts: ExecuteUpstreamOptions<TRequest, TSSEData, TResult, TEnrichment>,
): Promise<Response> {
  const {
    c,
    strategy,
    ctx,
    route,
    model,
    callInput,
    requestModel,
    request,
    enrichment,
    loginUrl,
    abortController,
    inspectCtx,
  } = opts
  const { formatErrors } = strategy

  const acquireRoutedStream = () =>
    acquireStream({
      gateway: ctx.gateway,
      model,
      callInput,
      requestModel,
      plugins: route.resolvedPlugins,
      timeoutMs: ctx.settings.requestTimeoutMs,
      abortController,
      formatErrors,
      inspectCtx,
    })

  const withEnrichment = <TBase extends object>(base: TBase): TBase & TEnrichment =>
    Object.assign(base, enrichment ?? {}) as TBase & TEnrichment

  // 5-6. Stream or generate + render
  if (strategy.isStream(request)) {
    try {
      const acquired = await acquireRoutedStream()
      if ('rateLimitResponse' in acquired) {
        const { body, status } = acquired.rateLimitResponse
        return c.json(body, status as 429)
      }
      const reqLogger = c.get('logger')
      const enabled = ctx.settings.errorLogging.enabled
      const { stream: teedStream, buffer } = bufferStreamForErrorLogging(
        acquired.stream,
        enabled,
        ctx.settings.errorLogging.maxBodyLength,
      )
      return new Response(
        readableStreamFromAsyncIterable(
          strategy.renderStreamSSE({
            ...withEnrichment({ model: requestModel, stream: teedStream }),
          }),
          (error) => {
            reqLogger.error({ err: error }, 'stream consumption failed')
            writeProtocolErrorLog(c, ctx.errorLogger, error, 'stream', request, buffer)
          },
          abortController,
        ),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    } catch (error) {
      return handleUpstreamError(c, error, formatErrors, loginUrl, 'stream', {
        errorLogger: ctx.errorLogger,
        request,
        response: [],
      })
    }
  }

  // streamOnly: provider 仅支持流式 API，内部走 stream + 收集
  if (route.provider.options?.streamOnly) {
    const enabled = ctx.settings.errorLogging.enabled
    let buffer: unknown[] = []
    try {
      const acquired = await acquireRoutedStream()
      if ('rateLimitResponse' in acquired) {
        const { body, status } = acquired.rateLimitResponse
        return c.json(body, status as 429)
      }
      const buffered = bufferStreamForErrorLogging(
        acquired.stream,
        enabled,
        ctx.settings.errorLogging.maxBodyLength,
      )
      buffer = buffered.buffer
      const collected = await withRequestTimeout(
        collectStreamResult(buffered.stream),
        ctx.settings.requestTimeoutMs,
        abortController,
      )
      const renderInput: Parameters<typeof strategy.renderResult>[0] = withEnrichment({
        model: requestModel,
        text: collected.text,
        finishReason: collected.finishReason,
        ...(collected.response && { response: collected.response }),
        ...(collected.toolCalls && { toolCalls: collected.toolCalls }),
      })
      if (collected.usage) renderInput.usage = collected.usage
      return c.json(strategy.renderResult(renderInput))
    } catch (error) {
      return handleUpstreamError(c, error, formatErrors, loginUrl, 'stream-only', {
        errorLogger: ctx.errorLogger,
        request,
        response: buffer,
      })
    }
  }

  // 正常非流式路径
  try {
    const result = await withRequestTimeout(
      ctx.gateway.generate({
        model,
        callInput,
        requestModel,
        abortSignal: abortController.signal,
      }),
      ctx.settings.requestTimeoutMs,
      abortController,
    )
    const renderInput: Parameters<typeof strategy.renderResult>[0] = withEnrichment({
      model: requestModel,
      text: result.text,
      finishReason: result.finishReason,
      response: result.response,
      toolCalls: result.toolCalls,
    })
    if (result.usage) renderInput.usage = flattenUsage(result.usage)
    return c.json(strategy.renderResult(renderInput))
  } catch (error) {
    return handleUpstreamError(c, error, formatErrors, loginUrl, 'generate', {
      errorLogger: ctx.errorLogger,
      request,
      response: null,
    })
  }
}

export async function handleProtocolRequest<
  TRequest,
  TSSEData,
  TResult,
  TEnrichment extends object,
>(
  c: Context<AppEnv>,
  strategy: ProtocolStrategy<TRequest, TSSEData, TResult, TEnrichment>,
  ctx: ProtocolContext,
): Promise<Response> {
  const { formatErrors } = strategy

  // 1. Validate request（缓存原始 body 供 passthrough 透传字节级一致）
  let request: TRequest
  let rawBody: unknown
  try {
    rawBody = await c.req.json()
    request = strategy.validate(rawBody)
  } catch (error) {
    c.get('logger').error({ err: error, phase: 'validation' }, 'request validation failed')
    const { body, status } = formatErrors.validation(strategy.validationMessage)
    return c.json(body, status as 400)
  }

  // 2. Resolve route
  const requestModel = strategy.getModel(request)
  let route
  try {
    route = ctx.routingTable.resolve(requestModel)
  } catch (error) {
    if (error instanceof RoutingError) {
      const { body, status } = formatErrors.routing(error)
      return c.json(body, status as 404)
    }
    throw error
  }

  c.set('provider', route.providerName)
  c.set('requestedModel', requestModel)
  c.set('actualModel', route.upstreamModel)

  c.get('logger').info(
    { requestModel, upstreamModel: route.upstreamModel, provider: route.providerName },
    'route resolved',
  )

  const loginUrl = buildOAuthLoginUrl(ctx.settings, route.providerName)

  // 3. passthrough 直通转发（openai 上游 + openai-responses 时绕过 AI SDK，字节级一致）
  const abortController = new AbortController()
  const passthrough = getPassthroughCapability(strategy)
  if (passthrough) {
    const passthroughResp = await passthrough.passthrough({
      route,
      request,
      rawBody,
      upstreamModel: route.upstreamModel,
      loginUrl,
      settings: ctx.settings,
      passthroughTransport: (providerName) =>
        ctx.providerRegistry.passthroughTransport(providerName),
      setKeySelection: (keySelection) => c.set('keySelection', keySelection),
      logger: c.get('logger'),
      abortController,
    })
    if (passthroughResp) return passthroughResp
  }

  // 4. Map to AI SDK input + compute strategy-local enrichment
  const callInput = strategy.mapToAISDKInput(request, route.provider.type)
  const enrichment = getRenderEnrichmentCapability(strategy)?.prepareEnrichment(
    request,
    route.provider.type,
  )

  // 5. Get LanguageModel + delegate execution to executeUpstream
  let model
  try {
    const modelResult = ctx.providerRegistry.languageModel(
      route.providerName,
      route.upstreamModel,
      route.headers,
    )
    model = modelResult.model
    if (modelResult.keySelection) {
      c.set('keySelection', modelResult.keySelection)
    }
  } catch (error) {
    if (error instanceof OAuthError && error.code === 'auth_required') {
      c.get('logger').error(
        {
          err: error,
          phase: 'resolve-model',
          provider: route.providerName,
          requestedModel: requestModel,
          actualModel: route.upstreamModel,
        },
        'model resolution failed',
      )
      const { body, status } = formatErrors.oauth(error.message, loginUrl)
      return c.json(body, status as 503)
    }
    throw error
  }
  const inspectCtx: StreamInspectContext = {
    requestId: c.get('requestId'),
    settings: ctx.settings,
    provider: { id: route.providerName, provider: route.provider },
  }

  return executeUpstream({
    c,
    strategy,
    ctx,
    route,
    model,
    callInput,
    requestModel,
    request,
    enrichment,
    loginUrl,
    abortController,
    inspectCtx,
  })
}

interface ErrorLogContext {
  errorLogger: ErrorLogger
  request: unknown
  response: unknown[] | null
}

function writeProtocolErrorLog(
  c: Context<AppEnv>,
  errorLogger: ErrorLogger,
  error: unknown,
  phase: ErrorPhase,
  request: unknown,
  response: unknown[] | null,
): void {
  errorLogger.log({
    requestId: c.get('requestId'),
    phase,
    provider: c.get('provider') ?? '',
    requestedModel: c.get('requestedModel') ?? '',
    actualModel: c.get('actualModel') ?? '',
    error: normalizeErrorForLog(error),
    request,
    response,
  })
}

export function handleUpstreamError(
  c: Context<AppEnv>,
  error: unknown,
  formatErrors: ProtocolErrorFormatter,
  loginUrl: string,
  phase: ErrorPhase,
  errorLogCtx?: ErrorLogContext,
): Response {
  c.get('logger').error({ err: error, phase }, 'upstream request failed')
  if (error instanceof OAuthError && error.code === 'auth_required') {
    const { body, status } = formatErrors.oauth(error.message, loginUrl)
    return c.json(body, status as 503)
  }
  if (errorLogCtx) {
    writeProtocolErrorLog(
      c,
      errorLogCtx.errorLogger,
      error,
      phase,
      errorLogCtx.request,
      errorLogCtx.response,
    )
  }
  if (error instanceof RequestTimeoutError) {
    const { body, status } = formatErrors.timeout()
    return c.json(body, status as 504)
  }
  const { body, status } = formatErrors.upstream()
  return c.json(body, status as 502)
}
