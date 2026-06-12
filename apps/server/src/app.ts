import { generateText, streamText } from 'ai'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Settings, TokenManager, AuthStatus } from '@llm-proxy/core'
import {
  OAuthError,
  mapOpenAIChatRequestToAISDKInput,
  validateOpenAIChatRequest,
  renderOpenAIChatCompletion,
  renderOpenAIChatCompletionSSE,
  mapAnthropicMessagesRequestToAISDKInput,
  validateAnthropicMessagesRequest,
  renderAnthropicMessage,
  renderAnthropicMessageSSE,
  getModel,
  listModels,
  RoutingError,
  RoutingTable,
  mapResponsesRequestToAISDKInput,
  validateOpenAIResponsesRequest,
  renderOpenAIResponse,
  renderOpenAIResponseSSE,
} from '@llm-proxy/core'
import type { ProviderRegistry, PluginRegistry, ProxyPlugin, PluginResponse, KeySelection } from '@llm-proxy/core'
import pino from 'pino'
import { logger as defaultLogger, requestId } from './logging.js'
import { createOAuthCallbackApp } from './oauth/callback.js'
import type { ProviderAuthStatus } from './oauth/startup.js'

export type { Settings } from '@llm-proxy/core'

export interface ModelGateway {
  generate(input: {
    model: unknown
    callInput: any
    requestModel: string
    abortSignal?: AbortSignal
  }): Promise<any>
  stream(input: {
    model: unknown
    callInput: any
    requestModel: string
    abortSignal?: AbortSignal
  }): AsyncIterable<unknown>
}

export interface AppDependencies {
  settings: Settings
  providerRegistry?: ProviderRegistry
  gateway?: ModelGateway
  logger?: pino.Logger
  tokenManager?: TokenManager
  nonce?: string
  authStatuses?: ProviderAuthStatus[]
  pluginRegistry?: PluginRegistry
  authFilePath?: string
}

type AppEnv = {
  Variables: {
    requestId: string
    logger: pino.Logger
    requestedModel?: string
    actualModel?: string
    provider?: string
    keySelection?: KeySelection
  }
}

