import type { LanguageModel, generateText } from 'ai'
import type { AISDKInput, ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import type { Settings } from '../config.js'
import type { TokenManager } from '../oauth/token-manager.js'
import type { ProviderRegistry, KeySelection } from '../providers/registry.js'
import type { PipelinePluginRegistry } from '../plugins/registry.js'
import type { ProviderAuthStatus } from './oauth/startup.js'
import type pino from 'pino'
import type { CodexCatalogCache } from '../codex-catalog.js'
import type { ErrorLogger } from './error-logger.js'

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
  logger?: pino.Logger
  tokenManager?: TokenManager
  nonce?: string
  getAuthStatuses?: () => ProviderAuthStatus[]
  pluginRegistry?: PipelinePluginRegistry
  codexCatalogCache?: CodexCatalogCache
  errorLogger?: ErrorLogger
}

export interface RequestLogContext {
  provider: string
  requestedModel: string
  actualModel: string
  keySelection?: KeySelection
}

export type AppEnv = {
  Variables: {
    requestId: string
    logger: pino.Logger
    requestLogContext?: RequestLogContext
  }
}
