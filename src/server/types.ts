import type { LanguageModel, generateText } from 'ai'
import type { AISDKInput, ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import type { Settings, TokenManager } from '../index.js'
import type { ProviderRegistry, PluginRegistry, KeySelection } from '../index.js'
import type { ProviderAuthStatus } from './oauth/startup.js'
import type pino from 'pino'

export type { Settings } from '../index.js'

/** generateText 的返回类型 — 避免直接引用 Output 命名空间 */
type GenerateTextReturn = Awaited<ReturnType<typeof generateText>>

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
  authStatuses?: ProviderAuthStatus[]
  pluginRegistry?: PluginRegistry
  authFilePath?: string
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