export function createApp({
  settings,
  tokenManager,
  logger = defaultLogger,
  providerRegistry,
  gateway = defaultGateway,
  nonce,
  authStatuses,
  pluginRegistry,
  authFilePath,
}: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const routingTable = RoutingTable.fromSettings(settings, pluginRegistry)
  if (!providerRegistry) {
    throw new Error(
      'providerRegistry is required — construct it with createProviderRegistry() before calling createApp()',
    )
  }
  const resolvedRegistry = providerRegistry

  function resolveModel(
    providerName: string,
    upstreamModel: string,
    headers: Record<string, string>,
    c: Context<AppEnv>,
  ) {
    const result = resolvedRegistry.languageModel(providerName, upstreamModel, headers)
    if (result.keySelection) {
      c.set('keySelection', result.keySelection)
    }
    return result.model
  }

  // 挂载 OAuth 回调路由
  if (tokenManager && nonce) {
    const oauthApp = createOAuthCallbackApp({ settings, tokenManager, nonce })
    app.route('/oauth', oauthApp)
  }

  app.use('*', async (c, next) => {
    const id = requestId()
    c.set('requestId', id)
    const reqLogger = logger.child({ requestId: id })
    c.set('logger', reqLogger)

    reqLogger.info({ method: c.req.method, path: c.req.path }, 'request started')

    const start = performance.now()
    await next()

    const duration = performance.now() - start
    reqLogger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(duration),
        provider: c.get('provider'),
        requestedModel: c.get('requestedModel'),
        actualModel: c.get('actualModel'),
        keySelection: c.get('keySelection'),
      },
      'request completed',
    )
    c.header('x-request-id', id)
  })

  app.get('/health', (c) => {
    const base: Record<string, unknown> = {
      status: 'ok',
      service: settings.service.name,
      providersConfigured: Object.keys(settings.providers).length,
    }

    if (authStatuses && authStatuses.length > 0) {
      base.auth = Object.fromEntries(
        authStatuses.map((s) => [
          s.provider,
          s.status === 'valid' ? { status: s.status } : { status: s.status, loginUrl: s.loginUrl },
        ]),
      )
    }

    return c.json(base)
  })

  app.get('/v1/models', (c) => c.json(listModels(settings)))

  app.get('/v1/models/*', (c) => {
    const modelId = c.req.path.replace('/v1/models/', '')
    if (!modelId) {
      return c.json(
        { error: { type: 'invalid_request_error', message: 'Model ID is required' } },
        400,
      )
    }
    const model = getModel(settings, modelId)
    if (!model) {
      return c.json(
        { error: { type: 'invalid_request_error', message: `Model '${modelId}' not found` } },
        404,
      )
    }
    return c.json(model)
  })

  app.post('/v1/chat/completions', async (c) => {
    let request
    try {
      request = validateOpenAIChatRequest(await c.req.json())
    } catch {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            code: 'invalid_request',
            message: 'Invalid OpenAI chat completion request',
          },
        },
        400,
      )
    }

    let route
    try {
      route = routingTable.resolve(request.model)
    } catch (error) {
      if (error instanceof RoutingError) {
        return c.json(error.toResponse(), error.status as 404)
      }
      throw error
    }

    c.set('provider', route.providerName)
    c.set('requestedModel', request.model)
    c.set('actualModel', route.upstreamModel)

    const callInput = mapOpenAIChatRequestToAISDKInput(request, route.providerName)
    let model
    try {
      model = resolveModel(route.providerName, route.upstreamModel, route.headers, c)
    } catch (error) {
      if (error instanceof OAuthError && error.code === 'auth_required') {
        return c.json(
          {
            error: {
              type: 'auth_required',
              code: 'oauth_login_needed',
              message: error.message,
              loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
            },
          },
          503,
        )
      }
      throw error
    }
    const abortController = new AbortController()

    if (request.stream) {
      try {
        const stream = gateway.stream({
          model,
          callInput,
          requestModel: request.model,
          abortSignal: abortController.signal,
        })
        const inspection = await withRequestTimeout(
          inspectFirstStreamChunk(route.resolvedPlugins, stream),
          settings.requestTimeoutMs,
          abortController,
        )
        if (inspection.error) {
          return c.json(inspection.error.body, inspection.error.status as 429)
        }
        const reqLogger = c.get('logger')
        return new Response(
          readableStreamFromAsyncIterable(
            renderOpenAIChatCompletionSSE({ model: request.model, stream: inspection.stream }),
            (error) => {
              reqLogger.error({ err: error }, 'stream consumption failed')
            },
          ),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      } catch (error) {
        c.get('logger').error({ err: error }, 'stream request failed')
        if (error instanceof OAuthError && error.code === 'auth_required') {
          return c.json(
            {
              error: {
                type: 'auth_required',
                code: 'oauth_login_needed',
                message: error.message,
                loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
              },
            },
            503,
          )
        }
        if (error instanceof RequestTimeoutError) {
          return upstreamTimeoutResponse()
        }
        return upstreamErrorResponse()
      }
    }

    try {
      const result = await withRequestTimeout(
        gateway.generate({
          model,
          callInput,
          requestModel: request.model,
          abortSignal: abortController.signal,
        }),
        settings.requestTimeoutMs,
        abortController,
      )
      return c.json(
        renderOpenAIChatCompletion({
          model: request.model,
          text: result.text,
          finishReason: result.finishReason,
          usage: result.usage,
          response: result.response,
          toolCalls: result.toolCalls,
        }),
      )
    } catch (error) {
      c.get('logger').error({ err: error }, 'generation request failed')
      if (error instanceof OAuthError && error.code === 'auth_required') {
        return c.json(
          {
            error: {
              type: 'auth_required',
              code: 'oauth_login_needed',
              message: error.message,
              loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
            },
          },
          503,
        )
      }
      if (error instanceof RequestTimeoutError) {
        return upstreamTimeoutResponse()
      }
      return upstreamErrorResponse()
    }
  })

  // ─── Anthropic Messages API ──────────────────────────────────────

  app.post('/v1/messages', async (c) => {
    let request
    try {
      request = validateAnthropicMessagesRequest(await c.req.json())
    } catch {
      return c.json(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Invalid Anthropic Messages request' },
        },
        400,
      )
    }

    let route
    try {
      route = routingTable.resolve(request.model)
    } catch (error) {
      if (error instanceof RoutingError) {
        return c.json(
          {
            type: 'error',
            error: {
              type: 'not_found_error',
              message: error.toResponse().error?.message ?? 'Model not found',
            },
          },
          error.status as 404,
        )
      }
      throw error
    }

    c.set('provider', route.providerName)
    c.set('requestedModel', request.model)
    c.set('actualModel', route.upstreamModel)

    const callInput = mapAnthropicMessagesRequestToAISDKInput(request, route.providerName)
    let model
    try {
      model = resolveModel(route.providerName, route.upstreamModel, route.headers, c)
    } catch (error) {
      if (error instanceof OAuthError && error.code === 'auth_required') {
        return c.json(
          {
            type: 'error',
            error: {
              type: 'authentication_error',
              message: error.message,
              loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
            },
          },
          503,
        )
      }
      throw error
    }
    const abortController = new AbortController()

    if (request.stream) {
      try {
        const stream = gateway.stream({
          model,
          callInput,
          requestModel: request.model,
          abortSignal: abortController.signal,
        })
        const inspection = await withRequestTimeout(
          inspectFirstStreamChunk(route.resolvedPlugins, stream),
          settings.requestTimeoutMs,
          abortController,
        )
        if (inspection.error) {
          return c.json(
            {
              type: 'error',
              error: { type: 'rate_limit_error', message: JSON.stringify(inspection.error.body) },
            },
            inspection.error.status as 429,
          )
        }
        const reqLogger = c.get('logger')
        return new Response(
          readableStreamFromAsyncIterable(
            renderAnthropicMessageSSE({ model: request.model, stream: inspection.stream }),
            (error) => {
              reqLogger.error({ err: error }, 'stream consumption failed')
            },
          ),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      } catch (error) {
        c.get('logger').error({ err: error }, 'stream request failed')
        if (error instanceof OAuthError && error.code === 'auth_required') {
          return c.json(
            {
              type: 'error',
              error: {
                type: 'authentication_error',
                message: error.message,
                loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
              },
            },
            503,
          )
        }
        if (error instanceof RequestTimeoutError) {
          return anthropicTimeoutResponse()
        }
        return anthropicErrorResponse()
      }
    }

    try {
      const result = await withRequestTimeout(
        gateway.generate({
          model,
          callInput,
          requestModel: request.model,
          abortSignal: abortController.signal,
        }),
        settings.requestTimeoutMs,
        abortController,
      )
      return c.json(
        renderAnthropicMessage({
          model: request.model,
          text: result.text,
          finishReason: result.finishReason,
          usage: result.usage,
          response: result.response,
          toolCalls: result.toolCalls,
        }),
      )
    } catch (error) {
      c.get('logger').error({ err: error }, 'generation request failed')
      if (error instanceof OAuthError && error.code === 'auth_required') {
        return c.json(
          {
            type: 'error',
            error: {
              type: 'authentication_error',
              message: error.message,
              loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
            },
          },
          503,
        )
      }
      if (error instanceof RequestTimeoutError) {
        return anthropicTimeoutResponse()
      }
      return anthropicErrorResponse()
    }
  })

  // ─── OpenAI Responses API ───────────────────────────────────

  app.post('/v1/responses', async (c) => {
    let request
    try {
      request = validateOpenAIResponsesRequest(await c.req.json())
    } catch {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            code: 'invalid_request',
            message: 'Invalid OpenAI Responses request',
          },
        },
        400,
      )
    }

    let route
    try {
      route = routingTable.resolve(request.model)
    } catch (error) {
      if (error instanceof RoutingError) {
        return c.json(error.toResponse(), error.status as 404)
      }
      throw error
    }

    c.set('provider', route.providerName)
    c.set('requestedModel', request.model)
    c.set('actualModel', route.upstreamModel)

    const callInput = mapResponsesRequestToAISDKInput(request, route.providerName)
    let model
    try {
      model = resolveModel(route.providerName, route.upstreamModel, route.headers, c)
    } catch (error) {
      if (error instanceof OAuthError && error.code === 'auth_required') {
        return c.json(
          {
            error: {
              type: 'auth_required',
              code: 'oauth_login_needed',
              message: error.message,
              loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
            },
          },
          503,
        )
      }
      throw error
    }
    const abortController = new AbortController()

    if (request.stream) {
      try {
        const stream = gateway.stream({
          model,
          callInput,
          requestModel: request.model,
          abortSignal: abortController.signal,
        })
        const inspection = await withRequestTimeout(
          inspectFirstStreamChunk(route.resolvedPlugins, stream),
          settings.requestTimeoutMs,
          abortController,
        )
        if (inspection.error) {
          return c.json(inspection.error.body, inspection.error.status as 429)
        }
        const reqLogger = c.get('logger')
        return new Response(
          readableStreamFromAsyncIterable(
            renderOpenAIResponseSSE({ model: request.model, stream: inspection.stream }),
            (error) => {
              reqLogger.error({ err: error }, 'stream consumption failed')
            },
          ),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      } catch (error) {
        c.get('logger').error({ err: error }, 'stream request failed')
        if (error instanceof OAuthError && error.code === 'auth_required') {
          return c.json(
            {
              error: {
                type: 'auth_required',
                code: 'oauth_login_needed',
                message: error.message,
                loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
              },
            },
            503,
          )
        }
        if (error instanceof RequestTimeoutError) {
          return upstreamTimeoutResponse()
        }
        return upstreamErrorResponse()
      }
    }

    try {
      const result = await withRequestTimeout(
        gateway.generate({
          model,
          callInput,
          requestModel: request.model,
          abortSignal: abortController.signal,
        }),
        settings.requestTimeoutMs,
        abortController,
      )
      return c.json(
        renderOpenAIResponse({
          model: request.model,
          text: result.text,
          finishReason: result.finishReason,
          usage: result.usage,
          response: result.response,
          toolCalls: result.toolCalls,
        }),
      )
    } catch (error) {
      c.get('logger').error({ err: error }, 'generation request failed')
      if (error instanceof OAuthError && error.code === 'auth_required') {
        return c.json(
          {
            error: {
              type: 'auth_required',
              code: 'oauth_login_needed',
              message: error.message,
              loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
            },
          },
          503,
        )
      }
      if (error instanceof RequestTimeoutError) {
        return upstreamTimeoutResponse()
      }
      return upstreamErrorResponse()
    }
  })

  return app
}

