import { Hono } from 'hono'
import type { Settings, OAuthConfig } from '@llm-proxy/core'
import type { TokenManager } from '@llm-proxy/core'

/**
 * OAuth 回调路由的依赖项。
 */
export interface OAuthCallbackDeps {
  settings: Settings
  tokenManager: TokenManager
  nonce: string
}

/**
 * 创建 OAuth 回调 Hono 子路由。
 *
 * - GET /oauth/login/:provider — 重定向到授权 URL
 * - GET /oauth/callback — 接收授权码，交换 token
 */
export function createOAuthCallbackApp(deps: OAuthCallbackDeps): Hono {
  const app = new Hono()
  const { settings, tokenManager, nonce } = deps

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

    const redirectUri =
      oauth.redirectUri ?? `http://127.0.0.1:${settings.service.port}/oauth/callback`
    const state = encodeState(providerName, nonce)
    const scope =
      oauth.scopes.length > 0 ? `&scope=${encodeURIComponent(oauth.scopes.join(' '))}` : ''

    const authUrl = `${oauth.authorizationUrl}?response_type=code&client_id=${encodeURIComponent(oauth.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}${scope}`

    return c.redirect(authUrl)
  })

  app.get('/callback', async (c) => {
    const code = c.req.query('code')
    const stateParam = c.req.query('state')
    const error = c.req.query('error')

    if (error) {
      return c.html(renderErrorPage(error, c.req.query('error_description') ?? ''))
    }

    if (!code || !stateParam) {
      return c.html(renderErrorPage('invalid_request', 'Missing code or state parameter'))
    }

    const decoded = decodeState(stateParam)
    if (!decoded || decoded.nonce !== nonce) {
      return c.html(renderErrorPage('invalid_state', 'Invalid state parameter — possible CSRF'))
    }

    const providerName = decoded.provider
    const provider = settings.providers[providerName]
    if (!provider?.oauth) {
      return c.html(
        renderErrorPage(
          'invalid_provider',
          `No OAuth configuration for provider '${providerName}'`,
        ),
      )
    }

    const oauth: OAuthConfig = provider.oauth
    const redirectUri =
      oauth.redirectUri ?? `http://127.0.0.1:${settings.service.port}/oauth/callback`

    try {
      await tokenManager.exchangeCode(providerName, oauth, code, redirectUri)
      return c.html(renderSuccessPage(providerName))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.html(renderErrorPage('exchange_failed', message))
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

/**
 * 解码 state 参数。
 */
function decodeState(state: string): DecodedState | null {
  try {
    const json = Buffer.from(state, 'base64url').toString('utf8')
    const parsed = JSON.parse(json) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'provider' in parsed &&
      'nonce' in parsed &&
      typeof (parsed as Record<string, unknown>)['provider'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['nonce'] === 'string'
    ) {
      return parsed as DecodedState
    }
    return null
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
