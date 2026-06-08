import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginStore } from '../src/plugins/store-adapter.js'

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

  it('should read/write values under _plugins.{key}', async () => {
    const filePath = await setupAuthFile()
    const store = createPluginStore(filePath)

    await store.set('my-auth:cachedToken', 'abc123')
    const value = await store.get('my-auth:cachedToken')

    expect(value).toBe('abc123')

    // Verify the file has the expected structure
    const raw = await readFile(filePath, 'utf8')
    const data = JSON.parse(raw)
    expect(data._plugins['my-auth:cachedToken']).toBe('abc123')
  })

  it('should return undefined for missing keys', async () => {
    const filePath = await setupAuthFile({
      _plugins: {
        'my-auth:otherKey': 'otherValue',
      },
    })
    const store = createPluginStore(filePath)

    const value = await store.get('my-auth:nonexistent')

    expect(value).toBeUndefined()
  })

  it('should not interfere with OAuth token data in the same auth.json', async () => {
    const filePath = await setupAuthFile({
      'oauth-provider': {
        accessToken: 'oauth-token-123',
        tokenType: 'Bearer',
        expiresAt: Date.now() + 3600000,
      },
    })
    const store = createPluginStore(filePath)

    // Write plugin data
    await store.set('plugin-provider:cachedToken', 'plugin-token')

    // Verify OAuth data is preserved
    const raw = await readFile(filePath, 'utf8')
    const data = JSON.parse(raw)
    expect(data['oauth-provider'].accessToken).toBe('oauth-token-123')
    expect(data._plugins['plugin-provider:cachedToken']).toBe('plugin-token')
  })

  it('should handle missing _plugins subtree', async () => {
    const filePath = await setupAuthFile({
      'some-provider': { accessToken: 'existing-token' },
    })
    const store = createPluginStore(filePath)

    // get should return undefined when _plugins doesn't exist
    const value = await store.get('someKey')
    expect(value).toBeUndefined()

    // set should create the _plugins subtree
    await store.set('someKey', 'someValue')

    const raw = await readFile(filePath, 'utf8')
    const data = JSON.parse(raw)
    expect(data._plugins.someKey).toBe('someValue')
    // Existing data preserved
    expect(data['some-provider'].accessToken).toBe('existing-token')
  })

  it('should handle existing _plugins subtree with other keys', async () => {
    const filePath = await setupAuthFile({
      _plugins: {
        'other-provider:key': 'val',
      },
    })
    const store = createPluginStore(filePath)

    const value = await store.get('someKey')
    expect(value).toBeUndefined()

    // Writing should add to _plugins without clobbering other entries
    await store.set('newKey', 'newVal')

    const raw = await readFile(filePath, 'utf8')
    const data = JSON.parse(raw)
    expect(data._plugins.newKey).toBe('newVal')
    expect(data._plugins['other-provider:key']).toBe('val')
  })
})
