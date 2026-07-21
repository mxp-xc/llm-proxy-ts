import type { OAuthConfig } from '../config.js'
import { noopLogger, type Logger } from '../types.js'
import type { AuthStatus, OAuthToken, OAuthTokenResponse, TokenStore } from './types.js'
import { OAuthError } from './types.js'
import { loadAuthFile, extractTokenStore, saveTokenStore } from './token-store.js'

/** Token 过期前的提前刷新余量（秒） */
const EXPIRY_MARGIN_SECONDS = 30

/**
 * Token 持久化抽象，解耦 TokenManager 与文件系统。
 *
 * - `load()` 返回纯 TokenStore（不含 _plugins 等非 OAuth 数据）
 * - `save()` 负责合并回完整持久化存储，保留非 OAuth 字段
 */
export interface TokenPersistence {
  load(): Promise<TokenStore>
  save(store: TokenStore): Promise<void>
}

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
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
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
    const response = await fetchFn(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      throw new OAuthError('refresh_failed', `Token refresh failed: HTTP ${response.status}`)
    }

    return parseTokenResponse(
      await parseTokenEndpointJson(response, 'refresh_failed', 'Token refresh failed'),
      'refresh_failed',
    )
  } catch (error) {
    if (error instanceof OAuthError) throw error
    throw new OAuthError('refresh_failed', `Token refresh failed: ${String(error)}`, {
      cause: error,
    })
  }
}

/**
 * 使用 client_credentials 获取 token。
 */
