import type { Settings, TokenManager } from '../index.js'
import type { ProviderRegistry, PluginRegistry, KeySelection } from '../index.js'
import type { ProviderAuthStatus } from './oauth/startup.js'
import type pino from 'pino'

export type { Settings } from '../index.js'

export interface ModelGateway {
  generate(input: {
    model: unknown
    callInput: any
    requestModel: string
    abortSignal?: AbortSignal
  }): Promise<any>
  stream(input: {
    model: unknown
    callInput: any
    requestModel: string
    abortSignal?: AbortSignal
  }): AsyncIterable<unknown>
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
