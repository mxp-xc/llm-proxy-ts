import type { LanguageModel } from 'ai'
import type { Context } from 'hono'
import { OAuthError } from '../oauth/types.js'
import { RoutingError } from '../routing.js'
import { flattenUsage } from '../providers/shared/renderer-utils.js'
import { collectStreamResult } from '../providers/shared/stream-collector.js'
import type { ProtocolStrategy } from '../providers/shared/strategy.js'
import type { ProtocolErrorFormatter } from '../providers/shared/error-format.js'
import type { AISDKInput } from '../providers/shared/aisdk-types.js'
import type { Settings } from '../config.js'
import type { RoutingTable } from '../routing.js'
import type { ResolvedPlugin } from '../plugins/registry.js'
import type { AppEnv, ModelGateway } from './types.js'
import type { KeySelection } from '../providers/registry.js'
import { RequestTimeoutError, withRequestTimeout } from './stream-utils.js'
import { inspectFirstStreamChunk, type StreamInspectContext } from './stream-inspect.js'
import { readableStreamFromAsyncIterable } from './stream-utils.js'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import { type ErrorLogger, type ErrorPhase, normalizeErrorForLog } from './error-logger.js'

export interface ProtocolContext {
  routingTable: RoutingTable
  settings: Settings
  gateway: ModelGateway
  resolveModel: (
    providerName: string,
    upstreamModel: string,
    headers: Record<string, string>,
    c: Context<AppEnv>,
  ) => LanguageModel
  /** 选 API key（复用 registry 轮询状态），供 passthrough 透传注入 Authorization */
  selectApiKey: (
    providerName: string,
  ) => { apiKey: string | undefined; keySelection?: KeySelection }
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

interface ExecuteUpstreamOptions<TRequest, TSSEData, TResult> {
  c: Context<AppEnv>
  strategy: ProtocolStrategy<TRequest, TSSEData, TResult>
  ctx: ProtocolContext
  route: ReturnType<RoutingTable['resolve']>
  model: LanguageModel
  callInput: AISDKInput
  requestModel: string
  request: TRequest
  enrichment: Record<string, unknown> | undefined
  loginUrl: string
  abortController: AbortController
  inspectCtx: StreamInspectContext
}

async function executeUpstream<TRequest, TSSEData, TResult>(
  opts: ExecuteUpstreamOptions<TRequest, TSSEData, TResult>,
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

  const logUpstreamError = (error: unknown, phase: ErrorPhase, response: unknown[] | null) => {
    ctx.errorLogger.log({
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

  // 5-6. Stream or generate + render
  if (strategy.isStream(request)) {
    try {
      const acquired = await acquireStream({
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
      if ('rateLimitResponse' in acquired) {
        const { body, status } = acquired.rateLimitResponse
        return c.json(body, status as 429)
      }
      const reqLogger = c.get('logger')
      const enabled = ctx.settings.errorLogging.enabled
      const buffer: ProxyStreamPart[] = []
      const teedStream = enabled
        ? (async function* () {
            for await (const part of acquired.stream) {
              buffer.push(part)
              yield part
            }
          })()
        : acquired.stream
      return new Response(
        readableStreamFromAsyncIterable(
          strategy.renderStreamSSE({
            model: requestModel,
            stream: teedStream,
            ...enrichment,
          }),
          (error) => {
            reqLogger.error({ err: error }, 'stream consumption failed')
            logUpstreamError(error, 'stream', enabled ? buffer : [])
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
    const buffer: ProxyStreamPart[] = []
    try {
      const acquired = await acquireStream({
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
      if ('rateLimitResponse' in acquired) {
        const { body, status } = acquired.rateLimitResponse
        return c.json(body, status as 429)
      }
      const teedStream = enabled
        ? (async function* () {
            for await (const part of acquired.stream) {
              buffer.push(part)
              yield part
            }
          })()
        : acquired.stream
      const collected = await withRequestTimeout(
        collectStreamResult(teedStream),
        ctx.settings.requestTimeoutMs,
        abortController,
      )
      const renderInput: Parameters<typeof strategy.renderResult>[0] = {
        model: requestModel,
        text: collected.text,
        finishReason: collected.finishReason,
        ...(collected.response && { response: collected.response }),
        ...(collected.toolCalls && { toolCalls: collected.toolCalls }),
        ...enrichment,
      }
      if (collected.usage) renderInput.usage = collected.usage
      return c.json(strategy.renderResult(renderInput))
    } catch (error) {
      return handleUpstreamError(c, error, formatErrors, loginUrl, 'stream-only', {
        errorLogger: ctx.errorLogger,
        request,
        response: enabled ? buffer : [],
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
    const renderInput: Parameters<typeof strategy.renderResult>[0] = {
      model: requestModel,
      text: result.text,
      finishReason: result.finishReason,
      response: result.response,
      toolCalls: result.toolCalls,
      ...enrichment,
    }
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

export async function handleProtocolRequest<TRequest, TSSEData, TResult>(
  c: Context<AppEnv>,
  strategy: ProtocolStrategy<TRequest, TSSEData, TResult>,
  ctx: ProtocolContext,
): Promise<Response> {
  const { formatErrors } = strategy

  // 1. Validate request（缓存原始 body 供 passthrough 透传字节级一致）
  let request: TRequest
  let rawBody: unknown
  try {
    rawBody = await c.req.json()
    request = strategy.validate(rawBody)
  } catch {
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

  // 3. passthrough 直通转发（openai 上游 + openai-responses 时绕过 AI SDK，字节级一致）
  const abortController = new AbortController()
  if (strategy.passthrough) {
    const passthroughResp = await strategy.passthrough({
      c,
      route,
      request,
      rawBody,
      upstreamModel: route.upstreamModel,
      settings: ctx.settings,
      selectApiKey: ctx.selectApiKey,
      abortController,
    })
    if (passthroughResp) return passthroughResp
  }

  // 4. Map to AI SDK input + compute strategy-local enrichment
  const callInput = strategy.mapToAISDKInput(request, route.provider.type)
  const enrichment = strategy.prepareEnrichment?.(request, route.provider.type)

  // 5. Get LanguageModel + delegate execution to executeUpstream
  const loginUrl = `http://127.0.0.1:${ctx.settings.service.port}/oauth/login/${route.providerName}`
  let model
  try {
    model = ctx.resolveModel(route.providerName, route.upstreamModel, route.headers, c)
  } catch (error) {
    if (error instanceof OAuthError && error.code === 'auth_required') {
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
    errorLogCtx.errorLogger.log({
      requestId: c.get('requestId'),
      phase,
      provider: c.get('provider') ?? '',
      requestedModel: c.get('requestedModel') ?? '',
      actualModel: c.get('actualModel') ?? '',
      error: normalizeErrorForLog(error),
      request: errorLogCtx.request,
      response: errorLogCtx.response,
    })
  }
  if (error instanceof RequestTimeoutError) {
    const { body, status } = formatErrors.timeout()
    return c.json(body, status as 504)
  }
  const { body, status } = formatErrors.upstream()
  return c.json(body, status as 502)
}
