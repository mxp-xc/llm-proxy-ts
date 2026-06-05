// Config exports
export {
  pluginConfigSchema,
  modelRouteConfigSchema,
  oauthConfigSchema,
  authConfigSchema,
  providerConfigSchema,
  settingsSchema,
} from './config.js';
export type { PluginConfig, ModelRouteConfig, ModelRouteInput, OAuthConfig, AuthConfig, ProviderConfig, Settings } from './config.js';
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
export { isFlatLookupEnabled } from './config-helpers.js';

// Type exports
export type { Logger } from './types.js';

// Provider exports
export { createOpenAICompatibleProvider, createProxyFetch, sanitizeHeaders } from './openai-compatible.js';

// OAuth exports
export type { OAuthToken, TokenStore, AuthStatus } from './oauth/types.js';
export { OAuthError } from './oauth/types.js';
export type { AuthFileData } from './oauth/token-store.js';
export { PLUGINS_KEY, loadAuthFile, saveAuthFile, extractTokenStore, mergeTokenStore } from './oauth/index.js';
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

// Plugin exports
export type { PluginContext, PluginResponse, ProviderCallPatch, ProviderResultPatch, ProxyPlugin, ResolvedPluginConfig } from './plugins/types.js';
export { BUILT_IN_PLUGIN_NAMES, resolvePluginConfigs, assertKnownPlugins } from './plugins/registry.js';
export { inspectVendorSseError } from './plugins/vendor-sse-error.js';
export type { VendorSseErrorConfig, VendorSseErrorResponse } from './plugins/vendor-sse-error.js';

// Protocol type exports
export type { OpenAIModel, OpenAIModelList } from './protocols/openai-types.js';

// Protocol exports
export { validateOpenAIChatRequest, openAIChatRequestSchema, mapOpenAIChatRequestToAISDKInput } from './protocols/openai-chat.js';
export type { OpenAIChatRequest, AISDKInput } from './protocols/openai-chat.js';
export { renderOpenAIChatCompletion, renderOpenAIChatCompletionSSE } from './protocols/openai-chat-renderer.js';
export type { RenderResultInput, OpenAIChatCompletion } from './protocols/openai-chat-renderer.js';
export { listModels, getModel } from './protocols/openai-models.js';

// Routing exports
export { RoutingTable, RoutingError } from './routing.js';
export type { RouteMatch } from './routing.js';

// Provider registry exports
export { createProviderRegistry, createOAuthFetch } from './providers/registry.js';
export type { ProviderRegistry } from './providers/registry.js';

// Auth plugin exports
export type { AuthPlugin, AuthPluginContext, AuthPluginStore, ResolvedAuthPlugin } from './auth/types.js';
export type { SimpleAuthCredentials } from './auth/helpers.js';
export { createSimpleAuthFetch } from './auth/helpers.js';
export { loadAuthPlugin } from './auth/loader.js';
export { createPluginStore } from './auth/store-adapter.js';
