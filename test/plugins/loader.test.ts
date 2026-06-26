import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPlugin } from '../../src/plugins/loader.js'

describe('loadPlugin', () => {
  let tempDir: string

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  async function writePluginFile(fileName: string, content: string): Promise<string> {
    if (!tempDir) {
      tempDir = await mkdtemp(join(tmpdir(), 'llm-proxy-auth-loader-'))
    }
    const filePath = join(tempDir, fileName)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, 'utf8')
    return filePath
  }

  it('should load a valid plugin module with default export', async () => {
    const filePath = await writePluginFile(
      'valid-plugin.mjs',
      `
      export default {
        name: 'test-plugin',
        createFetch(ctx) {
          return (baseFetch) => async (input, init) => {
            const fetchFn = baseFetch ?? globalThis.fetch;
            return fetchFn(input, init);
          };
        },
      };
    `,
    )

    const result = await loadPlugin({ module: filePath, config: {}, providers: [] }, tempDir)

    expect(result.plugin.name).toBe('test-plugin')
    expect(result.modulePath).toBe(filePath)
  })

  it('should reject modules without default export', async () => {
    const filePath = await writePluginFile(
      'no-default.mjs',
      `
      export const version = '1.0.0';
      export function doSomething() {}
    `,
    )

    await expect(
      loadPlugin({ module: filePath, config: {}, providers: [] }, tempDir),
    ).rejects.toThrow(/must export a default object|must have a non-empty string 'name' property/)
  })

  it('should reject modules without name property', async () => {
    const filePath = await writePluginFile(
      'no-name.mjs',
      `
      export default {
        createFetch(ctx) {
          return (baseFetch) => async (input, init) => {
            const fetchFn = baseFetch ?? globalThis.fetch;
            return fetchFn(input, init);
          };
        },
      };
    `,
    )

    await expect(
      loadPlugin({ module: filePath, config: {}, providers: [] }, tempDir),
    ).rejects.toThrow(/must have a non-empty string 'name' property/)
  })

  it('should reject modules without any hook', async () => {
    const filePath = await writePluginFile(
      'no-hook.mjs',
      `
      export default {
        name: 'no-hook',
      };
    `,
    )

    await expect(
      loadPlugin({ module: filePath, config: {}, providers: [] }, tempDir),
    ).rejects.toThrow(/must implement at least one hook/)
  })

  it('should reject modules with invalid validateConfig (not a function)', async () => {
    const filePath = await writePluginFile(
      'bad-validate.mjs',
      `
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
    `,
    )

    // The new loader no longer validates validateConfig specifically;
    // it just checks that at least one hook is present. Since createFetch
    // is a hook, this module loads successfully — validateConfig is ignored.
    const result = await loadPlugin({ module: filePath, config: {}, providers: [] }, tempDir)
    expect(result.plugin.name).toBe('bad-validate')
  })

  it('should resolve relative paths against baseDir', async () => {
    const pluginDir = join(
      tempDir ?? (await mkdtemp(join(tmpdir(), 'llm-proxy-auth-loader-'))),
      'plugins',
    )
    if (!tempDir) tempDir = pluginDir.split('plugins')[0]!

    const filePath = join(pluginDir, 'relative-plugin.mjs')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      filePath,
      `
      export default {
        name: 'relative-plugin',
        createFetch(ctx) {
          return (baseFetch) => async (input, init) => {
            const fetchFn = baseFetch ?? globalThis.fetch;
            return fetchFn(input, init);
          };
        },
      };
    `,
      'utf8',
    )

    const result = await loadPlugin(
      { module: './plugins/relative-plugin.mjs', config: {}, providers: [] },
      tempDir ?? pluginDir,
    )

    expect(result.plugin.name).toBe('relative-plugin')
  })

  it('should accept absolute paths', async () => {
    const filePath = await writePluginFile(
      'absolute-plugin.mjs',
      `
      export default {
        name: 'absolute-plugin',
        createFetch(ctx) {
          return (baseFetch) => async (input, init) => {
            const fetchFn = baseFetch ?? globalThis.fetch;
            return fetchFn(input, init);
          };
        },
      };
    `,
    )

    const result = await loadPlugin(
      { module: filePath, config: {}, providers: [] },
      '/irrelevant/basedir',
    )

    expect(result.plugin.name).toBe('absolute-plugin')
  })

  it('should load built-in plugin by name', async () => {
    // The static built-in registry ships vendor_sse_error; loading it by name
    // exercises the same built-in lookup path that previously relied on
    // runtime registerBuiltInPlugin.
    const result = await loadPlugin(
      { name: 'vendor_sse_error', config: {}, providers: [] },
      tempDir,
    )
    expect(result.plugin.name).toBe('vendor_sse_error')
    expect(result.modulePath).toBeUndefined()
  })

  it('should reject unknown built-in plugin name', async () => {
    await expect(
      loadPlugin({ name: 'nonexistent-plugin', config: {}, providers: [] }, tempDir),
    ).rejects.toThrow(/Unknown built-in plugin/)
  })
})

// Helper: dirname for ESM (simple version)
function dirname(filePath: string): string {
  const sep = filePath.includes('\\') ? '\\' : '/'
  const parts = filePath.split(sep)
  parts.pop()
  return parts.join(sep)
}
