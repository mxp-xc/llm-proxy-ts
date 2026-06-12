import { generateText, streamText } from 'ai'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Settings, TokenManager, AuthStatus } from '@llm-proxy/core'
import {
  OAuthError,
  getModel,
  listModels,
  RoutingError,
  RoutingTable,
  openaiCompatibleStrategy,
  openaiResponsesStrategy,
  anthropicStrategy,
} from '@llm-proxy/core'
import type { ProviderRegistry, PluginRegistry, ProxyPlugin, PluginResponse, KeySelection, ProtocolStrategy, ProtocolErrorFormatter } from '@llm-proxy/core'
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

  // ─── Generic protocol request handler ─────────────────────────────

  async function handleProtocolRequest<TRequest>(
    c: import('hono').Context<AppEnv>,
    strategy: ProtocolStrategy<TRequest>,
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
      route = routingTable.resolve(requestModel)
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
    const callInput = strategy.mapToAISDKInput(request, route.providerName)

    // 4. Get LanguageModel
    const loginUrl = `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`
    let model
    try {
      model = resolveModel(route.providerName, route.upstreamModel, route.headers, c)
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
        const stream = gateway.stream({
          model,
          callInput,
          requestModel,
          abortSignal: abortController.signal,
        })
        const inspection = await withRequestTimeout(
          inspectFirstStreamChunk(route.resolvedPlugins, stream),
          settings.requestTimeoutMs,
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

    try {
      const result = await withRequestTimeout(
        gateway.generate({
          model,
          callInput,
          requestModel,
          abortSignal: abortController.signal,
        }),
        settings.requestTimeoutMs,
        abortController,
      )
      return c.json(
        strategy.renderResult({
          model: requestModel,
          text: result.text,
          finishReason: result.finishReason,
          usage: result.usage,
          response: result.response,
          toolCalls: result.toolCalls,
        }),
      )
    } catch (error) {
      return handleUpstreamError(c, error, formatErrors, loginUrl, 'generation request failed')
    }
  }

  function handleUpstreamError(
    c: import('hono').Context<AppEnv>,
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

  app.post('/v1/chat/completions', (c) =>
    handleProtocolRequest(c, openaiCompatibleStrategy),
  )
  app.post('/v1/messages', (c) =>
    handleProtocolRequest(c, anthropicStrategy),
  )
  app.post('/v1/responses', (c) =>
    handleProtocolRequest(c, openaiResponsesStrategy),
  )

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
