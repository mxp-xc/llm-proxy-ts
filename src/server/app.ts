import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { Settings, TokenManager, AuthStatus } from '../index.js'
import {
  listModels,
  RoutingTable,
  openaiCompatibleStrategy,
  openaiResponsesStrategy,
  anthropicStrategy,
} from '../index.js'
import { noopLogger, type Logger } from '../types.js'
import { createOAuthCallbackApp } from './oauth/callback.js'
import { createCodexApp } from './codex.js'
import { CodexCatalogCache } from '../codex-catalog.js'
import type { ProviderAuthStatus } from './oauth/startup.js'
import { handleProtocolRequest } from './handle-protocol.js'
import type { ProtocolContext } from './handle-protocol.js'
import { createProtocolRequestScope } from './hono-protocol-adapter.js'
import { defaultGateway } from './gateway.js'
import { ErrorLogger, normalizeErrorForLog } from './error-logger.js'
import type {
  ModelGateway,
  AppDependencies,
  AppEnv,
  RequestOutcome,
  RequestTelemetryContext,
} from './types.js'
import { VisionArtifactStore } from './vision-artifact-store.js'

export type { Settings } from '../index.js'
export type { ModelGateway, AppDependencies, AppEnv } from './types.js'
export { handleProtocolRequest, type ProtocolContext } from './handle-protocol.js'
export { defaultGateway } from './gateway.js'

interface HealthResponse {
  status: 'ok'
  service: string
  providersConfigured: number
  auth?: Record<string, { status: string; loginUrl?: string | undefined }>
}

