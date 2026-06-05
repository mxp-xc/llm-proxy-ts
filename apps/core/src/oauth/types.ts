/**
 * OAuth token 数据，持久化到 auth.json。
 */
export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix epoch seconds (float)
  scope?: string;
  tokenType: string;
}

/**
 * auth.json 的顶层结构，按 provider name 索引。
 */
export type TokenStore = Record<string, OAuthToken>;

/**
 * Provider 的 OAuth 认证状态。
 *
 * - `valid` — token 有效
 * - `needs_refresh` — accessToken 过期但 refreshToken 可用
 * - `needs_login` — 无 token 或 refreshToken 也过期，需要用户登录
 */
export type AuthStatus = 'valid' | 'needs_refresh' | 'needs_login';

/**
 * OAuth 相关错误，可被 server 层捕获并转换为 HTTP 响应。
 */
export class OAuthError extends Error {
  constructor(
    public readonly code: 'auth_required' | 'refresh_failed' | 'exchange_failed',
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}
