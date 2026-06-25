import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTokenManagerIfNeeded } from '../../src/oauth/token-bootstrap.js'
import { TokenManager } from '../../src/oauth/token-manager.js'

describe('createTokenManagerIfNeeded', () => {
  it('returns undefined and does not call fromFile when hasOAuth is false', async () => {
    const fromFileSpy = vi.spyOn(TokenManager, 'fromFile')

    const result = await createTokenManagerIfNeeded('/nonexistent/auth.json', false)

    expect(result).toBeUndefined()
    expect(fromFileSpy).not.toHaveBeenCalled()

    fromFileSpy.mockRestore()
  })

  it('creates and loads TokenManager when hasOAuth is true', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-bootstrap-'))
    const authFilePath = join(dir, 'auth.json')
    // 写一个合法但空的 auth 文件，loadAuthFile 要求可解析的 JSON
    await writeFile(authFilePath, JSON.stringify({}), 'utf8')

    try {
      const result = await createTokenManagerIfNeeded(authFilePath, true)

      expect(result).toBeInstanceOf(TokenManager)
      // load() 成功即证明 store 已初始化（无异常）
      expect(result).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
