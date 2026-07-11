import type { OAuthConfig, Settings } from '../../config.js'

export function buildOAuthCallbackUrl(settings: Settings, oauth?: OAuthConfig): string {
  return oauth?.redirectUri ?? `http://127.0.0.1:${settings.service.port}/oauth/callback`
}

export function buildOAuthLoginUrl(settings: Settings, providerName: string): string {
  return `http://127.0.0.1:${settings.service.port}/oauth/login/${providerName}`
}