function wrapStreamWithTerminalLog<T>(
  body: ReadableStream<T>,
  telemetry: RequestTelemetryContext,
  logger: Logger,
  logCompleted: () => void,
): ReadableStream<T> {
  const reader = body.getReader()
  let logged = false
  let cancelled = false
  const logOnce = () => {
    if (logged) return
    logged = true
    logCompleted()
  }

  return new ReadableStream<T>({
    async pull(controller) {
      if (cancelled) return
      try {
        const { done, value } = await reader.read()
        if (cancelled || controller.desiredSize === null) return
        if (done) {
          logOnce()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (err) {
        if (cancelled) return
        if (!telemetry.explicitFailure) {
          telemetry.outcome = 'internal_error'
          telemetry.explicitFailure = true
          telemetry.terminalPart = 'error'
        }
        telemetry.terminalError = err instanceof Error ? err.name : 'Error'
        if (!telemetry.failureLogged) {
          telemetry.failureLogged = true
          logger.error(
            {
              err: normalizeErrorForLog(err),
              phase: 'stream-consume',
              provider: telemetry.provider,
              requestedModel: telemetry.requestedModel,
              actualModel: telemetry.actualModel,
              executionMode: telemetry.executionMode,
              keySelection: telemetry.keySelection,
            },
            'stream response consumption failed',
          )
        }
        logOnce()
        controller.error(err)
      }
    },
    async cancel(reason) {
      cancelled = true
      if (!telemetry.explicitFailure) {
        telemetry.outcome = 'client_cancelled'
        telemetry.explicitFailure = true
      }
      try {
        await reader.cancel(reason)
      } catch (err) {
        logger.error(
          {
            err: normalizeErrorForLog(err),
            phase: 'stream-cancel',
            provider: telemetry.provider,
            requestedModel: telemetry.requestedModel,
            actualModel: telemetry.actualModel,
            executionMode: telemetry.executionMode,
            keySelection: telemetry.keySelection,
          },
          'stream cancellation cleanup failed',
        )
      } finally {
        logOnce()
      }
    },
  })
}

export function createApp({
  settings,
  tokenManager,
  logger = noopLogger,
  providerRegistry,
  gateway = defaultGateway,
  nonce,
  getAuthStatuses,
  pluginRegistry,
  codexCatalogCache,
  errorLogger,
  errorLogDir = 'logs',
  visionArtifactStore,
}: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const routingTable = RoutingTable.fromSettings(settings, pluginRegistry)

  const protocolCtx: ProtocolContext = {
    routingTable,
    settings,
    gateway,
    providerRegistry,
    visionArtifactStore:
      visionArtifactStore ?? new VisionArtifactStore(settings.visionFallback?.toolResultArtifacts),
    errorLogger:
      errorLogger ??
      new ErrorLogger({
        logDir: errorLogDir,
        enabled: settings.errorLogging.enabled,
        maxBodyLength: settings.errorLogging.maxBodyLength,
        logger,
      }),
  }

  // settings 不可变(无 hot-reload),listModels 结果仅依赖 settings。
  // createApp 作用域一次性预构建,后续 /v1/models + /v1/models/* 请求直接查缓存。
  // modelsById 直接复用 modelsList 已产出的同一批 OpenAIModel 对象,避免重复枚举。
  const modelsList = listModels(settings)
  const modelsById = new Map(modelsList.data.map((m) => [m.id, m]))

  app.use('*', async (c, next) => {
    const id = randomUUID()
    c.set('requestId', id)
    const reqLogger = logger.child({ requestId: id })
    c.set('logger', reqLogger)
    const telemetry: RequestTelemetryContext = {
      requestId: id,
      startedAt: performance.now(),
      method: c.req.method,
      path: c.req.path,
      ndjsonWritten: false,
      completed: false,
    }
    c.set('requestLogContext', telemetry)
    const isHealth = c.req.path === '/health'
    if (!isHealth) {
      reqLogger.info({ method: telemetry.method, path: telemetry.path }, 'request.received')
    }

    await next()

    // SSE 流式响应的 body 是 ReadableStream，await next() 在 Response 创建时就 resolve，
    // 流尚未被消费。用 TransformStream 包裹 body，在 flush（流结束）时才记 completed。
    // 非 SSE 响应（c.json 等）虽然 body 也是 ReadableStream，但 await next() 已等完整响应，
    // 无需延迟。
    const logCompleted = () => {
      if (telemetry.completed) return
      telemetry.completed = true
      telemetry.status = c.res.status
      telemetry.outcome ??= outcomeFromStatus(telemetry.status)
      if (isHealth && telemetry.outcome === 'success') return
      if (isHealth) {
        reqLogger.info({ method: telemetry.method, path: telemetry.path }, 'request.received')
      }
      writeCompletedLog(reqLogger, telemetry)
    }

    const isSSE = c.res.headers.get('content-type')?.includes('text/event-stream')
    if (isSSE && c.res.body instanceof ReadableStream) {
      const body = c.res.body
      c.res = new Response(wrapStreamWithTerminalLog(body, telemetry, reqLogger, logCompleted), {
        status: c.res.status,
        statusText: c.res.statusText,
        headers: c.res.headers,
      })
    } else {
      logCompleted()
    }
    c.header('x-request-id', id)
  })

  // 挂载 OAuth 回调路由。必须位于 request middleware 之后,确保 /oauth 也有 requestId/logger。
  if (tokenManager && nonce) {
    const oauthApp = createOAuthCallbackApp({ settings, tokenManager, nonce, logger })
    app.route('/oauth', oauthApp)
  }

  app.onError((err, c) => {
    const reqLogger = c.get('logger') ?? logger
    const requestLogContext = c.get('requestLogContext')
    if (requestLogContext) {
      if (!requestLogContext.explicitFailure) {
        requestLogContext.outcome = 'internal_error'
        requestLogContext.explicitFailure = true
      }
      requestLogContext.terminalError = err.name
      requestLogContext.failureLogged = true
    }
    reqLogger.error(
      {
        err: normalizeErrorForLog(err),
        method: c.req.method,
        path: c.req.path,
        provider: requestLogContext?.provider,
        requestedModel: requestLogContext?.requestedModel,
        actualModel: requestLogContext?.actualModel,
        keySelection: requestLogContext?.keySelection,
      },
      'request failed',
    )
    return c.json(
      {
        error: {
          type: 'internal_error',
          code: 'internal_server_error',
          message: 'Internal server error',
        },
      },
      500,
    )
  })

  app.get('/health', (c) => {
    const base: HealthResponse = {
      status: 'ok',
      service: settings.service.name,
      providersConfigured: Object.keys(settings.providers).length,
    }

    const authStatuses = getAuthStatuses?.() ?? []
    if (authStatuses.length > 0) {
      base.auth = Object.fromEntries(
        authStatuses.map((s) => [
          s.provider,
          s.status === 'valid' ? { status: s.status } : { status: s.status, loginUrl: s.loginUrl },
        ]),
      )
    }

    return c.json(base)
  })

  app.get('/v1/models', (c) => c.json(modelsList))

  app.get('/v1/models/*', (c) => {
    const modelId = c.req.path.replace('/v1/models/', '')
    if (!modelId) {
      return c.json(
        { error: { type: 'invalid_request_error', message: 'Model ID is required' } },
        400,
      )
    }
    // modelsById 已覆盖 enumerateModelEntries 产出的全部 id,与 getModel 等价,无需 fallback。
    const model = modelsById.get(modelId)
    if (!model) {
      return c.json(
        { error: { type: 'invalid_request_error', message: `Model '${modelId}' not found` } },
        404,
      )
    }
    return c.json(model)
  })

  app.post('/v1/chat/completions', (c) =>
    handleProtocolRequest(createProtocolRequestScope(c), openaiCompatibleStrategy, protocolCtx),
  )
  app.post('/v1/messages', (c) =>
    handleProtocolRequest(createProtocolRequestScope(c), anthropicStrategy, protocolCtx),
  )
  app.post('/v1/responses', (c) =>
    handleProtocolRequest(createProtocolRequestScope(c), openaiResponsesStrategy, protocolCtx),
  )

  // 进程级共享 cache(等价原模块级单例),在 createApp 作用域 new 一次,绝不在 per-request 路径 new
  const catalogCache = codexCatalogCache ?? new CodexCatalogCache()
  app.route('/codex', createCodexApp({ settings, protocolCtx, catalogCache }))

  return app
}

function outcomeFromStatus(status: number): RequestOutcome {
  if (status < 400) return 'success'
  if (status < 500) return 'client_error'
  return 'internal_error'
}

function writeCompletedLog(logger: Logger, telemetry: RequestTelemetryContext): void {
  const fields = {
    method: telemetry.method,
    path: telemetry.path,
    status: telemetry.status,
    outcome: telemetry.outcome,
    durationMs: Math.round(performance.now() - telemetry.startedAt),
    provider: telemetry.provider,
    requestedModel: telemetry.requestedModel,
    actualModel: telemetry.actualModel,
    executionMode: telemetry.executionMode,
    keySelection: telemetry.keySelection,
    finishReason: telemetry.finishReason,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    totalTokens: telemetry.totalTokens,
    cacheReadTokens: telemetry.cacheReadTokens,
    reasoningTokens: telemetry.reasoningTokens,
    upstreamRequestId: telemetry.upstreamRequestId,
    upstreamDurationMs: telemetry.upstreamDurationMs,
    firstChunkMs: telemetry.firstChunkMs,
    terminalPart: telemetry.terminalPart,
  }
  logger.info(fields, 'request.completed')
}
