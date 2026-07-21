import { describe, expect, it } from 'vitest'
import { modelRouteConfigSchema, providerConfigSchema } from '../src/config.js'
import { resolveModelSupportsVision } from '../src/index.js'

function makeProvider(supportsVision?: boolean) {
  return providerConfigSchema.parse({
    type: 'openai-compatible',
    baseURL: 'https://api.example.com/v1',
    ...(supportsVision === undefined ? {} : { options: { supports_vision: supportsVision } }),
  })
}

function makeModel(supportsVision?: boolean) {
  return modelRouteConfigSchema.parse({
    upstreamModel: 'model-x',
    ...(supportsVision === undefined ? {} : { supports_vision: supportsVision }),
  })
}

describe('resolveModelSupportsVision', () => {
  it.each([
    { provider: false, model: true, expected: true },
    { provider: true, model: false, expected: false },
    { provider: false, model: undefined, expected: false },
    { provider: true, model: undefined, expected: true },
    { provider: undefined, model: undefined, expected: true },
  ] as const)(
    'resolves provider=$provider model=$model to $expected',
    ({ provider, model, expected }) => {
      expect(resolveModelSupportsVision(makeProvider(provider), makeModel(model))).toBe(expected)
    },
  )
})
