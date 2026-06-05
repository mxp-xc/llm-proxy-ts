// Config exports
export {
  pluginConfigSchema,
  modelRouteConfigSchema,
  oauthConfigSchema,
  providerConfigSchema,
  settingsSchema,
} from './config.js';
export type { PluginConfig, ModelRouteConfig, ModelRouteInput, OAuthConfig, ProviderConfig, Settings } from './config.js';
export {
  resolveEnvPlaceholders,
  loadSettingsFromFile,
  generateSettingsJsonSchema,
  writeSettingsJsonSchema,
} from './config.js';
export { loadEnvironmentFiles } from './env.js';
export type { LoadEnvironmentFilesOptions } from './env.js';
export { resolveSettingsPath } from './resolve-settings-path.js';
export type { ResolveSettingsPathOptions } from './resolve-settings-path.js';

// Provider exports
export { createOpenAICompatibleProvider, createProxyFetch, sanitizeHeaders } from './openai-compatible.js';

// OAuth exports
export type { OAuthToken, TokenStore, AuthStatus } from './oauth/types.js';
export { OAuthError } from './oauth/types.js';
export {
  isTokenValid,
  isTokenExpired,
  classifyStatus,
  refreshAccessToken,
  fetchClientCredentialsToken,
  exchangeAuthorizationCode,
  TokenManager,
} from './oauth/index.js';
export { loadTokenStore, saveTokenStore, getToken, setToken } from './oauth/index.js';
