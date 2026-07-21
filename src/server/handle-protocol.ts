import type { LanguageModel } from 'ai'
import { OAuthError } from '../oauth/types.js'
import { RoutingError } from '../routing.js'
import { extractUsageFromFinishPart, flattenUsage } from '../providers/shared/renderer-utils.js'
import { collectStreamResult } from '../providers/shared/stream-collector.js'
import type {
  ExecutionOverrideConfig,
  ProtocolExecutionOverride,
  ProtocolProviderAwareMapping,
  ProtocolRenderEnrichment,
  ProtocolStrategy,
  ProtocolVisionInputFilter,
  VisionArtifactUnavailableReason,
  VisionInputProtocol,
  VisionInputTransformResult,
  VisionToolResultImageCandidate,
  VisionToolResultReplacement,
} from '../providers/shared/strategy.js'
import type { ProtocolErrorFormatter } from '../providers/shared/error-format.js'
import type { AISDKInput } from '../providers/shared/aisdk-types.js'
import type { Settings } from '../config.js'
import type { RoutingTable } from '../routing.js'
import type { ResolvedPlugin } from '../plugins/registry.js'
import type { ModelGateway, RequestOutcome, RequestTelemetryContext } from './types.js'
import type { ProviderRegistry } from '../providers/registry.js'
import type { Logger } from '../types.js'
import { RequestTimeoutError, withRequestTimeout } from '../request-timeout.js'
import { inspectFirstStreamChunk, type StreamInspectContext } from './stream-inspect.js'
import { readableStreamFromAsyncIterable } from './stream-utils.js'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import {
  type ErrorLogger,
  type ErrorPhase,
  type NormalizedErrorForLog,
  normalizeErrorForLog,
} from './error-logger.js'
import { buildOAuthLoginUrl } from './oauth/urls.js'
import { filterDisabledTools } from '../tool-filter.js'
import { resolveModelSupportsVision } from '../config-helpers.js'
import {
  createVisionToolResultReplacement,
  type VisionArtifactBatchResult,
  type VisionArtifactPersistenceError,
  type VisionArtifactStore,
} from './vision-artifact-store.js'

export interface ProtocolContext {
  routingTable: RoutingTable
  settings: Settings
  gateway: ModelGateway
  providerRegistry: Pick<ProviderRegistry, 'languageModel'>
  errorLogger: ErrorLogger
  visionArtifactStore: Pick<VisionArtifactStore, 'persistBatch'>
}

export interface ProtocolRequestScope {
  requestId: string
  logger: Logger
  telemetry: RequestTelemetryContext
  readJson(): Promise<unknown>
}

