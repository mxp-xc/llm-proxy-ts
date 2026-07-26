import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Settings, OAuthConfig } from '../../config.js'
import type { TokenManager } from '../../oauth/token-manager.js'
import { noopLogger, type Logger } from '../../types.js'
import type { AppEnv } from '../types.js'
import { buildOAuthCallbackUrl } from './urls.js'

/**
 * OAuth 回调路由的依赖项。
 */
export interface OAuthCallbackDeps {
  settings: Settings
  tokenManager: TokenManager
  logger?: Logger
  now?: () => number
  maxPendingStates?: number
}

const STATE_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_STATES = 256

/**
 * 创建 OAuth 回调 Hono 子路由。
 *
 * - GET /oauth/login/:provider — 重定向到授权 URL
 * - GET /oauth/callback — 接收授权码，交换 token
 */
export function createOAuthCallbackApp(deps: OAuthCallbackDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const {
    settings,
    tokenManager,
    logger = noopLogger,
    now = Date.now,
    maxPendingStates = MAX_PENDING_STATES,
  } = deps
  const pendingStates = new Map<string, { provider: string; expiresAt: number }>()

  if (
    !Number.isInteger(maxPendingStates) ||
    maxPendingStates < 1 ||
    maxPendingStates > MAX_PENDING_STATES
  ) {
    throw new RangeError(`maxPendingStates must be an integer between 1 and ${MAX_PENDING_STATES}`)
  }

  function removeExpiredPendingStates(currentTime: number): void {
    for (const [state, pending] of pendingStates) {
      if (pending.expiresAt <= currentTime) pendingStates.delete(state)
    }
  }

  function createPendingState(provider: string): string {
    const currentTime = now()
    removeExpiredPendingStates(currentTime)

    if (pendingStates.size >= maxPendingStates) {
      const oldestState = pendingStates.keys().next().value
      if (oldestState !== undefined) pendingStates.delete(oldestState)
    }

    const state = randomUUID()
    pendingStates.set(state, { provider, expiresAt: currentTime + STATE_TTL_MS })
    return state
  }

  function consumePendingState(state: string): { provider: string; expiresAt: number } | undefined {
    removeExpiredPendingStates(now())
    const pendingState = pendingStates.get(state)
    pendingStates.delete(state)
    return pendingState
  }

  app.get('/login/:provider', (c) => {
    const providerName = c.req.param('provider')
    const provider = settings.providers[providerName]

    if (!provider?.oauth) {
      return c.json(
        {
          error: {
            type: 'invalid_request',
            message: `No OAuth configuration for provider '${providerName}'`,
          },
        },
        404,
      )
    }

    const oauth = provider.oauth

    if (oauth.flow !== 'authorization_code') {
      return c.json(
        {
          error: {
            type: 'invalid_request',
            message: `Provider '${providerName}' does not use authorization_code flow`,
          },
        },
        400,
      )
    }

    if (!oauth.authorizationUrl) {
      return c.json(
        {
          error: {
            type: 'invalid_request',
            message: `Provider '${providerName}' missing authorizationUrl`,
          },
        },
        400,
      )
    }

    const redirectUri = buildOAuthCallbackUrl(settings, oauth)
    const state = createPendingState(providerName)
    const scope =
      oauth.scopes.length > 0 ? `&scope=${encodeURIComponent(oauth.scopes.join(' '))}` : ''

    const authUrl = `${oauth.authorizationUrl}?response_type=code&client_id=${encodeURIComponent(oauth.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}${scope}`

    return c.redirect(authUrl)
  })

  app.get('/callback', async (c) => {
    const log = c.get('logger') ?? logger
    const code = c.req.query('code')
    const stateParam = c.req.query('state')
    const error = c.req.query('error')

    if (!stateParam) {
      log.warn({ hasCode: Boolean(code), hasState: Boolean(stateParam) }, 'oauth.callback.invalid')
      return c.html(renderErrorPage('invalid_request', 'Missing code or state parameter'))
    }

    const pendingState = consumePendingState(stateParam)
    if (!pendingState) {
      log.warn({ reason: 'invalid_state' }, 'oauth.callback.invalid')
      return c.html(renderErrorPage('invalid_state', 'Invalid state parameter — possible CSRF'))
    }

    const providerName = pendingState.provider
    const provider = settings.providers[providerName]
    if (!provider?.oauth) {
      log.warn({ provider: providerName, reason: 'invalid_provider' }, 'oauth.callback.invalid')
      return c.html(
        renderErrorPage(
          'invalid_provider',
          `No OAuth configuration for provider '${providerName}'`,
        ),
      )
    }

    const oauth: OAuthConfig = provider.oauth

    if (error) {
      const errorCode = /^[a-zA-Z0-9_.-]{1,128}$/.test(error) ? error : 'provider_error'
      log.warn({ errorCode, provider: providerName }, 'oauth.callback.rejected')
      return c.html(renderErrorPage(errorCode, 'OAuth authorization was rejected by the provider.'))
    }

    if (!code) {
      log.warn({ hasCode: false, hasState: true }, 'oauth.callback.invalid')
      return c.html(renderErrorPage('invalid_request', 'Missing code or state parameter'))
    }

    const redirectUri = buildOAuthCallbackUrl(settings, oauth)
    const signal = c.get('abortController')?.signal ?? c.req.raw.signal

    try {
      await tokenManager.exchangeCode(providerName, oauth, code, redirectUri, signal)
      log.info({ provider: providerName }, 'oauth.callback.succeeded')
      return c.html(renderSuccessPage(providerName))
    } catch (err) {
      if (signal.aborted) {
        log.info({ err, provider: providerName }, 'oauth.callback.aborted')
        return c.html(renderErrorPage('exchange_failed', 'OAuth token exchange was cancelled.'))
      }
      log.error({ err, provider: providerName }, 'oauth.callback.failed')
      return c.html(
        renderErrorPage('exchange_failed', 'OAuth token exchange failed. Check server logs.'),
      )
    }
  })

  return app
}

function renderSuccessPage(providerName: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authentication Successful</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f4f8;color:#1a202c}
.card{text-align:center;padding:2rem 3rem;background:white;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{color:#38a169;font-size:1.5rem;margin-bottom:.5rem}p{color:#718096}</style></head>
<body><div class="card"><h1>✓ Authentication Successful</h1><p>Provider <strong>${escapeHtml(providerName)}</strong> is now authenticated.</p><p>You can close this tab.</p></div></body></html>`
}

function renderErrorPage(error: string, description: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authentication Failed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f4f8;color:#1a202c}
.card{text-align:center;padding:2rem 3rem;background:white;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h1{color:#e53e3e;font-size:1.5rem;margin-bottom:.5rem}p{color:#718096}code{background:#edf2f7;padding:2px 6px;border-radius:4px;font-size:.9em}</style></head>
<body><div class="card"><h1>✗ Authentication Failed</h1><p>Error: <code>${escapeHtml(error)}</code></p>${description ? `<p>${escapeHtml(description)}</p>` : ''}</div></body></html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
