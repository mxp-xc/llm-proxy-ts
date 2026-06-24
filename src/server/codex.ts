import { Hono } from 'hono'
import { openaiResponsesStrategy } from '../index.js'
import type { Settings } from '../index.js'
import { handleProtocolRequest } from './handle-protocol.js'
import type { ProtocolContext } from './handle-protocol.js'
import type { AppEnv } from './types.js'
import { buildCodexModelsResponse, fetchCodexBundledCatalog, type CodexCatalogFetcher } from './codex-catalog.js'

interface CodexAppDeps {
  settings: Settings
  protocolCtx: ProtocolContext
  codexCatalogFetcher?: CodexCatalogFetcher | undefined
}

export function createCodexApp(deps: CodexAppDeps): Hono<AppEnv> {
  const { settings, protocolCtx, codexCatalogFetcher } = deps
  const app = new Hono<AppEnv>()

  app.post('/v1/responses', (c) =>
    handleProtocolRequest(c, openaiResponsesStrategy, protocolCtx),
  )

  app.get('/v1/models', async (c) => {
    try {
      const catalog = await fetchCodexBundledCatalog(codexCatalogFetcher)
      return c.json(buildCodexModelsResponse(settings, catalog))
    } catch (err) {
      c.get('logger').error({ err }, 'codex /v1/models failed')
      const message = err instanceof Error ? err.message : String(err)
      return c.json(
        { error: { type: 'server_error', message: `Failed to fetch codex bundled catalog: ${message}` } },
        503,
      )
    }
  })

  return app
}
