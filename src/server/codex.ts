import { Hono } from 'hono'
import { ZodError } from 'zod/v3'
import { openaiResponsesStrategy } from '../index.js'
import type { Settings } from '../index.js'
import { handleProtocolRequest } from './handle-protocol.js'
import type { ProtocolContext } from './handle-protocol.js'
import type { AppEnv } from './types.js'
import { buildCodexModelsResponse, CodexCatalogCache } from './codex-catalog.js'

interface CodexAppDeps {
  settings: Settings
  protocolCtx: ProtocolContext
  catalogCache: CodexCatalogCache
}

export function createCodexApp(deps: CodexAppDeps): Hono<AppEnv> {
  const { settings, protocolCtx, catalogCache } = deps
  const app = new Hono<AppEnv>()

  app.post('/v1/responses', (c) =>
    handleProtocolRequest(c, openaiResponsesStrategy, protocolCtx),
  )

  app.get('/v1/models', async (c) => {
    try {
      const catalog = await catalogCache.get()
      return c.json(buildCodexModelsResponse(settings, catalog))
    } catch (err) {
      c.get('logger')?.error({ err }, 'codex /v1/models failed')
      const reason =
        err instanceof ZodError
          ? 'codex catalog schema validation failed'
          : err instanceof Error
            ? err.message
            : String(err)
      return c.json(
        { error: { type: 'server_error', message: `Failed to fetch codex bundled catalog: ${reason}` } },
        503,
      )
    }
  })

  return app
}
