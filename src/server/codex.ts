import { Hono } from 'hono'
import { ZodError } from 'zod/v3'
import { openaiResponsesStrategy } from '../providers/openai-responses/strategy.js'
import type { Settings } from '../config.js'
import { handleProtocolRequest } from './handle-protocol.js'
import type { ProtocolContext } from './handle-protocol.js'
import { createProtocolRequestScope } from './hono-protocol-adapter.js'
import type { AppEnv } from './types.js'
import { buildCodexModelsResponse, CodexCatalogCache } from '../codex-catalog.js'
import type { CodexModelInfo } from '../codex-types.js'

interface CodexAppDeps {
  settings: Settings
  protocolCtx: ProtocolContext
  catalogCache: CodexCatalogCache
}

export function createCodexApp(deps: CodexAppDeps): Hono<AppEnv> {
  const { settings, protocolCtx, catalogCache } = deps
  const app = new Hono<AppEnv>()

  app.post('/v1/responses', (c) =>
    handleProtocolRequest(createProtocolRequestScope(c), openaiResponsesStrategy, protocolCtx),
  )

  // settings 不可变(无 hot-reload),buildCodexModelsResponse 结果仅依赖 settings + catalog。
  // catalogCache.get() 自带懒加载缓存;成功构建后在此闭包缓存,后续 /v1/models 请求直接返回。
  // 失败不缓存(保留原 503 错误路径,下次请求重试)。
  let cachedModels: { models: CodexModelInfo[] } | null = null

  app.get('/v1/models', async (c) => {
    try {
      if (!cachedModels) {
        const catalog = await catalogCache.get()
        cachedModels = buildCodexModelsResponse(settings, catalog)
      }
      return c.json(cachedModels)
    } catch (err) {
      c.get('logger')?.error({ err }, 'codex /v1/models failed')
      const reason =
        err instanceof ZodError
          ? 'codex catalog schema validation failed'
          : err instanceof Error
            ? err.message
            : String(err)
      return c.json(
        {
          error: {
            type: 'server_error',
            message: `Failed to fetch codex bundled catalog: ${reason}`,
          },
        },
        503,
      )
    }
  })

  return app
}