const defaultGateway: ModelGateway = {
  async generate({ model, callInput, abortSignal }) {
    return generateText({ model, ...callInput, abortSignal } as Parameters<typeof generateText>[0])
  },
  stream({ model, callInput, abortSignal }) {
    return streamText({
      model,
      ...callInput,
      abortSignal,
      // AI SDK streamText 抑制异常并整合到 fullStream 中作为 { type: 'error' } chunk。
      // onError 仅是日志回调，不改变流行为；error chunk 会经过插件检查流程。
      onError: ({ error }) => {
        defaultLogger.error({ err: error }, 'stream error from AI SDK')
      },
    } as Parameters<typeof streamText>[0])
      .fullStream as AsyncIterable<unknown>
  },
}

class RequestTimeoutError extends Error {
  constructor() {
    super('Request timed out')
  }
}

async function withRequestTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      abortController.abort()
      reject(new RequestTimeoutError())
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

function upstreamTimeoutResponse(): Response {
  return Response.json(
    {
      error: {
        type: 'upstream_error',
        code: 'upstream_request_timeout',
        message: 'Upstream provider request timed out',
      },
    },
    { status: 504 },
  )
}

function upstreamErrorResponse(): Response {
  return Response.json(
    {
      error: {
        type: 'upstream_error',
        code: 'upstream_request_failed',
        message: 'Upstream provider request failed',
      },
    },
    { status: 502 },
  )
}

