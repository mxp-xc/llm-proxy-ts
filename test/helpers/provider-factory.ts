import type { LanguageModel } from 'ai'
import type { ProviderFactory } from '../../src/providers/registry.js'
import type { ProviderBuildInput } from '../../src/providers/shared/provider-factory.js'

export interface CapturedProviderFactory {
  factory: ProviderFactory
  inputs: CapturedProviderFactoryInput[]
}

export type CapturedProviderFactoryKind = 'openai-compatible' | 'anthropic' | 'openai'

export type CapturedProviderFactoryInput = ProviderBuildInput & {
  kind: CapturedProviderFactoryKind
}

function modelFromInput(input: ProviderBuildInput, upstreamModel: string): LanguageModel {
  return {
    provider: `test:${input.providerName}`,
    modelId: upstreamModel,
  } as unknown as LanguageModel
}

export function createCapturingProviderFactory(): CapturedProviderFactory {
  const inputs: CapturedProviderFactoryInput[] = []

  const capture = (kind: CapturedProviderFactoryKind, input: ProviderBuildInput) => {
    inputs.push({ ...input, kind })
    return (upstreamModel: string) => modelFromInput(input, upstreamModel)
  }

  const factory = {
    createOpenAICompatible: (input) => capture('openai-compatible', input),
    createAnthropic: (input) => capture('anthropic', input),
    createOpenAI: (input) => capture('openai', input),
  } satisfies ProviderFactory

  return { factory, inputs }
}
