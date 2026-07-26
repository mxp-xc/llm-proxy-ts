import type {
  AnthropicProviderConfig,
  OpenAICompatibleProviderConfig,
  OpenAIProviderConfig,
  ProviderConfig,
} from '../config.js'

type ProviderType = ProviderConfig['type']

type ProviderTypeMetadata = {
  defaultBaseURL: string | undefined
  discoveryAuthMode: 'bearer' | 'anthropic'
}

const providerTypeMetadata = {
  'openai-compatible': {
    defaultBaseURL: undefined,
    discoveryAuthMode: 'bearer',
  },
  anthropic: {
    defaultBaseURL: 'https://api.anthropic.com/v1',
    discoveryAuthMode: 'anthropic',
  },
  openai: {
    defaultBaseURL: 'https://api.openai.com/v1',
    discoveryAuthMode: 'bearer',
  },
} as const satisfies Record<ProviderType, ProviderTypeMetadata>

export type ResolvedProviderConfig =
  | OpenAICompatibleProviderConfig
  | (AnthropicProviderConfig & { baseURL: string })
  | (OpenAIProviderConfig & { baseURL: string })

type OpenAIModelDiscoveryOptions = Pick<
  NonNullable<OpenAIProviderConfig['options']>,
  'organization' | 'project'
>

export interface ProviderDiscoveryMetadata {
  baseURL: string
  authMode: 'bearer' | 'anthropic'
  modelsEndpoint?: string
  anthropicVersion?: string
  openAIOptions?: OpenAIModelDiscoveryOptions
}

export interface ResolvedProviderMetadata {
  provider: ResolvedProviderConfig
  discovery: ProviderDiscoveryMetadata
}

export function resolveProviderMetadata(provider: ProviderConfig): ResolvedProviderMetadata {
  switch (provider.type) {
    case 'openai-compatible': {
      const metadata = providerTypeMetadata[provider.type]
      return {
        provider: { ...provider, baseURL: provider.baseURL },
        discovery: {
          baseURL: provider.baseURL,
          authMode: metadata.discoveryAuthMode,
          ...(provider.options?.modelsEndpoint !== undefined
            ? { modelsEndpoint: provider.options.modelsEndpoint }
            : {}),
        },
      }
    }
    case 'anthropic': {
      const metadata = providerTypeMetadata[provider.type]
      const baseURL = provider.baseURL ?? metadata.defaultBaseURL
      return {
        provider: { ...provider, baseURL },
        discovery: {
          baseURL,
          authMode: metadata.discoveryAuthMode,
          ...(provider.options?.anthropicVersion !== undefined
            ? { anthropicVersion: provider.options.anthropicVersion }
            : {}),
        },
      }
    }
    case 'openai': {
      const metadata = providerTypeMetadata[provider.type]
      const baseURL = provider.baseURL ?? metadata.defaultBaseURL
      const openAIOptions = parseOpenAIModelDiscoveryOptions(provider)
      return {
        provider: { ...provider, baseURL },
        discovery: {
          baseURL,
          authMode: metadata.discoveryAuthMode,
          ...(openAIOptions !== undefined ? { openAIOptions } : {}),
        },
      }
    }
    default:
      return assertNever(provider)
  }
}

function parseOpenAIModelDiscoveryOptions(
  provider: OpenAIProviderConfig,
): OpenAIModelDiscoveryOptions | undefined {
  const organization = provider.options?.organization
  const project = provider.options?.project
  if (organization === undefined && project === undefined) return undefined

  return {
    ...(organization !== undefined ? { organization } : {}),
    ...(project !== undefined ? { project } : {}),
  }
}

function assertNever(_value: never): never {
  throw new Error('Unsupported provider type')
}
