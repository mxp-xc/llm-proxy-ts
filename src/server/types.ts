import type { LanguageModel, generateText } from 'ai'
import type { AISDKInput, ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import type { Settings } from '../config.js'
import type { TokenManager } from '../oauth/token-manager.js'
import type { ProviderRegistry, KeySelection } from '../providers/registry.js'
import type { PluginRegistry } from '../plugins/registry.js'
import type { ProviderAuthStatus } from './oauth/startup.js'
import type pino from 'pino'
import type { CodexCatalogCache } from '../codex-catalog.js'

export type { Settings } from '../config.js'

/** generateText 的返回类型 — 避免直接引用 Output 命名空间 */
export type GenerateTextReturn = Awaited<ReturnType<typeof generateText>>

export interface ModelGateway {
  generate(input: {
    model: LanguageModel
    callInput: AISDKInput
    requestModel: string
    abortSignal?: AbortSignal
  }): Promise<GenerateTextReturn>
  stream(input: {
    model: LanguageModel
    callInput: AISDKInput
    requestModel: string
    abortSignal?: AbortSignal
  }): AsyncIterable<ProxyStreamPart>
}

export interface AppDependencies {
  settings: Settings
  providerRegistry?: ProviderRegistry
  gateway?: ModelGateway
  logger?: pino.Logger
  tokenManager?: TokenManager
  nonce?: string
  getAuthStatuses?: () => ProviderAuthStatus[]
  pluginRegistry?: PluginRegistry
  authFilePath?: string
  codexCatalogCache?: CodexCatalogCache
}

export type AppEnv = {
  Variables: {
    requestId: string
    logger: pino.Logger
    requestedModel?: string
    actualModel?: string
    provider?: string
    keySelection?: KeySelection
  }
}
