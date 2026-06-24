import { Hono } from 'hono'
import type { Settings, TokenManager, AuthStatus } from '../index.js'
import {
  OAuthError,
  getModel,
  listModels,
  RoutingError,
  RoutingTable,
  openaiCompatibleStrategy,
  openaiResponsesStrategy,
  anthropicStrategy,
} from '../index.js'
import type { ProviderRegistry, PluginRegistry, KeySelection } from '../index.js'
import pino from 'pino'
import { logger as defaultLogger, requestId } from './logging.js'
import { createOAuthCallbackApp } from './oauth/callback.js'
import { createCodexApp } from './codex.js'
import type { ProviderAuthStatus } from './oauth/startup.js'
import { handleProtocolRequest } from './handle-protocol.js'
import type { ProtocolContext } from './handle-protocol.js'
import { defaultGateway } from './gateway.js'
import type { ModelGateway, AppDependencies, AppEnv } from './types.js'

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
  codexCatalogFetcher,
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
    c: import('hono').Context<AppEnv>,
  ): import('ai').LanguageModel {
    const result = resolvedRegistry.languageModel(providerName, upstreamModel, headers)
    if (result.keySelection) {
      c.set('keySelection', result.keySelection)
    }
    return result.model
  }

  const protocolCtx: ProtocolContext = {
    routingTable,
    settings,
    gateway,
    resolveModel,
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
    const base: HealthResponse = {
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

  app.post('/v1/chat/completions', (c) =>
    handleProtocolRequest(c, openaiCompatibleStrategy, protocolCtx),
  )
  app.post('/v1/messages', (c) =>
    handleProtocolRequest(c, anthropicStrategy, protocolCtx),
  )
  app.post('/v1/responses', (c) =>
    handleProtocolRequest(c, openaiResponsesStrategy, protocolCtx),
  )

  app.route('/codex', createCodexApp({ settings, protocolCtx, codexCatalogFetcher }))

  return app
}
