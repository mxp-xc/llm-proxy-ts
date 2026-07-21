import type { LanguageModel } from 'ai'
import { OAuthError } from '../oauth/types.js'
import { RoutingError } from '../routing.js'
import { flattenUsage } from '../providers/shared/renderer-utils.js'
import { collectStreamResult } from '../providers/shared/stream-collector.js'
import type {
  ExecutionOverrideConfig,
  ProtocolExecutionOverride,
  ProtocolProviderAwareMapping,
  ProtocolRenderEnrichment,
  ProtocolStrategy,
} from '../providers/shared/strategy.js'
import type { ProtocolErrorFormatter } from '../providers/shared/error-format.js'
import type { AISDKInput } from '../providers/shared/aisdk-types.js'
import type { Settings } from '../config.js'
import type { RoutingTable } from '../routing.js'
import type { ResolvedPlugin } from '../plugins/registry.js'
import type { ModelGateway, RequestLogContext } from './types.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { Logger } from '../types.js'
import { RequestTimeoutError, withRequestTimeout } from '../request-timeout.js'
import { inspectFirstStreamChunk, type StreamInspectContext } from './stream-inspect.js'
import { readableStreamFromAsyncIterable } from './stream-utils.js'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import { type ErrorLogger, type ErrorPhase, normalizeErrorForLog } from './error-logger.js'
import { buildOAuthLoginUrl } from './oauth/urls.js'
import { filterDisabledTools } from '../tool-filter.js'

export interface ProtocolContext {
  routingTable: RoutingTable
  settings: Settings
  gateway: ModelGateway
  providerRegistry: Pick<ProviderRegistry, 'languageModel'>
  errorLogger: ErrorLogger
}

export interface ProtocolRequestScope {
  requestId: string
  logger: Logger
  readJson(): Promise<unknown>
  setRequestLogContext(context: RequestLogContext): void
}

interface AcquireStreamOptions {
  gateway: ModelGateway
  logger: Logger
  model: LanguageModel
  callInput: AISDKInput
  requestModel: string
  options?: Parameters<ModelGateway['stream']>[0]['options']
  plugins: ResolvedPlugin[]
  timeoutMs: number
  abortController: AbortController
  formatErrors: ProtocolErrorFormatter
  inspectCtx: StreamInspectContext
}

interface ProtocolRequestMetadata {
  requestId: string
  provider: string
  requestedModel: string
  actualModel: string
}

interface ExecutionRuntime {
  gateway: ModelGateway
  requestTimeoutMs: number
  errorLogging: {
    enabled: boolean
    maxBodyLength: number
  }
  errorLogger: ErrorLogger
}

interface ExecutionRoute {
  streamOnly: boolean
  plugins: ResolvedPlugin[]
}

type AcquireStreamResult =
  | { stream: AsyncIterable<ProxyStreamPart> }
  | { rateLimitResponse: { body: unknown; status: number } }

function jsonResponse(body: unknown, status?: number): Response {
  return Response.json(body, status === undefined ? undefined : { status })
}

