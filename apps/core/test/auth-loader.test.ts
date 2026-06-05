import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAuthPlugin } from '../src/auth/loader.js';

describe('loadAuthPlugin', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function writePluginFile(fileName: string, content: string): Promise<string> {
    if (!tempDir) {
      tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-auth-loader-'));
    }
    const filePath = join(tempDir, fileName);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  it('should load a valid plugin module with default export', async () => {
    const filePath = await writePluginFile('valid-plugin.mjs', `
      export default {
        name: 'test-plugin',
        createFetch(ctx) {
          return (baseFetch) => async (input, init) => {
            const fetchFn = baseFetch ?? globalThis.fetch;
            return fetchFn(input, init);
          };
        },
      };
    `);

    const result = await loadAuthPlugin(filePath, tempDir);

    expect(result.plugin.name).toBe('test-plugin');
    expect(result.plugin.createFetch).toBeTypeOf('function');
    expect(result.modulePath).toBe(filePath);
  });

  it('should reject modules without default export', async () => {
    // The loader falls back to mod.default ?? mod, so a module with named
    // exports that happen to match the plugin shape would still pass.
    // Use a module that exports nothing plugin-like to trigger the rejection.
    const filePath = await writePluginFile('no-default.mjs', `
      export const version = '1.0.0';
      export function doSomething() {}
    `);

    await expect(loadAuthPlugin(filePath, tempDir)).rejects.toThrow(
      /must export a default object|must have a non-empty string 'name' property/,
    );
  });

  it('should reject modules without name property', async () => {
    const filePath = await writePluginFile('no-name.mjs', `
      export default {
        createFetch(ctx) {
          return (baseFetch) => async (input, init) => {
            const fetchFn = baseFetch ?? globalThis.fetch;
            return fetchFn(input, init);
          };
        },
      };
    `);

    await expect(loadAuthPlugin(filePath, tempDir)).rejects.toThrow(
      /must have a non-empty string 'name' property/,
    );
  });

  it('should reject modules without createFetch method', async () => {
    const filePath = await writePluginFile('no-createfetch.mjs', `
      export default {
        name: 'no-createfetch',
      };
    `);

    await expect(loadAuthPlugin(filePath, tempDir)).rejects.toThrow(
      /must have a 'createFetch' method/,
    );
  });

  it('should reject modules with invalid validateConfig (not a function)', async () => {
    const filePath = await writePluginFile('bad-validate.mjs', `
      export default {
        name: 'bad-validate',
        createFetch(ctx) {
          return (baseFetch) => async (input, init) => {
            const fetchFn = baseFetch ?? globalThis.fetch;
            return fetchFn(input, init);
          };
        },
        validateConfig: 'not-a-function',
      };
    `);

    await expect(loadAuthPlugin(filePath, tempDir)).rejects.toThrow(
      /'validateConfig' must be a function/,
    );
  });

  it('should resolve relative paths against baseDir', async () => {
    const pluginDir = join(tempDir ?? await mkdtemp(join(tmpdir(), 'llm-proxy-auth-loader-')), 'plugins');
    if (!tempDir) tempDir = pluginDir.split('plugins')[0]!;

    const filePath = join(pluginDir, 'relative-plugin.mjs');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(filePath, `
      export default {
        name: 'relative-plugin',
        createFetch(ctx) {
          return (baseFetch) => async (input, init) => {
            const fetchFn = baseFetch ?? globalThis.fetch;
            return fetchFn(input, init);
          };
        },
      };
    `, 'utf8');

    const result = await loadAuthPlugin('./plugins/relative-plugin.mjs', tempDir ?? pluginDir);

    expect(result.plugin.name).toBe('relative-plugin');
  });

  it('should accept absolute paths', async () => {
    const filePath = await writePluginFile('absolute-plugin.mjs', `
      export default {
        name: 'absolute-plugin',
        createFetch(ctx) {
          return (baseFetch) => async (input, init) => {
            const fetchFn = baseFetch ?? globalThis.fetch;
            return fetchFn(input, init);
          };
        },
      };
    `);

    const result = await loadAuthPlugin(filePath, '/irrelevant/basedir');

    expect(result.plugin.name).toBe('absolute-plugin');
  });
});

// Helper: dirname for ESM (simple version)
function dirname(filePath: string): string {
  const sep = filePath.includes('\\') ? '\\' : '/';
  const parts = filePath.split(sep);
  parts.pop();
  return parts.join(sep);
}
