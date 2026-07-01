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
import { RequestTimeoutError, withRequestTimeout } from './stream-utils.js'
import { inspectFirstStreamChunk, type StreamInspectContext } from './stream-inspect.js'
import { readableStreamFromAsyncIterable } from './stream-utils.js'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'

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

export async function handleProtocolRequest<TRequest, TSSEData, TResult>(
  c: Context<AppEnv>,
  strategy: ProtocolStrategy<TRequest, TSSEData, TResult>,
  ctx: ProtocolContext,
): Promise<Response> {
  const { formatErrors } = strategy

  // 1. Validate request
  let request: TRequest
  try {
    request = strategy.validate(await c.req.json())
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

  // 3. Map to AI SDK input
  const callInput = strategy.mapToAISDKInput(request, { providerType: route.provider.type })
  // 3.1 Collect declared custom grammar tool names for renderer discrimination
  // (openai-responses only; other strategies don't implement getCustomToolNames)
  const customToolNames = strategy.getCustomToolNames?.(request)
  const customToolShimmed = customToolNames !== undefined && route.provider.type !== 'openai'
  const toolSearchShimmed =
    route.provider.type !== 'openai' && (strategy.getHasClientToolSearch?.(request) ?? false)
  const namespaceFlatMap = strategy.getNamespaceFlatMap?.(request)

  // 4. Get LanguageModel
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
  const abortController = new AbortController()
  const inspectCtx: StreamInspectContext = {
    requestId: c.get('requestId'),
    settings: ctx.settings,
    provider: { id: route.providerName, provider: route.provider },
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
      return new Response(
        readableStreamFromAsyncIterable(
          strategy.renderStreamSSE({
            model: requestModel,
            stream: acquired.stream,
            ...(customToolNames && { customToolNames }),
            ...(customToolShimmed && { customToolShimmed }),
            ...(toolSearchShimmed && { toolSearchShimmed }),
            ...(namespaceFlatMap && { namespaceFlatMap }),
          }),
          (error) => {
            reqLogger.error({ err: error }, 'stream consumption failed')
          },
          abortController,
        ),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    } catch (error) {
      return handleUpstreamError(c, error, formatErrors, loginUrl, 'stream')
    }
  }

  // streamOnly: provider 仅支持流式 API，内部走 stream + 收集
  if (route.provider.options?.streamOnly) {
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
      const collected = await withRequestTimeout(
        collectStreamResult(acquired.stream),
        ctx.settings.requestTimeoutMs,
        abortController,
      )
      const renderInput: Parameters<typeof strategy.renderResult>[0] = {
        model: requestModel,
        text: collected.text,
        finishReason: collected.finishReason,
        ...(collected.response && { response: collected.response }),
        ...(collected.toolCalls && { toolCalls: collected.toolCalls }),
      }
      if (collected.usage) renderInput.usage = collected.usage
      if (customToolNames) renderInput.customToolNames = customToolNames
      if (customToolShimmed) renderInput.customToolShimmed = customToolShimmed
      if (toolSearchShimmed) renderInput.toolSearchShimmed = toolSearchShimmed
      if (namespaceFlatMap) renderInput.namespaceFlatMap = namespaceFlatMap
      return c.json(strategy.renderResult(renderInput))
    } catch (error) {
      return handleUpstreamError(c, error, formatErrors, loginUrl, 'stream-only')
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
    }
    if (result.usage) renderInput.usage = flattenUsage(result.usage)
    if (customToolNames) renderInput.customToolNames = customToolNames
    if (customToolShimmed) renderInput.customToolShimmed = customToolShimmed
    if (toolSearchShimmed) renderInput.toolSearchShimmed = toolSearchShimmed
    if (namespaceFlatMap) renderInput.namespaceFlatMap = namespaceFlatMap
    return c.json(strategy.renderResult(renderInput))
  } catch (error) {
    return handleUpstreamError(c, error, formatErrors, loginUrl, 'generate')
  }
}

export type ErrorPhase = 'stream' | 'stream-only' | 'generate'

export function handleUpstreamError(
  c: Context<AppEnv>,
  error: unknown,
  formatErrors: ProtocolErrorFormatter,
  loginUrl: string,
  phase: ErrorPhase,
): Response {
  c.get('logger').error({ err: error, phase }, 'upstream request failed')
  if (error instanceof OAuthError && error.code === 'auth_required') {
    const { body, status } = formatErrors.oauth(error.message, loginUrl)
    return c.json(body, status as 503)
  }
  if (error instanceof RequestTimeoutError) {
    const { body, status } = formatErrors.timeout()
    return c.json(body, status as 504)
  }
  const { body, status } = formatErrors.upstream()
  return c.json(body, status as 502)
}