async function acquireStream(opts: AcquireStreamOptions): Promise<AcquireStreamResult> {
  const streamInput: Parameters<ModelGateway['stream']>[0] = {
    model: opts.model,
    callInput: opts.callInput,
    requestModel: opts.requestModel,
    abortSignal: opts.abortController.signal,
    onError: (error) => {
      opts.logger.error({ err: normalizeErrorForLog(error) }, 'stream error from AI SDK')
    },
  }
  if (opts.options !== undefined) streamInput.options = opts.options
  const stream = opts.gateway.stream(streamInput)
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
const STREAM_RESPONSE_HEADER_PROBE_CHUNKS = 8

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

async function prepareStreamResponseHeaders(
  stream: AsyncIterable<ProxyStreamPart>,
  getHeaders: (() => HeadersInit | undefined) | undefined,
): Promise<{ stream: AsyncIterable<ProxyStreamPart>; headers: Headers }> {
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

function getExecutionOverrideCapability<TRequest, TSSEData, TResult, TEnrichment extends object>(
  strategy: ProtocolStrategy<TRequest, TSSEData, TResult, TEnrichment>,
): ProtocolExecutionOverride<TSSEData, TResult, TEnrichment> | undefined {
  const candidate = strategy as Partial<ProtocolExecutionOverride<TSSEData, TResult, TEnrichment>>
  return typeof candidate.prepareExecution === 'function'
    ? (candidate as ProtocolExecutionOverride<TSSEData, TResult, TEnrichment>)
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

function getProviderAwareMappingCapability<TRequest, TSSEData, TResult, TEnrichment extends object>(
  strategy: ProtocolStrategy<TRequest, TSSEData, TResult, TEnrichment>,
): ProtocolProviderAwareMapping<TRequest> | undefined {
  const candidate = strategy as Partial<ProtocolProviderAwareMapping<TRequest>>
  return typeof candidate.mapToProviderAISDKInput === 'function'
    ? (candidate as ProtocolProviderAwareMapping<TRequest>)
    : undefined
}

interface ExecuteUpstreamOptions<TRequest, TSSEData, TResult, TEnrichment extends object> {
  logger: Logger
  strategy: ProtocolStrategy<TRequest, TSSEData, TResult, TEnrichment>
  runtime: ExecutionRuntime
  route: ExecutionRoute
  model: LanguageModel
  callInput: AISDKInput
  requestModel: string
  request: TRequest
  enrichment: TEnrichment | undefined
  loginUrl: string
  requestMetadata: ProtocolRequestMetadata
  abortController: AbortController
  inspectCtx: StreamInspectContext
  executionOverride?: ExecutionOverrideConfig<TSSEData, TResult, TEnrichment>
}

async function executeUpstream<TRequest, TSSEData, TResult, TEnrichment extends object>(
  opts: ExecuteUpstreamOptions<TRequest, TSSEData, TResult, TEnrichment>,
): Promise<Response> {
  const {
    logger,
    strategy,
    runtime,
    route,
    model,
    callInput,
    requestModel,
    request,
    enrichment,
    loginUrl,
    requestMetadata,
    abortController,
    inspectCtx,
    executionOverride,
  } = opts
  const { formatErrors } = strategy

  const acquireRoutedStream = () =>
    acquireStream({
      gateway: runtime.gateway,
      logger,
      model,
      callInput,
      requestModel,
      plugins: route.plugins,
      timeoutMs: runtime.requestTimeoutMs,
      abortController,
      formatErrors,
      inspectCtx,
      ...(executionOverride?.streamOptions !== undefined
        ? { options: executionOverride.streamOptions }
        : {}),
    })

  const withEnrichment = <TBase extends object>(base: TBase): TBase & TEnrichment =>
    Object.assign(base, enrichment ?? {}) as TBase & TEnrichment
  const renderStreamSSE = executionOverride?.renderStreamSSE ?? strategy.renderStreamSSE
  const renderResult = executionOverride?.renderResult ?? strategy.renderResult

  // 5-6. Stream or generate + render
  if (strategy.isStream(request)) {
    try {
      const acquired = await acquireRoutedStream()
      if ('rateLimitResponse' in acquired) {
        const { body, status } = acquired.rateLimitResponse
        return jsonResponse(body, status)
      }
      const { stream: teedStream, buffer } = bufferStreamForErrorLogging(
        acquired.stream,
        runtime.errorLogging.enabled,
        runtime.errorLogging.maxBodyLength,
      )
      const preparedStreamResponse = await prepareStreamResponseHeaders(
        teedStream,
        executionOverride?.streamResponseHeaders,
      )
      return new Response(
        readableStreamFromAsyncIterable(
          renderStreamSSE({
            ...withEnrichment({ model: requestModel, stream: preparedStreamResponse.stream }),
          }),
          (error) => {
            logger.error({ err: normalizeErrorForLog(error) }, 'stream consumption failed')
            writeProtocolErrorLog(
              runtime.errorLogger,
              requestMetadata,
              error,
              'stream',
              request,
              buffer,
            )
          },
          abortController,
        ),
        {
          headers: preparedStreamResponse.headers,
        },
      )
    } catch (error) {
      return handleUpstreamError(error, formatErrors, loginUrl, 'stream', logger, {
        errorLogger: runtime.errorLogger,
        requestMetadata,
        request,
        response: [],
      })
    }
  }

  // streamOnly: provider 仅支持流式 API，内部走 stream + 收集
  if (route.streamOnly) {
    let buffer: unknown[] = []
    try {
      const acquired = await acquireRoutedStream()
      if ('rateLimitResponse' in acquired) {
        const { body, status } = acquired.rateLimitResponse
        return jsonResponse(body, status)
      }
      const buffered = bufferStreamForErrorLogging(
        acquired.stream,
        runtime.errorLogging.enabled,
        runtime.errorLogging.maxBodyLength,
      )
      buffer = buffered.buffer
      const collected = await withRequestTimeout(
        collectStreamResult(buffered.stream),
        runtime.requestTimeoutMs,
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
      return jsonResponse(renderResult(renderInput))
    } catch (error) {
      return handleUpstreamError(error, formatErrors, loginUrl, 'stream-only', logger, {
        errorLogger: runtime.errorLogger,
        requestMetadata,
        request,
        response: buffer,
      })
    }
  }

  // 正常非流式路径
  try {
    const generateInput: Parameters<ModelGateway['generate']>[0] = {
      model,
      callInput,
      requestModel,
      abortSignal: abortController.signal,
    }
    if (executionOverride?.generateOptions !== undefined) {
      generateInput.options = executionOverride.generateOptions
    }
    const result = await withRequestTimeout(
      runtime.gateway.generate(generateInput),
      runtime.requestTimeoutMs,
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
    const responseHeaders = executionOverride?.responseHeaders?.(renderInput)
    if (responseHeaders !== undefined) {
      const headers = new Headers(responseHeaders)
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
      return new Response(JSON.stringify(renderResult(renderInput)), { headers })
    }
    return jsonResponse(renderResult(renderInput))
  } catch (error) {
    return handleUpstreamError(error, formatErrors, loginUrl, 'generate', logger, {
      errorLogger: runtime.errorLogger,
      requestMetadata,
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
  requestScope: ProtocolRequestScope,
  strategy: ProtocolStrategy<TRequest, TSSEData, TResult, TEnrichment>,
  ctx: ProtocolContext,
): Promise<Response> {
  const { formatErrors } = strategy

  // 1. Validate request（缓存原始 body 供 passthrough 透传字节级一致）
  let request: TRequest
  let rawBody: unknown
  try {
    rawBody = await requestScope.readJson()
    request = strategy.validate(rawBody)
  } catch (error) {
    requestScope.logger.error({ err: error, phase: 'validation' }, 'request validation failed')
    const { body, status } = formatErrors.validation(strategy.validationMessage)
    return jsonResponse(body, status)
  }

  // 2. Resolve route
  const requestModel = strategy.getModel(request)
  let route
  try {
    route = ctx.routingTable.resolve(requestModel)
  } catch (error) {
    if (error instanceof RoutingError) {
      const { body, status } = formatErrors.routing(error)
      return jsonResponse(body, status)
    }
    throw error
  }

  const requestLogContext: RequestLogContext = {
    provider: route.providerName,
    requestedModel: requestModel,
    actualModel: route.upstreamModel,
  }
  requestScope.setRequestLogContext(requestLogContext)
  const requestMetadata: ProtocolRequestMetadata = {
    requestId: requestScope.requestId,
    provider: route.providerName,
    requestedModel: requestModel,
    actualModel: route.upstreamModel,
  }

  const loginUrl = buildOAuthLoginUrl(ctx.settings, route.providerName)
  const providerType = route.provider.type

  // 3. Prepare execution override（例如 openai-responses + openai 上游的 AI SDK raw renderer）
  const abortController = new AbortController()
  const executionOverride = getExecutionOverrideCapability(strategy)?.prepareExecution({
    providerType,
    rawBody,
  })

  // 4. Map to AI SDK input + compute strategy-local enrichment
  const providerAwareMapping = getProviderAwareMappingCapability(strategy)
  const mappedCallInput =
    providerAwareMapping?.mapToProviderAISDKInput(request, providerType) ??
    strategy.mapToAISDKInput(request)
  const callInput = filterDisabledTools(mappedCallInput, route.disabledToolMatcher)
  const enrichment = getRenderEnrichmentCapability(strategy)?.prepareEnrichment(
    request,
    providerType,
  )

  // 5. Get LanguageModel + delegate execution to executeUpstream
  let model
  try {
    const modelResult = ctx.providerRegistry.languageModel(
      route.providerName,
      route.upstreamModel,
      route.modelHeaders,
      executionOverride?.languageModelOptions,
    )
    model = modelResult.model
    if (modelResult.keySelection) {
      requestLogContext.keySelection = modelResult.keySelection
    }
    requestScope.logger.info(
      {
        provider: route.providerName,
        requestModel,
        upstreamModel: route.upstreamModel,
        requestedModel: requestModel,
        actualModel: route.upstreamModel,
        modelKey: route.modelKey,
        modelSelector: route.modelSelector,
        keySelection: modelResult.keySelection,
      },
      'route resolved',
    )
  } catch (error) {
    if (error instanceof OAuthError && error.code === 'auth_required') {
      requestScope.logger.error(
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
      return jsonResponse(body, status)
    }
    throw error
  }
  const inspectCtx: StreamInspectContext = {
    requestId: requestScope.requestId,
    settings: ctx.settings,
    provider: { id: route.providerName, provider: route.provider },
  }
  const runtime: ExecutionRuntime = {
    gateway: ctx.gateway,
    requestTimeoutMs: ctx.settings.requestTimeoutMs,
    errorLogging: {
      enabled: ctx.settings.errorLogging.enabled,
      maxBodyLength: ctx.settings.errorLogging.maxBodyLength,
    },
    errorLogger: ctx.errorLogger,
  }
  const executionRoute: ExecutionRoute = {
    streamOnly: route.provider.options?.streamOnly === true,
    plugins: route.resolvedPlugins,
  }

  return executeUpstream({
    logger: requestScope.logger,
    strategy,
    runtime,
    route: executionRoute,
    model,
    callInput,
    requestModel,
    request,
    enrichment,
    loginUrl,
    requestMetadata,
    abortController,
    inspectCtx,
    ...(executionOverride !== undefined ? { executionOverride } : {}),
  })
}

interface ErrorLogContext {
  errorLogger: ErrorLogger
  requestMetadata: ProtocolRequestMetadata
  request: unknown
  response: unknown[] | null
}

function writeProtocolErrorLog(
  errorLogger: ErrorLogger,
  metadata: ProtocolRequestMetadata,
  error: unknown,
  phase: ErrorPhase,
  request: unknown,
  response: unknown[] | null,
): void {
  errorLogger.log({
    requestId: metadata.requestId,
    phase,
    provider: metadata.provider,
    requestedModel: metadata.requestedModel,
    actualModel: metadata.actualModel,
    error: normalizeErrorForLog(error),
    request,
    response,
  })
}

function handleUpstreamError(
  error: unknown,
  formatErrors: ProtocolErrorFormatter,
  loginUrl: string,
  phase: ErrorPhase,
  logger: Logger,
  errorLogCtx?: ErrorLogContext,
): Response {
  logger.error({ err: normalizeErrorForLog(error), phase }, 'upstream request failed')
  if (error instanceof OAuthError && error.code === 'auth_required') {
    const { body, status } = formatErrors.oauth(error.message, loginUrl)
    return jsonResponse(body, status)
  }
  if (errorLogCtx) {
    writeProtocolErrorLog(
      errorLogCtx.errorLogger,
      errorLogCtx.requestMetadata,
      error,
      phase,
      errorLogCtx.request,
      errorLogCtx.response,
    )
  }
  if (error instanceof RequestTimeoutError) {
    const { body, status } = formatErrors.timeout()
    return jsonResponse(body, status)
  }
  const { body, status } = formatErrors.upstream()
  return jsonResponse(body, status)
}
