import { createApp as createProductionApp } from '../../src/server/app.js'
import { ErrorLogger } from '../../src/server/error-logger.js'
import type { AppDependencies } from '../../src/server/types.js'
import { noopLogger } from '../../src/types.js'

const disabledErrorLogger = new ErrorLogger({
  logDir: 'logs',
  enabled: false,
  maxBodyLength: 0,
  logger: noopLogger,
})

export function createApp(dependencies: AppDependencies) {
  return createProductionApp({
    ...dependencies,
    errorLogger: dependencies.errorLogger ?? disabledErrorLogger,
  })
}
