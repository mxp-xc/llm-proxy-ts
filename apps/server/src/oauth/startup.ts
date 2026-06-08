import type { Settings, OAuthConfig } from '@llm-proxy/core';
import { classifyStatus } from '@llm-proxy/core';
import type { TokenManager, AuthStatus } from '@llm-proxy/core';
import { logger } from '../logging.js';

export interface ProviderAuthStatus {
  provider: string;
  status: AuthStatus;
  loginUrl?: string;
}

/**
 * 在服务启动时检查所有 OAuth provider 的认证状态。
 *
 * OAuth provider:
 * - valid: token 有效
 * - needs_refresh: 自动刷新
 * - needs_login: 打印登录 URL
 *
 * 不阻塞服务启动。
 */
export async function validateOAuthStatus(
  settings: Settings,
  tokenManager: TokenManager,
): Promise<ProviderAuthStatus[]> {
  const results: ProviderAuthStatus[] = [];

  for (const [providerName, provider] of Object.entries(settings.providers)) {
    // OAuth provider
    if (!provider.oauth) continue;

    const oauth: OAuthConfig = provider.oauth;
    const status = tokenManager.getStatus(providerName, oauth);

    if (status === 'valid') {
      logger.info({ provider: providerName }, 'oauth token valid');
      results.push({ provider: providerName, status: 'valid' });
      continue;
    }

    if (status === 'needs_refresh') {
      try {
        await tokenManager.ensureValidToken(providerName, oauth);
        logger.info({ provider: providerName }, 'oauth token refreshed');
        results.push({ provider: providerName, status: 'valid' });
      } catch {
        // 刷新失败，需要登录
        const loginUrl = buildLoginUrl(settings, providerName);
        logger.warn(
          { provider: providerName, loginUrl },
          'oauth token refresh failed — login required',
        );
        results.push({ provider: providerName, status: 'needs_login', loginUrl });
      }
      continue;
    }

    // needs_login
    const loginUrl = buildLoginUrl(settings, providerName);
    logger.warn(
      { provider: providerName, loginUrl },
      'oauth login required — visit the URL to authenticate',
    );
    results.push({ provider: providerName, status: 'needs_login', loginUrl });
  }

  return results;
}

function buildLoginUrl(settings: Settings, providerName: string): string {
  return `http://127.0.0.1:${settings.service.port}/oauth/login/${providerName}`;
}

/**
 * 生成启动时使用的 CSRF nonce。
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}
