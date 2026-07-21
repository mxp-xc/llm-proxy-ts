import { Hono } from 'hono'
import type { Settings, OAuthConfig } from '../../config.js'
import type { TokenManager } from '../../oauth/token-manager.js'
import { isRecord } from '../../providers/protocol-types.js'
import { noopLogger, type Logger } from '../../types.js'
import type { AppEnv } from '../types.js'
import { buildOAuthCallbackUrl } from './urls.js'

/**
 * OAuth 回调路由的依赖项。
 */
export interface OAuthCallbackDeps {
  settings: Settings
  tokenManager: TokenManager
  nonce: string
  logger?: Logger
}

/**
 * 创建 OAuth 回调 Hono 子路由。
 *
 * - GET /oauth/login/:provider — 重定向到授权 URL
 * - GET /oauth/callback — 接收授权码，交换 token
 */
export function createOAuthCallbackApp(deps: OAuthCallbackDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const { settings, tokenManager, nonce, logger = noopLogger } = deps

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
    const state = encodeState(providerName, nonce)
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

    if (error) {
      const errorCode = /^[a-zA-Z0-9_.-]{1,128}$/.test(error) ? error : 'provider_error'
      log.warn({ errorCode }, 'oauth.callback.rejected')
      return c.html(renderErrorPage(error, c.req.query('error_description') ?? ''))
    }

    if (!code || !stateParam) {
      log.warn({ hasCode: Boolean(code), hasState: Boolean(stateParam) }, 'oauth.callback.invalid')
      return c.html(renderErrorPage('invalid_request', 'Missing code or state parameter'))
    }

    const decoded = decodeState(stateParam)
    if (!decoded || decoded.nonce !== nonce) {
      log.warn({ reason: 'invalid_state' }, 'oauth.callback.invalid')
      return c.html(renderErrorPage('invalid_state', 'Invalid state parameter — possible CSRF'))
    }

    const providerName = decoded.provider
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
    const redirectUri = buildOAuthCallbackUrl(settings, oauth)

    try {
      await tokenManager.exchangeCode(providerName, oauth, code, redirectUri)
      log.info({ provider: providerName }, 'oauth.callback.succeeded')
      return c.html(renderSuccessPage(providerName))
    } catch (err) {
      log.error({ err, provider: providerName }, 'oauth.callback.failed')
      return c.html(
        renderErrorPage('exchange_failed', 'OAuth token exchange failed. Check server logs.'),
      )
    }
  })

  return app
}

/**
 * 编码 state 参数（base64url JSON）。
 */
function encodeState(provider: string, nonce: string): string {
  const json = JSON.stringify({ provider, nonce })
  return Buffer.from(json, 'utf8').toString('base64url')
}

interface DecodedState {
  provider: string
  nonce: string
}

function isDecodedState(value: unknown): value is DecodedState {
  return (
    isRecord(value) && typeof value['provider'] === 'string' && typeof value['nonce'] === 'string'
  )
}

/**
 * 解码 state 参数。
 */
function decodeState(state: string): DecodedState | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'))
    return isDecodedState(parsed) ? parsed : null
  } catch {
    return null
  }
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
