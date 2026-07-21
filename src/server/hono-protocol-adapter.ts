import type { Context } from 'hono'
import type { ProtocolRequestScope } from './handle-protocol.js'
import type { AppEnv } from './types.js'

export function createProtocolRequestScope(c: Context<AppEnv>): ProtocolRequestScope {
  const telemetry = c.get('requestLogContext')
  if (!telemetry) throw new Error('Request telemetry context is not initialized')
  return {
    requestId: c.get('requestId'),
    logger: c.get('logger'),
    telemetry,
    readJson: () => c.req.json(),
  }
}
