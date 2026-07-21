import type { LanguageModel, generateText } from 'ai'
import type { AISDKInput, ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import type { Settings } from '../config.js'
import type { TokenManager } from '../oauth/token-manager.js'
import type { ProviderRegistry, KeySelection } from '../providers/registry.js'
import type { PipelinePluginRegistry } from '../plugins/registry.js'
import type { ProviderAuthStatus } from './oauth/startup.js'
import type { CodexCatalogCache } from '../codex-catalog.js'
import type { ErrorLogger } from './error-logger.js'
import type { Logger } from '../types.js'

export type { Settings } from '../config.js'

/** generateText 的返回类型 — 避免直接引用 Output 命名空间 */
export type GenerateTextReturn = Awaited<ReturnType<typeof generateText>>

export interface GatewayGenerateOptions {
  include?: {
    requestBody?: boolean
    responseBody?: boolean
  }
  maxRetries?: number
}

export interface GatewayStreamOptions {
  include?: {
    requestBody?: boolean
    rawChunks?: boolean
  }
  maxRetries?: number
}

export interface ModelGateway {
  generate(input: {
    model: LanguageModel
    callInput: AISDKInput
    requestModel: string
    abortSignal?: AbortSignal
    options?: GatewayGenerateOptions
  }): Promise<GenerateTextReturn>
  stream(input: {
    model: LanguageModel
    callInput: AISDKInput
    requestModel: string
    abortSignal?: AbortSignal
    options?: GatewayStreamOptions
    onError?: (error: unknown) => void
  }): AsyncIterable<ProxyStreamPart>
}

export interface AppDependencies {
  settings: Settings
  providerRegistry: ProviderRegistry
  gateway?: ModelGateway
  logger?: Logger
  tokenManager?: TokenManager
  nonce?: string
  getAuthStatuses?: () => ProviderAuthStatus[]
  pluginRegistry?: PipelinePluginRegistry
  codexCatalogCache?: CodexCatalogCache
  errorLogger?: ErrorLogger
  errorLogDir?: string
}

export type RequestOutcome =
  | 'success'
  | 'validation_error'
  | 'routing_error'
  | 'client_error'
  | 'auth_required'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_error'
  | 'upstream_aborted'
  | 'incomplete_stream'
  | 'client_cancelled'
  | 'internal_error'

export type RequestExecutionMode = 'generate' | 'stream' | 'stream-only'

export interface RequestTelemetryContext {
  requestId: string
  startedAt: number
  method: string
  path: string
  status?: number
  outcome?: RequestOutcome
  provider?: string
  requestedModel?: string
  actualModel?: string
  executionMode?: RequestExecutionMode
  keySelection?: KeySelection
  finishReason?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
  upstreamRequestId?: string
  upstreamDurationMs?: number
  firstChunkMs?: number
  terminalPart?: 'finish' | 'error' | 'abort' | 'eof'
  terminalError?: string
  explicitFailure?: boolean
  failureLogged?: boolean
  pendingStreamError?: unknown
  ndjsonWritten: boolean
  completed: boolean
}

/** @deprecated Use RequestTelemetryContext. */
export type RequestLogContext = RequestTelemetryContext

export type AppEnv = {
  Variables: {
    requestId: string
    logger: Logger
    requestLogContext?: RequestTelemetryContext
  }
}
