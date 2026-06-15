import type { OAuthConfig } from '../config.js'
import type { AuthStatus, OAuthToken, TokenStore } from './types.js'
import { OAuthError } from './types.js'
import { loadAuthFile, extractTokenStore, saveAuthFile, mergeTokenStore } from './token-store.js'

/** Token 过期前的提前刷新余量（秒） */
const EXPIRY_MARGIN_SECONDS = 30

/**
 * 检查 token 是否仍然有效（未过期）。
 */
export function isTokenValid(token: OAuthToken): boolean {
  return token.expiresAt > Date.now() / 1000 + EXPIRY_MARGIN_SECONDS
}

/**
 * 判断 token 是否已过期（access_token 超出余量）。
 */
export function isTokenExpired(token: OAuthToken): boolean {
  return !isTokenValid(token)
}

/**
 * 分类 provider 的认证状态。
 */
export function classifyStatus(token: OAuthToken | undefined, config: OAuthConfig): AuthStatus {
  if (!token) {
    return config.flow === 'client_credentials' ? 'needs_refresh' : 'needs_login'
  }

  if (isTokenValid(token)) {
    return 'valid'
  }

  // access_token 过期
  if (config.flow === 'client_credentials') {
    return 'needs_refresh'
  }

  // authorization_code: 有 refreshToken 则可刷新
  if (token.refreshToken) {
    return 'needs_refresh'
  }

  return 'needs_login'
}

/**
 * 使用 refresh_token 刷新 access_token。
 */
export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  if (config.scopes.length > 0) {
    body.set('scope', config.scopes.join(' '))
  }

  try {
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new OAuthError(
        'refresh_failed',
        `Token refresh failed: HTTP ${response.status} ${text}`,
      )
    }

    return parseTokenResponse((await response.json()) as Record<string, unknown>)
  } catch (error) {
    if (error instanceof OAuthError) throw error
    throw new OAuthError('refresh_failed', `Token refresh failed: ${String(error)}`)
  }
}

/**
 * 使用 client_credentials 获取 token。
 */
export async function fetchClientCredentialsToken(config: OAuthConfig): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  if (config.scopes.length > 0) {
    body.set('scope', config.scopes.join(' '))
  }

  try {
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new OAuthError(
        'refresh_failed',
        `Client credentials token fetch failed: HTTP ${response.status} ${text}`,
      )
    }

    return parseTokenResponse((await response.json()) as Record<string, unknown>)
  } catch (error) {
    if (error instanceof OAuthError) throw error
    throw new OAuthError(
      'refresh_failed',
      `Client credentials token fetch failed: ${String(error)}`,
    )
  }
}

/**
 * 使用 authorization_code 交换 token。
 */
export async function exchangeAuthorizationCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
  })

  try {
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new OAuthError(
        'exchange_failed',
        `Authorization code exchange failed: HTTP ${response.status} ${text}`,
      )
    }

    return parseTokenResponse((await response.json()) as Record<string, unknown>)
  } catch (error) {
    if (error instanceof OAuthError) throw error
    throw new OAuthError('exchange_failed', `Authorization code exchange failed: ${String(error)}`)
  }
}

/**
 * 解析 OAuth token 端点的 JSON 响应。
 */
function parseTokenResponse(data: Record<string, unknown>): OAuthToken {
  const accessToken = data['access_token']
  const expiresIn = data['expires_in']
  const tokenType = data['token_type']
  const refreshToken = data['refresh_token']
  const scope = data['scope']

  if (typeof accessToken !== 'string') {
    throw new OAuthError('refresh_failed', 'Token response missing access_token')
  }

  if (typeof expiresIn !== 'number') {
    throw new OAuthError('refresh_failed', 'Token response missing expires_in')
  }

  return {
    accessToken,
    expiresAt: Date.now() / 1000 + expiresIn,
    tokenType: typeof tokenType === 'string' ? tokenType : 'Bearer',
    ...(typeof refreshToken === 'string' ? { refreshToken } : {}),
    ...(typeof scope === 'string' ? { scope } : {}),
  }
}

/**
 * Token 生命周期管理器。
 *
 * - 持有内存缓存 + 持久化到 auth.json
 * - 并发请求自动去重（同一 provider 同时只做一次刷新）
 */
export class TokenManager {
  private store: TokenStore = {}
  private refreshLocks = new Map<string, Promise<OAuthToken>>()

  constructor(private authFilePath: string) {}

  /**
   * 启动时从 auth.json 加载 token。
   */
  async load(): Promise<void> {
    const data = await loadAuthFile(this.authFilePath)
    this.store = extractTokenStore(data)
  }

  /**
   * 获取指定 provider 的认证状态。
   */
  getStatus(providerName: string, config: OAuthConfig): AuthStatus {
    return classifyStatus(this.store[providerName], config)
  }

  /**
   * 确保返回有效的 token。
   *
   * - 有效则直接返回
   * - 过期但有 refreshToken 则刷新
   * - client_credentials 则重新获取
   * - 否则抛出 OAuthError('auth_required')
   */
  async ensureValidToken(providerName: string, config: OAuthConfig): Promise<OAuthToken> {
    const token = this.store[providerName]

    // 有效 token 直接返回
    if (token && isTokenValid(token)) {
      return token
    }

    // 需要刷新 — 并发去重
    const existing = this.refreshLocks.get(providerName)
    if (existing) {
      return existing
    }

    const promise = this.doRefresh(providerName, config, token)
    this.refreshLocks.set(providerName, promise)

    try {
      return await promise
    } finally {
      this.refreshLocks.delete(providerName)
    }
  }

  /**
   * 使用 authorization_code 交换 token（回调端点调用）。
   */
  async exchangeCode(
    providerName: string,
    config: OAuthConfig,
    code: string,
    redirectUri: string,
  ): Promise<OAuthToken> {
    const token = await exchangeAuthorizationCode(config, code, redirectUri)
    this.store = { ...this.store, [providerName]: token }
    const data = await loadAuthFile(this.authFilePath)
    await saveAuthFile(this.authFilePath, mergeTokenStore(data, this.store))
    return token
  }

  private async doRefresh(
    providerName: string,
    config: OAuthConfig,
    currentToken: OAuthToken | undefined,
  ): Promise<OAuthToken> {
    let token: OAuthToken

    if (config.flow === 'client_credentials') {
      token = await fetchClientCredentialsToken(config)
    } else if (currentToken?.refreshToken) {
      token = await refreshAccessToken(config, currentToken.refreshToken)
    } else {
      throw new OAuthError(
        'auth_required',
        `No valid OAuth token for provider '${providerName}'. Visit /oauth/login/${providerName} to authenticate.`,
      )
    }

    this.store = { ...this.store, [providerName]: token }
    const data = await loadAuthFile(this.authFilePath)
    await saveAuthFile(this.authFilePath, mergeTokenStore(data, this.store))
    return token
  }
}
