import type { ProviderRegistry } from '../../src/index.js'
import { noopLogger, type Logger } from '../../src/types.js'

export { noopLogger }

export function createProviderRegistryStub(
  overrides: Partial<ProviderRegistry> = {},
): ProviderRegistry {
  return {
    languageModel() {
      return { model: {} as never }
    },
    passthroughTransport() {
      return { fetch: globalThis.fetch, apiKey: undefined }
    },
    ...overrides,
  }
}

export const stubRegistry: ProviderRegistry = createProviderRegistryStub()

export function createCapturingLogger() {
  const capturedLogs: unknown[] = []
  const logger: Logger = {
    info(payload: unknown) {
      capturedLogs.push(payload)
    },
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger
    },
  }
  return { logger, capturedLogs }
}
