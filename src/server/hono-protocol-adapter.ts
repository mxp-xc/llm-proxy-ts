import type { Context } from 'hono'
import type { ProtocolRequestScope } from './handle-protocol.js'
import type { AppEnv } from './types.js'

export function createProtocolRequestScope(c: Context<AppEnv>): ProtocolRequestScope {
  return {
    requestId: c.get('requestId'),
    logger: c.get('logger'),
    readJson: () => c.req.json(),
    setRequestLogContext(context) {
      c.set('requestLogContext', context)
    },
  }
}
