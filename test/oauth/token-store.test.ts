import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  loadAuthFile,
  saveAuthFile,
  extractTokenStore,
  mergeTokenStore,
} from '../../src/oauth/token-store.js'
import type { OAuthToken, TokenStore } from '../../src/oauth/types.js'

function makeToken(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() / 1000 + 3600,
    tokenType: 'Bearer',
    scope: 'read write',
    ...overrides,
  }
}

describe('token-store', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oauth-store-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('loadAuthFile + extractTokenStore', () => {
    it('returns empty store when file does not exist', async () => {
      const data = await loadAuthFile(join(tempDir, 'nonexistent.json'))
      expect(extractTokenStore(data)).toEqual({})
    })

    it('loads a valid token store', async () => {
      const path = join(tempDir, 'auth.json')
      const token = makeToken()
      await saveAuthFile(path, { 'my-provider': token })

      const data = await loadAuthFile(path)
      const store = extractTokenStore(data)
      expect(store['my-provider']).toEqual(token)
    })

    it('returns empty store for corrupted JSON', async () => {
      const path = join(tempDir, 'auth.json')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, '{invalid json', 'utf8')

      const data = await loadAuthFile(path)
      expect(extractTokenStore(data)).toEqual({})
    })

    it('returns empty store for non-object JSON', async () => {
      const path = join(tempDir, 'auth.json')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, '[1,2,3]', 'utf8')

      const data = await loadAuthFile(path)
      expect(extractTokenStore(data)).toEqual({})
    })
  })

  describe('saveAuthFile + mergeTokenStore', () => {
    it('persists a token store to disk', async () => {
      const path = join(tempDir, 'auth.json')
      const token = makeToken()
      const store: TokenStore = { 'my-provider': token }

      await saveAuthFile(path, mergeTokenStore({}, store))

      const data = await loadAuthFile(path)
      expect(extractTokenStore(data)).toEqual(store)
    })

    it('creates parent directories if needed', async () => {
      const path = join(tempDir, 'sub', 'dir', 'auth.json')
      const store: TokenStore = { p: makeToken() }

      await saveAuthFile(path, mergeTokenStore({}, store))

      const data = await loadAuthFile(path)
      expect(extractTokenStore(data)).toEqual(store)
    })

    it('overwrites existing store', async () => {
      const path = join(tempDir, 'auth.json')

      await saveAuthFile(path, mergeTokenStore({}, { a: makeToken({ accessToken: 'first' }) }))
      await saveAuthFile(path, mergeTokenStore(await loadAuthFile(path), { b: makeToken({ accessToken: 'second' }) }))

      const data = await loadAuthFile(path)
      const store = extractTokenStore(data)
      expect(Object.keys(store)).toEqual(['b'])
      expect(store['b']!.accessToken).toBe('second')
    })

    it('preserves _plugins data when merging', async () => {
      const path = join(tempDir, 'auth.json')
      const token = makeToken()
      const pluginData = { _plugins: { myPlugin: { key: 'value' } } }

      await saveAuthFile(path, { ...pluginData, 'my-provider': token })

      const data = await loadAuthFile(path)
      const merged = mergeTokenStore(data, { 'my-provider': token })
      expect(merged._plugins).toEqual({ myPlugin: { key: 'value' } })
    })
  })

  describe('getToken (inline)', () => {
    it('returns token for existing provider', () => {
      const token = makeToken()
      const store: TokenStore = { 'my-provider': token }
      expect(store['my-provider']).toBe(token)
    })

    it('returns undefined for missing provider', () => {
      const store: TokenStore = {}
      expect(store['unknown']).toBeUndefined()
    })
  })

  describe('setToken (inline)', () => {
    it('adds a token to the store', () => {
      const store: TokenStore = {}
      const token = makeToken()
      const result: TokenStore = { ...store, 'new-provider': token }

      expect(result['new-provider']).toBe(token)
      expect(store).toEqual({}) // original unchanged
    })

    it('overwrites existing token', () => {
      const old = makeToken({ accessToken: 'old' })
      const store: TokenStore = { p: old }
      const newToken = makeToken({ accessToken: 'new' })
      const result: TokenStore = { ...store, p: newToken }

      expect(result['p']).toBe(newToken)
      expect(store['p']).toBe(old) // original unchanged
    })
  })
})
