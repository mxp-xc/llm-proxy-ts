// Config exports
export {
  pluginEntrySchema,
  modelRouteConfigSchema,
  oauthConfigSchema,
  providerConfigSchema,
  settingsSchema,
} from './config.js'
export type {
  PluginEntry,
  ModelRouteConfig,
  OAuthConfig,
  OpenAICompatibleProviderConfig,
  AnthropicProviderConfig,
  OpenAIProviderConfig,
  ProviderConfig,
  Settings,
} from './config.js'
export {
  resolveEnvPlaceholders,
  loadSettingsFromFile,
  generateSettingsJsonSchema,
  writeSettingsJsonSchema,
} from './config.js'
export { loadEnvironmentFiles } from './env.js'
export { resolveSettingsPath } from './resolve-settings-path.js'
export { isFlatLookupEnabled } from './config-helpers.js'

// Type exports
export type { Logger } from './types.js'

// Provider exports
export { flattenUsage } from './providers/shared/renderer-utils.js'
export { collectStreamResult } from './providers/shared/stream-collector.js'

// OAuth exports
export type { OAuthToken, TokenStore, AuthStatus } from './oauth/types.js'
export { OAuthError } from './oauth/types.js'
export type { AuthFileData } from './oauth/token-store.js'
export {
  PLUGINS_KEY,
  loadAuthFile,
  saveAuthFile,
  extractTokenStore,
  mergeTokenStore,
} from './oauth/index.js'
export {
  isTokenValid,
  isTokenExpired,
  classifyStatus,
  refreshAccessToken,
  fetchClientCredentialsToken,
  exchangeAuthorizationCode,
  TokenManager,
} from './oauth/index.js'

// Plugin exports
export type {
  Plugin,
  ProxyPlugin,
  AuthPlugin,
  ProviderContext,
  PluginStore,
  PluginResponse,
  DiscoveredModel,
  DiscoveredModelList,
  ResolvedPlugin,
} from './plugins/types.js'
export { PluginRegistry } from './plugins/registry.js'
export { registerBuiltInPlugin, loadPlugin } from './plugins/loader.js'
export { inspectVendorSseError } from './plugins/vendor-sse-error.js'
export { createSimpleAuthFetch } from './plugins/helpers.js'
export type { SimpleAuthCredentials } from './plugins/helpers.js'
export { createPluginStore } from './plugins/store-adapter.js'

// Protocol type exports
export type { OpenAIModel, OpenAIModelList } from './providers/model-types.js'
export type {
  AnthropicStopReason,
  AnthropicMessageResponse,
} from './providers/anthropic/types.js'

// Protocol exports — OpenAI Compatible (Chat Completions)
export type { OpenAIChatRequest, AISDKInput } from './providers/openai-compatible/protocol.js'
export type { RenderResultInput } from './providers/protocol-types.js'

// Protocol exports — OpenAI Responses API
export type { OpenAIResponsesRequest } from './providers/openai-responses/protocol.js'

// Models
export { listModels, getModel } from './providers/models.js'

// Strategy exports
export type { ProtocolStrategy } from './providers/shared/strategy.js'
export type { ProtocolErrorFormatter } from './providers/shared/error-format.js'
export { openAIErrorFormat, anthropicErrorFormat } from './providers/shared/error-format.js'
export { openaiCompatibleStrategy } from './providers/openai-compatible/strategy.js'
export { openaiResponsesStrategy } from './providers/openai-responses/strategy.js'
export { anthropicStrategy } from './providers/anthropic/strategy.js'

// Routing exports
export { RoutingTable, RoutingError } from './routing.js'
export type { RouteMatch } from './routing.js'

// Provider registry exports
export { createProviderRegistry, createOAuthFetch } from './providers/registry.js'
export type { ProviderRegistry, KeySelection, LanguageModelResult } from './providers/registry.js'
