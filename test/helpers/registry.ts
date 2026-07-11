import type { ProviderRegistry } from '../../src/index.js'
import { noopLogger, type Logger } from '../../src/types.js'

export { noopLogger }

export const stubRegistry: ProviderRegistry = {
  languageModel() {
    return { model: {} as never }
  },
  selectApiKey() {
    return { apiKey: undefined }
  },
  debugProviderConfig() {
    return {} as never
  },
}

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