// ─── Anthropic-style error responses ────────────────────────────────

function anthropicTimeoutResponse(): Response {
  return Response.json(
    {
      type: 'error',
      error: { type: 'timeout_error', message: 'Upstream provider request timed out' },
    },
    { status: 504 },
  )
}

function anthropicErrorResponse(): Response {
  return Response.json(
    { type: 'error', error: { type: 'api_error', message: 'Upstream provider request failed' } },
    { status: 502 },
  )
}

// ─── Stream inspection (generic dispatch) ─────────────────────────

import type { ResolvedPlugin } from '@llm-proxy/core'

async function inspectFirstStreamChunk(plugins: ResolvedPlugin[], stream: AsyncIterable<unknown>) {
  const inspectors = plugins.filter(
    (rp) => typeof (rp.plugin as ProxyPlugin).inspectStreamChunk === 'function',
  )

  const iterator = stream[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) {
    return { stream: replayStream(undefined, iterator, plugins) }
  }

  if (inspectors.length > 0) {
    for (const rp of inspectors) {
      const result = await (rp.plugin as ProxyPlugin).inspectStreamChunk!({
        requestId: '',
        settings: {} as Settings,
        provider: { id: '', provider: {} as any },
        config: rp.config,
        chunk: first.value,
      })
      if (result && typeof result === 'object' && 'status' in result) {
        return {
          error: result as PluginResponse,
          stream: replayStream(undefined, iterator, plugins),
        }
      }
    }
  }

  return { stream: replayStream(first.value, iterator, plugins) }
}

async function* replayStream(
  first: unknown,
  iterator: AsyncIterator<unknown>,
  plugins: ResolvedPlugin[] = [],
): AsyncIterable<unknown> {
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
  chunk: unknown,
): Promise<PluginResponse | undefined> {
  for (const rp of plugins) {
    if (typeof (rp.plugin as ProxyPlugin).inspectStreamChunk !== 'function') continue
    const result = await (rp.plugin as ProxyPlugin).inspectStreamChunk!({
      requestId: '',
      settings: {} as Settings,
      provider: { id: '', provider: {} as any },
      config: rp.config,
      chunk,
    })
    if (result && typeof result === 'object' && 'status' in result) {
      return result as PluginResponse
    }
  }
  return undefined
}

function readableStreamFromAsyncIterable(
  iterable: AsyncIterable<Uint8Array>,
  onError: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) {
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        onError(error)
        controller.error(error)
      }
    },
  })
}
