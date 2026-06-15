import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginStore } from '../../src/plugins/store-adapter.js'

describe('createPluginStore', () => {
  let tempDir: string
  let authFilePath: string

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  async function setupAuthFile(initialData?: Record<string, unknown>): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-store-'))
    authFilePath = join(tempDir, 'auth.json')
    if (initialData) {
      await writeFile(authFilePath, JSON.stringify(initialData, null, 2), 'utf8')
    }
    return authFilePath
  }

  it('should read/write plugin data as objects', async () => {
    const filePath = await setupAuthFile()
    const store = createPluginStore(filePath, 'demo-auth')

    await store.set({ accessToken: 'abc123', expiresAt: '1707890123' })
    const data = await store.get()

    expect(data.accessToken).toBe('abc123')
    expect(data.expiresAt).toBe('1707890123')

    // Verify disk structure: _plugins.demo-auth nested
    const raw = await readFile(filePath, 'utf8')
    const disk = JSON.parse(raw)
    expect(disk._plugins['demo-auth'].accessToken).toBe('abc123')
    expect(disk._plugins['demo-auth'].expiresAt).toBe('1707890123')
  })

  it('should replace (not merge) on set', async () => {
    const filePath = await setupAuthFile()
    const store = createPluginStore(filePath, 'my-auth')

    await store.set({ a: 1, b: 2 })
    await store.set({ c: 3 })

    const data = await store.get()
    expect(data).toEqual({ c: 3 })
    expect('a' in data).toBe(false)
    expect('b' in data).toBe(false)
  })

  it('should isolate data between plugins', async () => {
    const filePath = await setupAuthFile()
    const storeA = createPluginStore(filePath, 'plugin-a')
    const storeB = createPluginStore(filePath, 'plugin-b')

    await storeA.set({ token: 'aaa' })
    await storeB.set({ token: 'bbb' })

    expect((await storeA.get()).token).toBe('aaa')
    expect((await storeB.get()).token).toBe('bbb')

    // Both exist on disk under _plugins
    const raw = await readFile(filePath, 'utf8')
    const disk = JSON.parse(raw)
    expect(disk._plugins['plugin-a'].token).toBe('aaa')
    expect(disk._plugins['plugin-b'].token).toBe('bbb')
  })

  it('should return empty object when no data exists', async () => {
    const filePath = await setupAuthFile()
    const store = createPluginStore(filePath, 'new-plugin')

    const data = await store.get()
    expect(data).toEqual({})
  })

  it('should return empty object when _plugins subtree is missing', async () => {
    const filePath = await setupAuthFile({
      'some-provider': { accessToken: 'existing-token' },
    })
    const store = createPluginStore(filePath, 'my-auth')

    const data = await store.get()
    expect(data).toEqual({})

    // set should create the _plugins subtree
    await store.set({ token: 'new' })

    const raw = await readFile(filePath, 'utf8')
    const disk = JSON.parse(raw)
    expect(disk._plugins['my-auth'].token).toBe('new')
    // OAuth data preserved
    expect(disk['some-provider'].accessToken).toBe('existing-token')
  })

  it('should not interfere with OAuth token data in the same auth.json', async () => {
    const filePath = await setupAuthFile({
      'oauth-provider': {
        accessToken: 'oauth-token-123',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600000,
      },
    })
    const store = createPluginStore(filePath, 'demo-auth')

    await store.set({ accessToken: 'plugin-token' })

    // OAuth data preserved
    const raw = await readFile(filePath, 'utf8')
    const disk = JSON.parse(raw)
    expect(disk['oauth-provider'].accessToken).toBe('oauth-token-123')
    expect(disk._plugins['demo-auth'].accessToken).toBe('plugin-token')
  })

  it('should preserve other plugins when writing', async () => {
    const filePath = await setupAuthFile({
      _plugins: {
        'other-plugin': { key: 'val' },
      },
    })
    const store = createPluginStore(filePath, 'my-auth')

    await store.set({ token: 'xxx' })

    const raw = await readFile(filePath, 'utf8')
    const disk = JSON.parse(raw)
    expect(disk._plugins['my-auth'].token).toBe('xxx')
    expect(disk._plugins['other-plugin'].key).toBe('val')
  })

  it('should support nested objects within plugin data', async () => {
    const filePath = await setupAuthFile()
    const store = createPluginStore(filePath, 'w3-auth')

    await store.set({
      w3: { accessToken: 'w3-token', refreshToken: 'w3-refresh' },
      zhipu: { accessToken: 'zhipu-token' },
    })

    const data = await store.get()
    expect((data.w3 as Record<string, unknown>).accessToken).toBe('w3-token')
    expect((data.zhipu as Record<string, unknown>).accessToken).toBe('zhipu-token')

    // Verify disk structure
    const raw = await readFile(filePath, 'utf8')
    const disk = JSON.parse(raw)
    expect(disk._plugins['w3-auth'].w3.accessToken).toBe('w3-token')
    expect(disk._plugins['w3-auth'].zhipu.accessToken).toBe('zhipu-token')
  })
})
