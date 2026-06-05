import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadTokenStore, saveTokenStore, getToken, setToken } from '../src/oauth/token-store.js';
import type { OAuthToken, TokenStore } from '../src/oauth/types.js';

function makeToken(overrides: Partial<OAuthToken> = {}): OAuthToken {
  return {
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() / 1000 + 3600,
    tokenType: 'Bearer',
    scope: 'read write',
    ...overrides,
  };
}

describe('token-store', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'oauth-store-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('loadTokenStore', () => {
    it('returns empty store when file does not exist', async () => {
      const store = await loadTokenStore(join(tempDir, 'nonexistent.json'));
      expect(store).toEqual({});
    });

    it('loads a valid token store', async () => {
      const path = join(tempDir, 'auth.json');
      const token = makeToken();
      await saveTokenStore(path, { 'my-provider': token });

      const store = await loadTokenStore(path);
      expect(store['my-provider']).toEqual(token);
    });

    it('returns empty store for corrupted JSON', async () => {
      const path = join(tempDir, 'auth.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, '{invalid json', 'utf8');

      const store = await loadTokenStore(path);
      expect(store).toEqual({});
    });

    it('returns empty store for non-object JSON', async () => {
      const path = join(tempDir, 'auth.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path, '[1,2,3]', 'utf8');

      const store = await loadTokenStore(path);
      expect(store).toEqual({});
    });
  });

  describe('saveTokenStore', () => {
    it('persists a token store to disk', async () => {
      const path = join(tempDir, 'auth.json');
      const token = makeToken();
      const store: TokenStore = { 'my-provider': token };

      await saveTokenStore(path, store);

      const loaded = await loadTokenStore(path);
      expect(loaded).toEqual(store);
    });

    it('creates parent directories if needed', async () => {
      const path = join(tempDir, 'sub', 'dir', 'auth.json');
      const store: TokenStore = { 'p': makeToken() };

      await saveTokenStore(path, store);

      const loaded = await loadTokenStore(path);
      expect(loaded).toEqual(store);
    });

    it('overwrites existing store', async () => {
      const path = join(tempDir, 'auth.json');

      await saveTokenStore(path, { 'a': makeToken({ accessToken: 'first' }) });
      await saveTokenStore(path, { 'b': makeToken({ accessToken: 'second' }) });

      const loaded = await loadTokenStore(path);
      expect(Object.keys(loaded)).toEqual(['b']);
      expect(loaded['b']!.accessToken).toBe('second');
    });
  });

  describe('getToken', () => {
    it('returns token for existing provider', () => {
      const token = makeToken();
      const store: TokenStore = { 'my-provider': token };
      expect(getToken(store, 'my-provider')).toBe(token);
    });

    it('returns undefined for missing provider', () => {
      const store: TokenStore = {};
      expect(getToken(store, 'unknown')).toBeUndefined();
    });
  });

  describe('setToken', () => {
    it('adds a token to the store', () => {
      const store: TokenStore = {};
      const token = makeToken();
      const result = setToken(store, 'new-provider', token);

      expect(result['new-provider']).toBe(token);
      expect(store).toEqual({}); // original unchanged
    });

    it('overwrites existing token', () => {
      const old = makeToken({ accessToken: 'old' });
      const store: TokenStore = { 'p': old };
      const newToken = makeToken({ accessToken: 'new' });
      const result = setToken(store, 'p', newToken);

      expect(result['p']).toBe(newToken);
      expect(store['p']).toBe(old); // original unchanged
    });
  });
});