interface AcquireStreamOptions {
  gateway: ModelGateway
  model: LanguageModel
  callInput: AISDKInput
  requestModel: string
  options?: Parameters<ModelGateway['stream']>[0]['options']
  plugins: ResolvedPlugin[]
  timeoutMs: number
  abortController: AbortController
  formatErrors: ProtocolErrorFormatter
  inspectCtx: StreamInspectContext
  telemetry: RequestTelemetryContext
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
  | { stream: AsyncIterable<ProxyStreamPart>; upstreamStartedAt: number }
  | { rateLimitResponse: { body: unknown; status: number } }

function jsonResponse(body: unknown, status?: number): Response {
  return Response.json(body, status === undefined ? undefined : { status })
}

async function acquireStream(opts: AcquireStreamOptions): Promise<AcquireStreamResult> {
  const upstreamStartedAt = performance.now()
  const streamInput: Parameters<ModelGateway['stream']>[0] = {
    model: opts.model,
    callInput: opts.callInput,
    requestModel: opts.requestModel,
    abortSignal: opts.abortController.signal,
    onError: (error) => {
      opts.telemetry.pendingStreamError = error
    },
  }
  if (opts.options !== undefined) streamInput.options = opts.options
  const stream = opts.gateway.stream(streamInput)
  const inspectCtx: StreamInspectContext = {
    ...opts.inspectCtx,
    ...(opts.telemetry.executionMode === 'stream'
      ? { firstChunkStartedAt: upstreamStartedAt, telemetry: opts.telemetry }
      : {}),
  }
  const inspection = await withRequestTimeout(
    inspectFirstStreamChunk(opts.plugins, stream, inspectCtx),
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
  return { stream: inspection.stream, upstreamStartedAt }
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

function setOutcome(
  telemetry: RequestTelemetryContext,
  outcome: RequestOutcome,
  explicitFailure = false,
): void {
  if (telemetry.explicitFailure) return
  telemetry.outcome = outcome
  if (explicitFailure) telemetry.explicitFailure = true
}

type UpstreamFailureOutcome = Extract<
  RequestOutcome,
  'auth_required' | 'rate_limited' | 'timeout' | 'upstream_error' | 'upstream_aborted'
>

interface ClassifiedUpstreamFailure {
  outcome: UpstreamFailureOutcome
  error: NormalizedErrorForLog
}

function classifyUpstreamFailure(error: unknown): ClassifiedUpstreamFailure {
  const normalized = normalizeErrorForLog(error)
  if (errorChainSome(error, (candidate) => candidate instanceof RequestTimeoutError)) {
    return { outcome: 'timeout', error: normalized }
  }
  if (
    errorChainSome(error, (candidate, record) => {
      return (
        (candidate instanceof OAuthError && candidate.code === 'auth_required') ||
        (record?.name === 'OAuthError' && record.code === 'auth_required')
      )
    })
  ) {
    return { outcome: 'auth_required', error: normalized }
  }
  if (isRateLimitError(normalized)) return { outcome: 'rate_limited', error: normalized }
  if (
    errorChainSome(error, (_candidate, record) => {
      return (
        record?.name === 'AbortError' ||
        record?.code === 'ABORT_ERR' ||
        record?.code === 'ERR_ABORTED'
      )
    })
  ) {
    return { outcome: 'upstream_aborted', error: normalized }
  }
  return { outcome: 'upstream_error', error: normalized }
}

function errorChainSome(
  error: unknown,
  predicate: (candidate: unknown, record: Record<string, unknown> | undefined) => boolean,
  seen: Set<object> = new Set(),
  depth = 0,
): boolean {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : undefined
  if (predicate(error, record)) return true
  if (!record || depth >= 4 || seen.has(record)) return false
  seen.add(record)
  return (
    errorChainSome(record.lastError, predicate, seen, depth + 1) ||
    errorChainSome(record.cause, predicate, seen, depth + 1)
  )
}

function isRateLimitError(error: NormalizedErrorForLog): boolean {
  if (error.statusCode === 429) return true
  const markers = [error.code, error.upstreamErrorType, error.upstreamErrorCode]
  return (
    markers.some(
      (value) =>
        typeof value === 'string' && /rate.?limit|too.?many.?requests|quota.?exceeded/i.test(value),
    ) ||
    (error.cause !== undefined && isRateLimitError(error.cause))
  )
}

function shouldWriteErrorPreview(outcome: UpstreamFailureOutcome): boolean {
  return outcome === 'timeout' || outcome === 'upstream_error'
}

function failureLogMessage(outcome: UpstreamFailureOutcome, stream: boolean): string {
  switch (outcome) {
    case 'auth_required':
      return 'upstream authentication required'
    case 'rate_limited':
      return 'upstream request rate limited'
    case 'upstream_aborted':
      return stream ? 'upstream stream aborted' : 'upstream request aborted'
    default:
      return stream ? 'upstream stream failed' : 'upstream request failed'
  }
}

function logUpstreamFailureOnce(
  logger: Logger,
  telemetry: RequestTelemetryContext,
  failure: ClassifiedUpstreamFailure,
  phase: ErrorPhase,
  stream: boolean,
): void {
  if (telemetry.failureLogged) return
  telemetry.failureLogged = true
  const fields = {
    err: failure.error,
    phase,
    provider: telemetry.provider,
    requestedModel: telemetry.requestedModel,
    actualModel: telemetry.actualModel,
    executionMode: telemetry.executionMode,
    keySelection: telemetry.keySelection,
  }
  const message = failureLogMessage(failure.outcome, stream)
  if (failure.outcome === 'timeout' || failure.outcome === 'upstream_error') {
    logger.error(fields, message)
  } else {
    logger.warn(fields, message)
  }
}

function applyUpstreamFailure(
  telemetry: RequestTelemetryContext,
  failure: ClassifiedUpstreamFailure,
): void {
  if (telemetry.explicitFailure && telemetry.outcome !== 'client_cancelled') return
  telemetry.terminalPart = failure.outcome === 'upstream_aborted' ? 'abort' : 'error'
  telemetry.terminalError = failure.error.name
  telemetry.outcome = failure.outcome
  telemetry.explicitFailure = true
}

function markInternalFailure(telemetry: RequestTelemetryContext, error: unknown): void {
  if (!telemetry.explicitFailure) {
    telemetry.outcome = 'internal_error'
    telemetry.explicitFailure = true
    telemetry.terminalPart = 'error'
  }
  telemetry.terminalError = normalizeErrorForLog(error).name
}

function normalizeValidationErrorForLog(error: unknown): NormalizedErrorForLog {
  const normalized = normalizeErrorForLog(error)
  if (normalized.name !== 'SyntaxError') return normalized

  const message = 'Request body is not valid JSON'
  return {
    ...normalized,
    message,
    ...(normalized.stack !== undefined && {
      stack: normalized.stack.replace(/^[^\r\n]*/, `SyntaxError: ${message}`),
    }),
  }
}

function applyUsage(
  telemetry: RequestTelemetryContext,
  usage:
    | {
        inputTokens?: number | undefined
        outputTokens?: number | undefined
        totalTokens?: number | undefined
        cacheReadTokens?: number | undefined
        reasoningTokens?: number | undefined
      }
    | undefined,
): void {
  if (!usage) return
  if (usage.inputTokens !== undefined) telemetry.inputTokens = usage.inputTokens
  if (usage.outputTokens !== undefined) telemetry.outputTokens = usage.outputTokens
  if (usage.totalTokens !== undefined) telemetry.totalTokens = usage.totalTokens
  if (usage.cacheReadTokens !== undefined) telemetry.cacheReadTokens = usage.cacheReadTokens
  if (usage.reasoningTokens !== undefined) telemetry.reasoningTokens = usage.reasoningTokens
}

function setUpstreamRequestId(telemetry: RequestTelemetryContext, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    telemetry.upstreamRequestId = value.slice(0, 256)
  }
}

function setUpstreamRequestIdFromHeaders(
  telemetry: RequestTelemetryContext,
  headers: Headers,
): void {
  setUpstreamRequestId(
    telemetry,
    headers.get('x-upstream-request-id') ?? headers.get('x-request-id'),
  )
}

function observeTerminalParts(
  stream: AsyncIterable<ProxyStreamPart>,
  telemetry: RequestTelemetryContext,
  logger: Logger,
  onFailure?: (error: unknown, outcome: UpstreamFailureOutcome) => void,
): AsyncIterable<ProxyStreamPart> {
  return (async function* () {
    const iterator = stream[Symbol.asyncIterator]()
    const recordFailure = (error: unknown): ClassifiedUpstreamFailure => {
      const failure = classifyUpstreamFailure(error)
      if (telemetry.outcome === 'client_cancelled' && failure.outcome === 'upstream_aborted') {
        delete telemetry.pendingStreamError
        return failure
      }
      applyUpstreamFailure(telemetry, failure)
      logUpstreamFailureOnce(
        logger,
        telemetry,
        failure,
        telemetry.executionMode === 'stream-only' ? 'stream-only' : 'stream',
        telemetry.executionMode === 'stream',
      )
      if (shouldWriteErrorPreview(failure.outcome)) onFailure?.(error, failure.outcome)
      delete telemetry.pendingStreamError
      return failure
    }
    try {
      while (true) {
        let next: IteratorResult<ProxyStreamPart>
        try {
          next = await iterator.next()
        } catch (error) {
          recordFailure(error)
          throw error
        }
        if (next.done) {
          if (telemetry.terminalPart === undefined) {
            if (telemetry.pendingStreamError !== undefined) {
              const pendingError = telemetry.pendingStreamError
              recordFailure(pendingError)
            } else if (telemetry.outcome !== 'client_cancelled') {
              telemetry.terminalPart = 'eof'
              setOutcome(telemetry, 'incomplete_stream', true)
              if (!telemetry.failureLogged) {
                telemetry.failureLogged = true
                logger.warn(
                  {
                    phase: telemetry.executionMode,
                    provider: telemetry.provider,
                    requestedModel: telemetry.requestedModel,
                    actualModel: telemetry.actualModel,
                    keySelection: telemetry.keySelection,
                  },
                  'upstream stream ended without terminal part',
                )
              }
            }
          }
          return
        }
        const part = next.value
        switch (part.type) {
          case 'finish':
            if (!telemetry.explicitFailure) telemetry.terminalPart = 'finish'
            telemetry.finishReason = part.finishReason
            applyUsage(telemetry, extractUsageFromFinishPart(part))
            setUpstreamRequestId(telemetry, part.response?.id)
            setOutcome(telemetry, 'success')
            delete telemetry.pendingStreamError
            break
          case 'error':
            recordFailure(part.error)
            break
          case 'openai-error': {
            const error = Object.assign(new Error('Upstream stream error'), {
              ...(part.status !== undefined && { statusCode: part.status }),
            })
            recordFailure(error)
            break
          }
          case 'abort':
            if (!telemetry.explicitFailure) {
              telemetry.terminalPart = 'abort'
              setOutcome(telemetry, 'upstream_aborted', true)
              if (!telemetry.failureLogged) {
                telemetry.failureLogged = true
                logger.warn(
                  {
                    phase: telemetry.executionMode,
                    provider: telemetry.provider,
                    requestedModel: telemetry.requestedModel,
                    actualModel: telemetry.actualModel,
                    keySelection: telemetry.keySelection,
                  },
                  'upstream stream aborted',
                )
              }
            }
            delete telemetry.pendingStreamError
            break
        }
        yield part
      }
    } finally {
      await iterator.return?.()
    }
  })()
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

function getVisionInputFilterCapability<TRequest, TSSEData, TResult, TEnrichment extends object>(
  strategy: ProtocolStrategy<TRequest, TSSEData, TResult, TEnrichment>,
): ProtocolVisionInputFilter | undefined {
  const candidate = strategy as Partial<ProtocolVisionInputFilter>
  return typeof candidate.planUnsupportedVisionInput === 'function' &&
    typeof candidate.applyUnsupportedVisionInput === 'function' &&
    candidate.visionInputProtocol !== undefined
    ? (candidate as ProtocolVisionInputFilter)
    : undefined
}

type VisionInputFilterOutcome = 'forwarded' | 'rejected' | 'internal_error'

function logVisionInputMutation(
  logger: Logger,
  metadata: ProtocolRequestMetadata,
  protocol: VisionInputProtocol,
  result: VisionInputTransformResult,
  outcome: VisionInputFilterOutcome,
): void {
  const changes = result.changes.map((change) => {
    if (change.action === 'remove_image') {
      return {
        action: change.action,
        path: change.path,
        ...(change.role === undefined ? {} : { role: change.role }),
        blockType: change.blockType,
      }
    }
    return {
      action: change.action,
      path: change.path,
      ...(change.role === undefined ? {} : { role: change.role }),
      blockType: change.blockType,
      containerType: change.containerType,
      artifactStatus: change.artifactStatus,
      ...(change.unavailableReason === undefined
        ? {}
        : { unavailableReason: change.unavailableReason }),
    }
  })
  const fallbackChanges = result.changes.filter(
    (change) => change.action === 'replace_tool_result_image',
  )
  const storedArtifactCount = fallbackChanges.filter(
    (change) => change.artifactStatus === 'stored',
  ).length
  const unavailableReasonCounts: Record<string, number> = {}
  for (const change of fallbackChanges) {
    if (change.artifactStatus !== 'unavailable' || change.unavailableReason === undefined) continue
    unavailableReasonCounts[change.unavailableReason] =
      (unavailableReasonCounts[change.unavailableReason] ?? 0) + 1
  }
  logger.info(
    {
      event: 'vision_input_filtered',
      protocol,
      provider: metadata.provider,
      requestedModel: metadata.requestedModel,
      actualModel: metadata.actualModel,
      supportsVision: false,
      outcome,
      removedImageCount: result.removedImageCount,
      affectedMessageCount: result.affectedMessageCount,
      fallbackNoticeCount: result.fallbackNoticeCount,
      storedArtifactCount,
      unavailableArtifactCount: fallbackChanges.length - storedArtifactCount,
      ...(Object.keys(unavailableReasonCounts).length === 0 ? {} : { unavailableReasonCounts }),
      changes,
    },
    'vision input filtered',
  )
}

function createUnavailableReplacements(
  candidates: readonly VisionToolResultImageCandidate[],
  reason: VisionArtifactUnavailableReason,
): Map<string, VisionToolResultReplacement> {
  return new Map(
    candidates.map((candidate) => [
      candidate.path,
      createVisionToolResultReplacement({
        path: candidate.path,
        status: 'unavailable',
        reason,
      }),
    ]),
  )
}

function logVisionArtifactErrors(
  logger: Logger,
  metadata: ProtocolRequestMetadata,
  protocol: VisionInputProtocol,
  errors: readonly VisionArtifactPersistenceError[],
): void {
  for (const error of errors) {
    logger.error(
      {
        event: 'vision_artifact_persistence_failed',
        phase: error.phase,
        err: error.err,
        protocol,
        provider: metadata.provider,
        requestedModel: metadata.requestedModel,
        actualModel: metadata.actualModel,
      },
      'vision artifact persistence failed',
    )
  }
}

function createStoredOrUnavailableReplacements(
  candidates: readonly VisionToolResultImageCandidate[],
  batch: VisionArtifactBatchResult,
): {
  replacements: Map<string, VisionToolResultReplacement>
  invariantErrors: VisionArtifactPersistenceError[]
} {
  const replacements = new Map<string, VisionToolResultReplacement>()
  const invariantErrors: VisionArtifactPersistenceError[] = []
  for (const candidate of candidates) {
    const result = batch.results.get(candidate.path)
    if (result !== undefined) {
      replacements.set(candidate.path, createVisionToolResultReplacement(result))
      continue
    }

    const err = new Error(`Vision artifact store omitted result for ${candidate.path}`)
    invariantErrors.push({ phase: 'vision_artifact_persist', err })
    replacements.set(
      candidate.path,
      createVisionToolResultReplacement({
        path: candidate.path,
        status: 'unavailable',
        reason: 'storage_error',
      }),
    )
  }
  return { replacements, invariantErrors }
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
  telemetry: RequestTelemetryContext
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
    telemetry,
    executionOverride,
  } = opts
  const { formatErrors } = strategy

  const acquireRoutedStream = () =>
    acquireStream({
      gateway: runtime.gateway,
      model,
      callInput,
      requestModel,
      plugins: route.plugins,
      timeoutMs: runtime.requestTimeoutMs,
      abortController,
      formatErrors,
      inspectCtx,
      telemetry,
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
    let acquired: AcquireStreamResult
    try {
      acquired = await acquireRoutedStream()
    } catch (error) {
      return handleUpstreamError(error, formatErrors, loginUrl, 'stream', logger, {
        errorLogger: runtime.errorLogger,
        requestMetadata,
        request,
        response: [],
        telemetry,
      })
    }
    if ('rateLimitResponse' in acquired) {
      setOutcome(telemetry, 'rate_limited', true)
      telemetry.failureLogged = true
      logger.warn(
        {
          phase: 'stream',
          provider: telemetry.provider,
          requestedModel: telemetry.requestedModel,
          actualModel: telemetry.actualModel,
          keySelection: telemetry.keySelection,
        },
        'upstream request rate limited',
      )
      const { body, status } = acquired.rateLimitResponse
      return jsonResponse(body, status)
    }

    let buffer: unknown[] = []
    const observedStream = observeTerminalParts(acquired.stream, telemetry, logger, (error) => {
      writeProtocolErrorLog(
        runtime.errorLogger,
        requestMetadata,
        telemetry,
        error,
        'stream',
        request,
        buffer,
      )
    })
    const buffered = bufferStreamForErrorLogging(
      observedStream,
      runtime.errorLogging.enabled,
      runtime.errorLogging.maxBodyLength,
    )
    buffer = buffered.buffer
    let preparedStreamResponse: Awaited<ReturnType<typeof prepareStreamResponseHeaders>>
    try {
      preparedStreamResponse = await prepareStreamResponseHeaders(
        buffered.stream,
        executionOverride?.streamResponseHeaders,
      )
    } catch (error) {
      if (telemetry.explicitFailure) {
        return handleUpstreamError(error, formatErrors, loginUrl, 'stream', logger, {
          errorLogger: runtime.errorLogger,
          requestMetadata,
          request,
          response: buffer,
          telemetry,
        })
      }
      markInternalFailure(telemetry, error)
      throw error
    }
    setUpstreamRequestIdFromHeaders(telemetry, preparedStreamResponse.headers)

    let renderedStream: ReturnType<typeof renderStreamSSE>
    try {
      renderedStream = renderStreamSSE({
        ...withEnrichment({ model: requestModel, stream: preparedStreamResponse.stream }),
      })
    } catch (error) {
      markInternalFailure(telemetry, error)
      throw error
    }

    return new Response(
      readableStreamFromAsyncIterable(
        renderedStream,
        (error) => {
          if (!telemetry.explicitFailure) markInternalFailure(telemetry, error)
          if (!telemetry.failureLogged) {
            telemetry.failureLogged = true
            logger.error(
              {
                err: normalizeErrorForLog(error),
                phase: 'stream-render',
                provider: telemetry.provider,
                requestedModel: telemetry.requestedModel,
                actualModel: telemetry.actualModel,
                executionMode: telemetry.executionMode,
                keySelection: telemetry.keySelection,
              },
              'stream rendering failed',
            )
          }
        },
        abortController,
        (error) => {
          logger.error(
            {
              err: normalizeErrorForLog(error),
              phase: 'stream-cancel',
              provider: telemetry.provider,
              requestedModel: telemetry.requestedModel,
              actualModel: telemetry.actualModel,
              executionMode: telemetry.executionMode,
              keySelection: telemetry.keySelection,
            },
            'stream cancellation cleanup failed',
          )
        },
      ),
      {
        headers: preparedStreamResponse.headers,
      },
    )
  }

  // streamOnly: provider 仅支持流式 API，内部走 stream + 收集
  if (route.streamOnly) {
    let buffer: unknown[] = []
    const upstreamStartedAt = performance.now()
    let acquired: AcquireStreamResult
    try {
      acquired = await acquireRoutedStream()
    } catch (error) {
      telemetry.upstreamDurationMs = Math.round(performance.now() - upstreamStartedAt)
      return handleUpstreamError(error, formatErrors, loginUrl, 'stream-only', logger, {
        errorLogger: runtime.errorLogger,
        requestMetadata,
        request,
        response: buffer,
        telemetry,
      })
    }
    if ('rateLimitResponse' in acquired) {
      setOutcome(telemetry, 'rate_limited', true)
      telemetry.failureLogged = true
      logger.warn(
        {
          phase: 'stream-only',
          provider: telemetry.provider,
          requestedModel: telemetry.requestedModel,
          actualModel: telemetry.actualModel,
          keySelection: telemetry.keySelection,
        },
        'upstream request rate limited',
      )
      telemetry.upstreamDurationMs = Math.round(performance.now() - upstreamStartedAt)
      const { body, status } = acquired.rateLimitResponse
      return jsonResponse(body, status)
    }

    let collected: Awaited<ReturnType<typeof collectStreamResult>>
    try {
      const buffered = bufferStreamForErrorLogging(
        observeTerminalParts(acquired.stream, telemetry, logger, (error) => {
          writeProtocolErrorLog(
            runtime.errorLogger,
            requestMetadata,
            telemetry,
            error,
            'stream-only',
            request,
            buffer,
          )
        }),
        runtime.errorLogging.enabled,
        runtime.errorLogging.maxBodyLength,
      )
      buffer = buffered.buffer
      collected = await withRequestTimeout(
        collectStreamResult(buffered.stream),
        runtime.requestTimeoutMs,
        abortController,
      )
      telemetry.upstreamDurationMs = Math.round(performance.now() - acquired.upstreamStartedAt)
    } catch (error) {
      telemetry.upstreamDurationMs ??= Math.round(performance.now() - upstreamStartedAt)
      return handleUpstreamError(error, formatErrors, loginUrl, 'stream-only', logger, {
        errorLogger: runtime.errorLogger,
        requestMetadata,
        request,
        response: buffer,
        telemetry,
      })
    }
    if (collected.finishReason !== undefined) telemetry.finishReason = collected.finishReason
    applyUsage(telemetry, collected.usage)
    setUpstreamRequestId(telemetry, collected.response?.id)
    const renderInput: Parameters<typeof strategy.renderResult>[0] = withEnrichment({
      model: requestModel,
      text: collected.text,
      finishReason: collected.finishReason,
      ...(collected.response && { response: collected.response }),
      ...(collected.toolCalls && { toolCalls: collected.toolCalls }),
    })
    if (collected.usage) renderInput.usage = collected.usage
    try {
      return jsonResponse(renderResult(renderInput))
    } catch (error) {
      markInternalFailure(telemetry, error)
      throw error
    }
  }

  // 正常非流式路径
  const upstreamStartedAt = performance.now()
  const generateInput: Parameters<ModelGateway['generate']>[0] = {
    model,
    callInput,
    requestModel,
    abortSignal: abortController.signal,
  }
  if (executionOverride?.generateOptions !== undefined) {
    generateInput.options = executionOverride.generateOptions
  }
  let result: Awaited<ReturnType<ModelGateway['generate']>>
  try {
    result = await withRequestTimeout(
      runtime.gateway.generate(generateInput),
      runtime.requestTimeoutMs,
      abortController,
    )
    telemetry.upstreamDurationMs = Math.round(performance.now() - upstreamStartedAt)
  } catch (error) {
    telemetry.upstreamDurationMs ??= Math.round(performance.now() - upstreamStartedAt)
    return handleUpstreamError(error, formatErrors, loginUrl, 'generate', logger, {
      errorLogger: runtime.errorLogger,
      requestMetadata,
      request,
      response: null,
      telemetry,
    })
  }
  telemetry.finishReason = result.finishReason
  applyUsage(telemetry, result.usage ? flattenUsage(result.usage) : undefined)
  setUpstreamRequestId(telemetry, result.response?.id)
  setOutcome(telemetry, 'success')
  const renderInput: Parameters<typeof strategy.renderResult>[0] = withEnrichment({
    model: requestModel,
    text: result.text,
    finishReason: result.finishReason,
    response: result.response,
    toolCalls: result.toolCalls,
  })
  if (result.usage) renderInput.usage = flattenUsage(result.usage)

  let renderedResult: ReturnType<typeof renderResult>
  let responseHeaders: HeadersInit | undefined
  try {
    renderedResult = renderResult(renderInput)
    responseHeaders = executionOverride?.responseHeaders?.(renderInput)
  } catch (error) {
    markInternalFailure(telemetry, error)
    throw error
  }
  if (responseHeaders !== undefined) {
    const headers = new Headers(responseHeaders)
    setUpstreamRequestIdFromHeaders(telemetry, headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    return new Response(JSON.stringify(renderedResult), { headers })
  }
  return jsonResponse(renderedResult)
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
  const telemetry = requestScope.telemetry

  // 1. Validate request（缓存原始 body 供 passthrough 透传字节级一致）
  let request: TRequest
  let rawBody: unknown
  try {
    rawBody = await requestScope.readJson()
    request = strategy.validate(rawBody)
  } catch (error) {
    setOutcome(telemetry, 'validation_error', true)
    requestScope.logger.warn(
      { err: normalizeValidationErrorForLog(error), phase: 'validation' },
      'request validation failed',
    )
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
      setOutcome(telemetry, 'routing_error', true)
      requestScope.logger.warn(
        { err: error, phase: 'routing', requestedModel: requestModel },
        'request routing failed',
      )
      const { body, status } = formatErrors.routing(error)
      return jsonResponse(body, status)
    }
    throw error
  }

  telemetry.provider = route.providerName
  telemetry.requestedModel = requestModel
  telemetry.actualModel = route.upstreamModel
  const requestMetadata: ProtocolRequestMetadata = {
    requestId: requestScope.requestId,
    provider: route.providerName,
    requestedModel: requestModel,
    actualModel: route.upstreamModel,
  }

  const routeModel = route.provider.models[route.modelKey]!
  const supportsVision = resolveModelSupportsVision(route.provider, routeModel)
  const visionInputFilter = getVisionInputFilterCapability(strategy)
  let rawBodyWasTransformed = false
  if (!supportsVision && visionInputFilter !== undefined) {
    const plan = visionInputFilter.planUnsupportedVisionInput(rawBody)
    if (plan.imageCount > 0) {
      let replacements: Map<string, VisionToolResultReplacement>
      if (plan.rejection === 'unsupported_vision_input') {
        replacements = createUnavailableReplacements(plan.toolResultImages, 'request_rejected')
      } else {
        let batch: VisionArtifactBatchResult
        try {
          batch = await ctx.visionArtifactStore.persistBatch(plan.toolResultImages)
        } catch (err) {
          batch = {
            results: new Map(
              plan.toolResultImages.map((candidate) => [
                candidate.path,
                {
                  path: candidate.path,
                  status: 'unavailable' as const,
                  reason: 'storage_error' as const,
                },
              ]),
            ),
            errors: [{ phase: 'vision_artifact_persist', err }],
          }
        }
        logVisionArtifactErrors(
          requestScope.logger,
          requestMetadata,
          visionInputFilter.visionInputProtocol,
          batch.errors,
        )
        const converted = createStoredOrUnavailableReplacements(plan.toolResultImages, batch)
        logVisionArtifactErrors(
          requestScope.logger,
          requestMetadata,
          visionInputFilter.visionInputProtocol,
          converted.invariantErrors,
        )
        replacements = converted.replacements
      }

      let transform: VisionInputTransformResult
      try {
        transform = visionInputFilter.applyUnsupportedVisionInput(plan, replacements)
      } catch (err) {
        requestScope.logger.error(
          {
            event: 'vision_transform_apply_failed',
            phase: 'vision-transform-apply',
            err,
            protocol: visionInputFilter.visionInputProtocol,
            provider: route.providerName,
            requestedModel: requestModel,
            actualModel: route.upstreamModel,
            imageCount: plan.imageCount,
            toolResultImageCount: plan.toolResultImages.length,
          },
          'vision request transform failed',
        )
        const { body, status } = formatErrors.internal()
        return jsonResponse(body, status)
      }

      rawBody = transform.body
      if (transform.rejection === 'unsupported_vision_input') {
        logVisionInputMutation(
          requestScope.logger,
          requestMetadata,
          visionInputFilter.visionInputProtocol,
          transform,
          'rejected',
        )
        const { body, status } = formatErrors.unsupportedVisionInput()
        return jsonResponse(body, status)
      }

      try {
        request = strategy.validate(rawBody)
      } catch (err) {
        logVisionInputMutation(
          requestScope.logger,
          requestMetadata,
          visionInputFilter.visionInputProtocol,
          transform,
          'internal_error',
        )
        const issues =
          typeof err === 'object' && err !== null && 'issues' in err
            ? (err as { issues?: unknown }).issues
            : undefined
        requestScope.logger.error(
          {
            event: 'vision_transform_validation_failed',
            phase: 'vision-transform-validation',
            err,
            ...(issues !== undefined ? { issues } : {}),
            protocol: visionInputFilter.visionInputProtocol,
            provider: route.providerName,
            requestedModel: requestModel,
            actualModel: route.upstreamModel,
            removedImageCount: transform.removedImageCount,
            affectedMessageCount: transform.affectedMessageCount,
            fallbackNoticeCount: transform.fallbackNoticeCount,
          },
          'vision-transformed request validation failed',
        )
        const { body, status } = formatErrors.internal()
        return jsonResponse(body, status)
      }

      rawBodyWasTransformed = transform.changes.length > 0
      if (rawBodyWasTransformed) {
        logVisionInputMutation(
          requestScope.logger,
          requestMetadata,
          visionInputFilter.visionInputProtocol,
          transform,
          'forwarded',
        )
      }
    }
  }

  const loginUrl = buildOAuthLoginUrl(ctx.settings, route.providerName)
  const providerType = route.provider.type

  // 3. Prepare execution override（例如 openai-responses + openai 上游的 AI SDK raw renderer）
  const abortController = new AbortController()
  const executionOverride = getExecutionOverrideCapability(strategy)?.prepareExecution({
    providerType,
    rawBody,
    rawBodyWasTransformed,
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
      telemetry.keySelection = {
        index: modelResult.keySelection.index,
        count: modelResult.keySelection.count,
      }
    }
    requestScope.logger.info(
      {
        provider: route.providerName,
        requestModel,
        upstreamModel: route.upstreamModel,
        requestedModel: requestModel,
        actualModel: route.upstreamModel,
        keySelection: telemetry.keySelection,
      },
      'request.route_resolved',
    )
  } catch (error) {
    if (error instanceof OAuthError && error.code === 'auth_required') {
      setOutcome(telemetry, 'auth_required', true)
      requestScope.logger.warn(
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
    abortSignal: abortController.signal,
    onCleanupError: (error) => {
      requestScope.logger.error(
        {
          err: normalizeErrorForLog(error),
          phase: telemetry.executionMode,
          provider: route.providerName,
          requestedModel: requestModel,
          actualModel: route.upstreamModel,
          keySelection: telemetry.keySelection,
        },
        'stream cancellation cleanup failed',
      )
    },
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
  telemetry.executionMode = strategy.isStream(request)
    ? 'stream'
    : executionRoute.streamOnly
      ? 'stream-only'
      : 'generate'

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
    telemetry,
    ...(executionOverride !== undefined ? { executionOverride } : {}),
  })
}

interface ErrorLogContext {
  errorLogger: ErrorLogger
  requestMetadata: ProtocolRequestMetadata
  request: unknown
  response: unknown[] | null
  telemetry: RequestTelemetryContext
}

function writeProtocolErrorLog(
  errorLogger: ErrorLogger,
  metadata: ProtocolRequestMetadata,
  telemetry: RequestTelemetryContext,
  error: unknown,
  phase: ErrorPhase,
  request: unknown,
  response: unknown[] | null,
): void {
  if (telemetry.ndjsonWritten) return
  telemetry.ndjsonWritten = true
  errorLogger.log({
    requestId: metadata.requestId,
    phase,
    provider: metadata.provider,
    requestedModel: metadata.requestedModel,
    actualModel: metadata.actualModel,
    ...(telemetry.keySelection !== undefined && { keySelection: telemetry.keySelection }),
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
  errorLogCtx: ErrorLogContext,
): Response {
  const failure = classifyUpstreamFailure(error)
  applyUpstreamFailure(errorLogCtx.telemetry, failure)
  logUpstreamFailureOnce(logger, errorLogCtx.telemetry, failure, phase, phase === 'stream')

  if (shouldWriteErrorPreview(failure.outcome)) {
    writeProtocolErrorLog(
      errorLogCtx.errorLogger,
      errorLogCtx.requestMetadata,
      errorLogCtx.telemetry,
      error,
      phase,
      errorLogCtx.request,
      errorLogCtx.response,
    )
  }

  if (failure.outcome === 'auth_required') {
    const message = error instanceof OAuthError ? error.message : 'OAuth login required'
    const { body, status } = formatErrors.oauth(message, loginUrl)
    return jsonResponse(body, status)
  }
  if (failure.outcome === 'rate_limited') {
    const { body, status } = formatErrors.rateLimit(
      {
        error: {
          type: failure.error.upstreamErrorType ?? 'rate_limit_error',
          code: failure.error.upstreamErrorCode ?? 'rate_limit_exceeded',
          message: 'Upstream provider rate limit exceeded',
        },
      },
      429,
    )
    return jsonResponse(body, status)
  }
  if (failure.outcome === 'timeout') {
    const { body, status } = formatErrors.timeout()
    return jsonResponse(body, status)
  }
  const { body, status } = formatErrors.upstream()
  return jsonResponse(body, status)
}
