import type { LanguageModel } from 'ai'
import type { Context } from 'hono'
import { OAuthError, RoutingError } from '../index.js'
import type { ProtocolStrategy, ProtocolErrorFormatter } from '../index.js'
import { flattenUsage, collectStreamResult } from '../index.js'
import type { Settings, RoutingTable } from '../index.js'
import type { AppEnv, ModelGateway } from './types.js'
import { RequestTimeoutError, withRequestTimeout } from './stream-utils.js'
import { inspectFirstStreamChunk } from './stream-inspect.js'
import { readableStreamFromAsyncIterable } from './stream-utils.js'

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

export async function handleProtocolRequest<TRequest>(
  c: Context<AppEnv>,
  strategy: ProtocolStrategy<TRequest>,
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

  // 3. Map to AI SDK input
  const callInput = strategy.mapToAISDKInput(request)

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

  // 5-6. Stream or generate + render
  if (strategy.isStream(request)) {
    try {
      const stream = ctx.gateway.stream({
        model,
        callInput,
        requestModel,
        abortSignal: abortController.signal,
      })
      const inspection = await withRequestTimeout(
        inspectFirstStreamChunk(route.resolvedPlugins, stream),
        ctx.settings.requestTimeoutMs,
        abortController,
      )
      if (inspection.error) {
        const { body, status } = formatErrors.rateLimit(
          inspection.error.body,
          inspection.error.status,
        )
        return c.json(body, status as 429)
      }
      const reqLogger = c.get('logger')
      return new Response(
        readableStreamFromAsyncIterable(
          strategy.renderStreamSSE({ model: requestModel, stream: inspection.stream }),
          (error) => {
            reqLogger.error({ err: error }, 'stream consumption failed')
          },
        ),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    } catch (error) {
      return handleUpstreamError(c, error, formatErrors, loginUrl, 'stream request failed')
    }
  }

  // streamOnly: provider 仅支持流式 API，内部走 stream + 收集
  if (route.provider.options?.streamOnly) {
    try {
      const rawStream = ctx.gateway.stream({
        model,
        callInput,
        requestModel,
        abortSignal: abortController.signal,
      })
      const inspection = await withRequestTimeout(
        inspectFirstStreamChunk(route.resolvedPlugins, rawStream),
        ctx.settings.requestTimeoutMs,
        abortController,
      )
      if (inspection.error) {
        const { body, status } = formatErrors.rateLimit(
          inspection.error.body,
          inspection.error.status,
        )
        return c.json(body, status as 429)
      }
      const collected = await withRequestTimeout(
        collectStreamResult(inspection.stream),
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
      return c.json(strategy.renderResult(renderInput))
    } catch (error) {
      return handleUpstreamError(c, error, formatErrors, loginUrl, 'generation request failed')
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
    return c.json(strategy.renderResult(renderInput))
  } catch (error) {
    return handleUpstreamError(c, error, formatErrors, loginUrl, 'generation request failed')
  }
}

export function handleUpstreamError(
  c: Context<AppEnv>,
  error: unknown,
  formatErrors: ProtocolErrorFormatter,
  loginUrl: string,
  logMessage: string,
): Response {
  c.get('logger').error({ err: error }, logMessage)
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
