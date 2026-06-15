import type { LanguageModel } from 'ai'
import type { ProxyStreamPart } from '../providers/shared/aisdk-types.js'
import type { Settings, TokenManager } from '../index.js'
import type { ProviderRegistry, PluginRegistry, KeySelection } from '../index.js'
import type { ProviderAuthStatus } from './oauth/startup.js'
import pino from 'pino'

export type { Settings } from '../index.js'

export interface ModelGateway {
  generate(input: {
    model: LanguageModel
    callInput: any
    requestModel: string
    abortSignal?: AbortSignal
  }): Promise<any>
  stream(input: {
    model: LanguageModel
    callInput: any
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
