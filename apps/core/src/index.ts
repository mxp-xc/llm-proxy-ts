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
  ModelRouteInput,
  OAuthConfig,
  OpenAICompatibleProviderConfig,
  AnthropicProviderConfig,
  OpenAIProviderConfig,
  ProviderConfig,
  Settings,
} from './config.js'
/** @deprecated 使用 PluginEntry */
export type { PluginEntry as PluginConfig } from './config.js'
export {
  resolveEnvPlaceholders,
  loadSettingsFromFile,
  generateSettingsJsonSchema,
  writeSettingsJsonSchema,
} from './config.js'
export { loadEnvironmentFiles } from './env.js'
export type { LoadEnvironmentFilesOptions } from './env.js'
export { resolveSettingsPath } from './resolve-settings-path.js'
export type { ResolveSettingsPathOptions } from './resolve-settings-path.js'
export { isFlatLookupEnabled } from './config-helpers.js'

// Type exports
export type { Logger } from './types.js'

// Provider exports
export {
  createOpenAICompatibleProvider,
  createProxyFetch,
  sanitizeHeaders,
} from './providers/shared/provider-factory.js'
export { createAnthropicProvider } from './providers/anthropic/provider.js'
export { createOpenAIProvider } from './providers/openai/provider.js'

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
export { loadTokenStore, saveTokenStore, getToken, setToken } from './oauth/index.js'

// Plugin exports (unified)
export type {
  Plugin,
  ProxyPlugin,
  AuthPlugin,
  PluginInitContext,
  ProviderContext,
  PluginContext,
  PluginStore,
  PluginResponse,
  ProviderCallPatch,
  ProviderResultPatch,
  DiscoveredModel,
  DiscoveredModelList,
  ResolvedPlugin,
} from './plugins/types.js'
export { PluginRegistry } from './plugins/registry.js'
export type { ResolvedPlugin as ResolvedPluginFromRegistry } from './plugins/registry.js'
export { registerBuiltInPlugin, loadPlugin } from './plugins/loader.js'
export { inspectVendorSseError } from './plugins/vendor-sse-error.js'
export type { VendorSseErrorConfig, VendorSseErrorResponse } from './plugins/vendor-sse-error.js'
export { createSimpleAuthFetch } from './plugins/helpers.js'
export type { SimpleAuthCredentials } from './plugins/helpers.js'
export { createPluginStore } from './plugins/store-adapter.js'
/** @deprecated 不再需要 */
export { resolvePluginConfigs, assertKnownPlugins } from './plugins/registry.js'

// Protocol type exports
export type { OpenAIModel, OpenAIModelList } from './providers/model-types.js'
export type {
  AnthropicStopReason,
  AnthropicErrorResponse,
  AnthropicErrorType,
  AnthropicMessageResponse,
  AnthropicContentBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicThinking,
  AnthropicMessage,
} from './providers/anthropic/types.js'

// Protocol exports — OpenAI Compatible (Chat Completions)
export {
  validateOpenAIChatRequest,
  openAIChatRequestSchema,
  mapOpenAIChatRequestToAISDKInput,
} from './providers/openai-compatible/protocol.js'
export type { OpenAIChatRequest, AISDKInput } from './providers/openai-compatible/protocol.js'
export {
  renderOpenAIChatCompletion,
  renderOpenAIChatCompletionSSE,
} from './providers/openai-compatible/renderer.js'
export type { OpenAIChatCompletion } from './providers/openai-compatible/types.js'
export type { RenderResultInput } from './providers/protocol-types.js'

// Protocol exports — OpenAI Responses API
export {
  validateOpenAIResponsesRequest,
  openAIResponsesRequestSchema,
  mapResponsesRequestToAISDKInput,
} from './providers/openai-responses/protocol.js'
export type { OpenAIResponsesRequest } from './providers/openai-responses/protocol.js'
export {
  renderOpenAIResponse,
  renderOpenAIResponseSSE,
} from './providers/openai-responses/renderer.js'
export type {
  OpenAIResponse,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseFunctionToolCall,
  ResponseOutputText,
  ResponseUsage,
} from './providers/openai-responses/types.js'

// Models
export { listModels, getModel } from './providers/models.js'

// Protocol exports — Anthropic
export {
  validateAnthropicMessagesRequest,
  anthropicMessagesRequestSchema,
  mapAnthropicMessagesRequestToAISDKInput,
} from './providers/anthropic/protocol.js'
export {
  renderAnthropicMessage,
  renderAnthropicMessageSSE,
} from './providers/anthropic/renderer.js'

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