export async function fetchClientCredentialsToken(
  config: OAuthConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  if (config.scopes.length > 0) {
    body.set('scope', config.scopes.join(' '))
  }

  try {
    const response = await fetchFn(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      throw new OAuthError(
        'refresh_failed',
        `Client credentials token fetch failed: HTTP ${response.status}`,
      )
    }

    return parseTokenResponse(
      await parseTokenEndpointJson(
        response,
        'refresh_failed',
        'Client credentials token fetch failed',
      ),
      'refresh_failed',
    )
  } catch (error) {
    if (error instanceof OAuthError) throw error
    throw new OAuthError(
      'refresh_failed',
      `Client credentials token fetch failed: ${String(error)}`,
      { cause: error },
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
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
  })

  try {
    const response = await fetchFn(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    if (!response.ok) {
      throw new OAuthError(
        'exchange_failed',
        `Authorization code exchange failed: HTTP ${response.status}`,
      )
    }

    return parseTokenResponse(
      await parseTokenEndpointJson(
        response,
        'exchange_failed',
        'Authorization code exchange failed',
      ),
      'exchange_failed',
    )
  } catch (error) {
    if (error instanceof OAuthError) throw error
    throw new OAuthError(
      'exchange_failed',
      `Authorization code exchange failed: ${String(error)}`,
      {
        cause: error,
      },
    )
  }
}

/**
 * 解析 OAuth token 端点的 JSON 响应。
 */
type TokenEndpointFailureCode = 'refresh_failed' | 'exchange_failed'

async function parseTokenEndpointJson(
  response: Response,
  failureCode: TokenEndpointFailureCode,
  operation: string,
): Promise<OAuthTokenResponse> {
  try {
    return (await response.json()) as OAuthTokenResponse
  } catch {
    // Native JSON parse errors can include a snippet of the token endpoint body.
    throw new OAuthError(failureCode, `${operation}: token endpoint returned invalid JSON`)
  }
}

function parseTokenResponse(
  data: OAuthTokenResponse,
  failureCode: TokenEndpointFailureCode,
): OAuthToken {
  const accessToken = data['access_token']
  const expiresIn = data['expires_in']
  const tokenType = data['token_type']
  const refreshToken = data['refresh_token']
  const scope = data['scope']

  if (typeof accessToken !== 'string') {
    throw new OAuthError(failureCode, 'Token response missing access_token')
  }

  if (typeof expiresIn !== 'number') {
    throw new OAuthError(failureCode, 'Token response missing expires_in')
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
 * - 持有内存缓存 + 通过 TokenPersistence 持久化
 * - 并发请求自动去重（同一 provider 同时只做一次刷新）
 */
export class TokenManager {
  private store: TokenStore = {}
  private refreshLocks = new Map<string, RefreshOperation>()

  constructor(
    private persistence: TokenPersistence,
    private fetchFn: typeof globalThis.fetch = globalThis.fetch,
    private logger: Logger = noopLogger,
  ) {}

  /**
   * 从 auth.json 文件创建 TokenManager（便捷工厂方法）。
   *
   * 内部创建基于文件系统的 TokenPersistence 实现，
   * 保持与原构造函数相同的外部行为。
   */
  static fromFile(
    authFilePath: string,
    fetchFn?: typeof globalThis.fetch,
    logger?: Logger,
  ): TokenManager {
    const persistence: TokenPersistence = {
      async load(): Promise<TokenStore> {
        const data = await loadAuthFile(authFilePath)
        return extractTokenStore(data)
      },
      async save(store: TokenStore): Promise<void> {
        await saveTokenStore(authFilePath, store)
      },
    }
    return new TokenManager(persistence, fetchFn, logger)
  }

  /**
   * 启动时从持久化存储加载 token。
   */
  async load(): Promise<void> {
    this.store = await this.persistence.load()
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
      existing.joinedRequests++
      return existing.promise
    }

    const flow = resolveRefreshFlow(config, token)
    if (!flow) {
      throw new OAuthError(
        'auth_required',
        `No valid OAuth token for provider '${providerName}'. Visit /oauth/login/${providerName} to authenticate.`,
      )
    }

    const operation = { joinedRequests: 0 } as RefreshOperation
    operation.promise = this.doRefresh(providerName, config, token, flow, operation)
    this.refreshLocks.set(providerName, operation)

    try {
      return await operation.promise
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
    const token = await exchangeAuthorizationCode(config, code, redirectUri, this.fetchFn)
    this.store = { ...this.store, [providerName]: token }
    await this.persistence.save(this.store)
    return token
  }

  private async doRefresh(
    providerName: string,
    config: OAuthConfig,
    currentToken: OAuthToken | undefined,
    flow: OAuthRefreshFlow,
    operation: RefreshOperation,
  ): Promise<OAuthToken> {
    const startedAt = Date.now()
    let stage: OAuthRefreshStage = 'token_endpoint'
    this.logger.info({ provider: providerName, flow }, 'oauth.refresh.started')

    try {
      const token =
        flow === 'client_credentials'
          ? await fetchClientCredentialsToken(config, this.fetchFn)
          : await refreshAccessToken(config, currentToken!.refreshToken!, this.fetchFn)

      stage = 'persist'
      const nextStore = { ...this.store, [providerName]: token }
      await this.persistence.save(nextStore)
      this.store = nextStore
      this.logger.info(
        {
          provider: providerName,
          flow,
          joinedRequests: operation.joinedRequests,
          durationMs: Date.now() - startedAt,
        },
        'oauth.refresh.succeeded',
      )
      return token
    } catch (err) {
      this.logger.error(
        {
          err,
          provider: providerName,
          flow,
          joinedRequests: operation.joinedRequests,
          durationMs: Date.now() - startedAt,
          stage,
        },
        'oauth.refresh.failed',
      )
      throw err
    }
  }
}

type OAuthRefreshFlow = 'refresh_token' | 'client_credentials'
type OAuthRefreshStage = 'token_endpoint' | 'persist'

interface RefreshOperation {
  promise: Promise<OAuthToken>
  joinedRequests: number
}

function resolveRefreshFlow(
  config: OAuthConfig,
  currentToken: OAuthToken | undefined,
): OAuthRefreshFlow | undefined {
  if (config.flow === 'client_credentials') return 'client_credentials'
  return currentToken?.refreshToken ? 'refresh_token' : undefined
}
