import { renameSync, writeFileSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeModelsEdits,
  applyMultipleProviderModels,
  writeSettingsFile,
} from '../../src/cli/models/settings-writer.js'
import type { ModelRouteConfig } from '../../src/config.js'

async function createFileSymlinkIfPermitted(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'file')
    return true
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) {
      return false
    }
    throw err
  }
}

const LOCK_CREATED_AT = '2026-07-25T00:00:00.000Z'

function settingsLockText(pid: number): string {
  return `${JSON.stringify({ pid, createdAt: LOCK_CREATED_AT })}\n`
}

function processProbeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`process probe failed with ${code}`), { code })
}

async function fileHandlePrototype(path: string): Promise<{
  writeFile: FileHandle['writeFile']
}> {
  const handle = await open(path, 'r')
  const prototype = Object.getPrototypeOf(handle) as {
    writeFile: FileHandle['writeFile']
  }
  await handle.close()
  return prototype
}

describe('settings-writer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('computeModelsEdits', () => {
    it('adds models to a provider that has no models', () => {
      const rawText = `{
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKey": "test-key"
    }
  }
}`

      const newModels: Record<string, ModelRouteConfig> = {
        'gpt-4o': { upstreamModel: 'gpt-4o', aliases: [], headers: {}, plugins: [] },
      }

      const result = computeModelsEdits(rawText, 'openrouter', newModels)
      const parsed = JSON.parse(result)

      expect(parsed.providers.openrouter.models['gpt-4o'].upstreamModel).toBe('gpt-4o')
    })

    it('replaces models for a provider', () => {
      const rawText = `{
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "models": {
        "old-model": { "upstreamModel": "old-model" }
      }
    }
  }
}`

      const newModels: Record<string, ModelRouteConfig> = {
        'new-model': { upstreamModel: 'new-model', aliases: [], headers: {}, plugins: [] },
      }

      const result = computeModelsEdits(rawText, 'openrouter', newModels)
      const parsed = JSON.parse(result)

      expect(parsed.providers.openrouter.models['new-model'].upstreamModel).toBe('new-model')
      expect(parsed.providers.openrouter.models['old-model']).toBeUndefined()
    })

    it('preserves comments outside the modified region', () => {
      const rawText = `{
  // top-level comment
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      // provider comment
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKey": "test-key",
      "models": {
        "gpt-4o": { "upstreamModel": "gpt-4o" }
      }
    }
  }
}`

      const newModels: Record<string, ModelRouteConfig> = {
        'gpt-4o': { upstreamModel: 'gpt-4o', aliases: [], headers: {}, plugins: [] },
        'claude-3': { upstreamModel: 'claude-3', aliases: [], headers: {}, plugins: [] },
      }

      const result = computeModelsEdits(rawText, 'openrouter', newModels)

      expect(result).toContain('// top-level comment')
      expect(result).toContain('// provider comment')

      const parsed = parseJsonc(result) as Record<string, unknown>
      const providers = parsed.providers as Record<string, Record<string, unknown>>
      const models = providers.openrouter!.models as Record<string, { upstreamModel: string }>
      expect(models['claude-3']?.upstreamModel).toBe('claude-3')
    })
  })

  describe('applyMultipleProviderModels', () => {
    it('applies changes to multiple providers sequentially', () => {
      const rawText = `{
  "providers": {
    "provider-a": {
      "type": "openai-compatible",
      "baseURL": "https://a.example.com/v1",
      "models": {}
    },
    "provider-b": {
      "type": "openai-compatible",
      "baseURL": "https://b.example.com/v1",
      "models": {}
    }
  }
}`

      const changes = [
        {
          providerName: 'provider-a',
          newModels: {
            'model-a1': { upstreamModel: 'model-a1', aliases: [], headers: {}, plugins: [] },
          },
        },
        {
          providerName: 'provider-b',
          newModels: {
            'model-b1': { upstreamModel: 'model-b1', aliases: [], headers: {}, plugins: [] },
          },
        },
      ]

      const result = applyMultipleProviderModels(rawText, changes)
      const parsed = JSON.parse(result)

      expect(parsed.providers['provider-a'].models['model-a1'].upstreamModel).toBe('model-a1')
      expect(parsed.providers['provider-b'].models['model-b1'].upstreamModel).toBe('model-b1')
    })

    it('second edit operates on text after first edit', () => {
      const rawText = `{
  "providers": {
    "alpha": {
      "type": "openai-compatible",
      "baseURL": "https://a.example.com/v1",
      "models": {}
    },
    "beta": {
      "type": "openai-compatible",
      "baseURL": "https://b.example.com/v1",
      "models": {}
    }
  }
}`

      const changes = [
        {
          providerName: 'alpha',
          newModels: {
            'gpt-4': { upstreamModel: 'gpt-4', aliases: [], headers: {}, plugins: [] },
          },
        },
        {
          providerName: 'beta',
          newModels: {
            'claude-3': { upstreamModel: 'claude-3', aliases: [], headers: {}, plugins: [] },
          },
        },
      ]

      const result = applyMultipleProviderModels(rawText, changes)
      const parsed = JSON.parse(result)

      expect(Object.keys(parsed.providers.alpha.models)).toContain('gpt-4')
      expect(Object.keys(parsed.providers.beta.models)).toContain('claude-3')
    })
  })

  describe('writeSettingsFile', () => {
    it('writes modified text to file', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        await writeSettingsFile(settingsPath, '{"updated": true}', '{}')

        const content = await readFile(settingsPath, 'utf8')
        expect(content).toBe('{"updated": true}')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('preserves file permissions and leaves no temporary file', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        await chmod(settingsPath, 0o640)
        await writeSettingsFile(settingsPath, '{"updated": true}', '{}')

        expect((await stat(settingsPath)).mode & 0o777).toBe(0o640)
        expect(await readdir(dir)).toEqual(['settings.jsonc'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('creates the temporary settings file as 0600 before writing it', async ({ skip }) => {
      if (process.platform === 'win32') {
        skip('POSIX creation modes are not enforced on Windows')
      }

      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')
      let originalUmask: number | undefined

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        await chmod(settingsPath, 0o644)
        originalUmask = process.umask(0o000)
        const prototype = await fileHandlePrototype(settingsPath)
        const originalWriteFile = prototype.writeFile
        const temporaryModes: number[] = []
        vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
          this: FileHandle,
          ...args: Parameters<FileHandle['writeFile']>
        ) {
          const temporaryName = (await readdir(dir)).find((name) => name.endsWith('.tmp'))
          if (temporaryName !== undefined) {
            temporaryModes.push((await stat(join(dir, temporaryName))).mode & 0o777)
          }
          return originalWriteFile.apply(this, args)
        })

        await writeSettingsFile(settingsPath, '{"updated": true}', '{}')

        expect(temporaryModes).toEqual([0o600])
        expect((await stat(settingsPath)).mode & 0o777).toBe(0o644)
        expect(await readdir(dir)).toEqual(['settings.jsonc'])
      } finally {
        if (originalUmask !== undefined) {
          process.umask(originalUmask)
        }
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('cleans temporary files when writing the temporary settings file fails', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')
      const writeError = new Error('injected temporary write failure')

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        const prototype = await fileHandlePrototype(settingsPath)
        const originalWriteFile = prototype.writeFile
        vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
          this: FileHandle,
          ...args: Parameters<FileHandle['writeFile']>
        ) {
          if ((await readdir(dir)).some((name) => name.endsWith('.tmp'))) {
            throw writeError
          }
          return originalWriteFile.apply(this, args)
        })

        await expect(writeSettingsFile(settingsPath, '{"updated": true}', '{}')).rejects.toBe(
          writeError,
        )
        await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{}')
        expect(await readdir(dir)).toEqual(['settings.jsonc'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('reports write and close failures while cleaning temporary files', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')
      const writeError = new Error('injected temporary write failure')
      const closeError = new Error('injected temporary close failure')

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        const prototype = await fileHandlePrototype(settingsPath)
        const originalWriteFile = prototype.writeFile
        vi.spyOn(prototype, 'writeFile').mockImplementation(async function (
          this: FileHandle,
          ...args: Parameters<FileHandle['writeFile']>
        ) {
          if ((await readdir(dir)).some((name) => name.endsWith('.tmp'))) {
            const originalClose = this.close
            vi.spyOn(this, 'close').mockImplementation(async function (this: FileHandle) {
              await originalClose.call(this)
              throw closeError
            })
            throw writeError
          }
          return originalWriteFile.apply(this, args)
        })

        const error = await writeSettingsFile(settingsPath, '{"updated": true}', '{}').catch(
          (err: unknown) => err,
        )

        expect(error).toBeInstanceOf(AggregateError)
        expect((error as AggregateError).errors).toEqual([writeError, closeError])
        await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{}')
        expect(await readdir(dir)).toEqual(['settings.jsonc'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('updates a relative symlink target without replacing the link', async ({ skip }) => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const targetDir = join(dir, 'target')
      const targetPath = join(targetDir, 'settings.jsonc')
      const settingsPath = join(dir, 'settings.jsonc')
      const relativeTarget = join('target', 'settings.jsonc')

      try {
        await mkdir(targetDir)
        await writeFile(targetPath, '{}', 'utf8')
        await chmod(targetPath, 0o640)
        if (!(await createFileSymlinkIfPermitted(relativeTarget, settingsPath))) {
          skip('creating file symlinks requires additional Windows privileges')
        }
        const before = await stat(targetPath)

        await writeSettingsFile(settingsPath, '{"updated": true}', '{}')

        const after = await stat(targetPath)
        expect((await lstat(settingsPath)).isSymbolicLink()).toBe(true)
        await expect(readlink(settingsPath)).resolves.toBe(relativeTarget)
        await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{"updated": true}')
        await expect(readFile(targetPath, 'utf8')).resolves.toBe('{"updated": true}')
        expect(after.mode & 0o7777).toBe(before.mode & 0o7777)
        expect(after.uid).toBe(before.uid)
        expect(after.gid).toBe(before.gid)
        expect(await readdir(targetDir)).toEqual(['settings.jsonc'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('uses one target lock for different symlinks to the same settings file', async ({
      skip,
    }) => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const targetDir = join(dir, 'target')
      const targetPath = join(targetDir, 'settings.jsonc')
      const firstSettingsPath = join(dir, 'first.jsonc')
      const secondSettingsPath = join(dir, 'second.jsonc')
      const relativeTarget = join('target', 'settings.jsonc')
      let releaseFirstWriter: (() => void) | undefined
      let firstWriterEntered: (() => void) | undefined
      const holdFirstWriter = new Promise<void>((resolve) => {
        releaseFirstWriter = resolve
      })
      const firstWriterIsLocked = new Promise<void>((resolve) => {
        firstWriterEntered = resolve
      })
      let firstWrite: Promise<void> | undefined

      try {
        await mkdir(targetDir)
        await writeFile(targetPath, '{}', 'utf8')
        const firstLinkCreated = await createFileSymlinkIfPermitted(
          relativeTarget,
          firstSettingsPath,
        )
        const secondLinkCreated = await createFileSymlinkIfPermitted(
          relativeTarget,
          secondSettingsPath,
        )
        if (!firstLinkCreated || !secondLinkCreated) {
          skip('creating file symlinks requires additional Windows privileges')
        }

        firstWrite = writeSettingsFile(
          firstSettingsPath,
          async () => {
            firstWriterEntered?.()
            await holdFirstWriter
            return '{"writer": 1}'
          },
          '{}',
        )

        await firstWriterIsLocked
        await expect(
          readFile(join(targetDir, '.settings.jsonc.lock'), 'utf8'),
        ).resolves.toBeTruthy()
        await expect(writeSettingsFile(secondSettingsPath, '{"writer": 2}', '{}')).rejects.toThrow(
          'settings update is already in progress',
        )

        releaseFirstWriter?.()
        await firstWrite
        await expect(readFile(targetPath, 'utf8')).resolves.toBe('{"writer": 1}')
        expect((await lstat(firstSettingsPath)).isSymbolicLink()).toBe(true)
        expect((await lstat(secondSettingsPath)).isSymbolicLink()).toBe(true)
        expect(await readdir(targetDir)).toEqual(['settings.jsonc'])
      } finally {
        releaseFirstWriter?.()
        await firstWrite?.catch(() => undefined)
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('rejects a missing settings path without leaving lock or temporary files', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'missing.jsonc')

      try {
        await expect(writeSettingsFile(settingsPath, '{"updated": true}', '{}')).rejects.toThrow()
        expect(await readdir(dir)).toEqual([])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('serializes concurrent writers without silently overwriting either result', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')
      let releaseFirstWriter: (() => void) | undefined
      let firstWriterEntered: (() => void) | undefined
      const holdFirstWriter = new Promise<void>((resolve) => {
        releaseFirstWriter = resolve
      })
      const firstWriterIsLocked = new Promise<void>((resolve) => {
        firstWriterEntered = resolve
      })
      let firstWrite: Promise<void> | undefined

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        firstWrite = writeSettingsFile(
          settingsPath,
          async () => {
            firstWriterEntered?.()
            await holdFirstWriter
            return '{"writer": 1}'
          },
          '{}',
        )

        await firstWriterIsLocked
        const lock = JSON.parse(await readFile(join(dir, '.settings.jsonc.lock'), 'utf8')) as {
          pid: number
          createdAt: string
        }
        expect(lock.pid).toBe(process.pid)
        expect(Number.isNaN(Date.parse(lock.createdAt))).toBe(false)
        await expect(writeSettingsFile(settingsPath, '{"writer": 2}', '{}')).rejects.toThrow(
          'settings update is already in progress',
        )
        await expect(readFile(join(dir, '.settings.jsonc.lock'), 'utf8')).resolves.toBeTruthy()

        releaseFirstWriter?.()
        await firstWrite
        expect(await readFile(settingsPath, 'utf8')).toBe('{"writer": 1}')
        expect(await readdir(dir)).toEqual(['settings.jsonc'])
      } finally {
        releaseFirstWriter?.()
        await firstWrite?.catch(() => undefined)
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('recovers a dead POSIX process lock and cleans every temporary artifact', async ({
      skip,
    }) => {
      if (process.platform === 'win32') {
        skip('automatic stale lock recovery is intentionally disabled on Windows')
      }

      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')
      const lockPath = join(dir, '.settings.jsonc.lock')
      const deadPid = 2_147_483_647

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        await writeFile(lockPath, settingsLockText(deadPid), { encoding: 'utf8', flag: 'wx' })
        const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          expect(pid).toBe(deadPid)
          expect(signal).toBe(0)
          throw processProbeError('ESRCH')
        })

        await writeSettingsFile(settingsPath, '{"updated": true}', '{}')

        expect(killSpy).toHaveBeenCalledOnce()
        await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{"updated": true}')
        expect(await readdir(dir)).toEqual(['settings.jsonc'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('rejects a lock owned by a live POSIX process without changing it', async ({ skip }) => {
      if (process.platform === 'win32') {
        skip('POSIX process probing is not used on Windows')
      }

      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')
      const lockPath = join(dir, '.settings.jsonc.lock')
      const livePid = process.pid === 424_242 ? 424_243 : 424_242
      const lockText = settingsLockText(livePid)

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        await writeFile(lockPath, lockText, { encoding: 'utf8', flag: 'wx' })
        const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          expect(pid).toBe(livePid)
          expect(signal).toBe(0)
          return true
        })

        await expect(writeSettingsFile(settingsPath, '{"updated": true}', '{}')).rejects.toThrow(
          `process ${livePid} is still running`,
        )

        expect(killSpy).toHaveBeenCalledOnce()
        await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{}')
        await expect(readFile(lockPath, 'utf8')).resolves.toBe(lockText)
        expect((await readdir(dir)).sort()).toEqual(['.settings.jsonc.lock', 'settings.jsonc'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('treats EPERM while probing a lock owner as an active lock', async ({ skip }) => {
      if (process.platform === 'win32') {
        skip('POSIX process probing is not used on Windows')
      }

      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')
      const lockPath = join(dir, '.settings.jsonc.lock')
      const ownerPid = process.pid === 525_252 ? 525_253 : 525_252
      const lockText = settingsLockText(ownerPid)

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        await writeFile(lockPath, lockText, { encoding: 'utf8', flag: 'wx' })
        vi.spyOn(process, 'kill').mockImplementation(() => {
          throw processProbeError('EPERM')
        })

        await expect(writeSettingsFile(settingsPath, '{"updated": true}', '{}')).rejects.toThrow(
          'EPERM',
        )

        await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{}')
        await expect(readFile(lockPath, 'utf8')).resolves.toBe(lockText)
        expect((await readdir(dir)).sort()).toEqual(['.settings.jsonc.lock', 'settings.jsonc'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it.each([
      ['malformed JSON', '{not-json}\n'],
      ['an invalid pid', settingsLockText(0)],
      ['a non-canonical createdAt', `${JSON.stringify({ pid: 123, createdAt: '2026-07-25' })}\n`],
      [
        'an unknown field',
        `${JSON.stringify({ pid: 123, createdAt: LOCK_CREATED_AT, owner: 'unknown' })}\n`,
      ],
    ])('rejects lock metadata with %s without removing it', async (_label, lockText) => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')
      const lockPath = join(dir, '.settings.jsonc.lock')

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        await writeFile(lockPath, lockText, { encoding: 'utf8', flag: 'wx' })
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
          throw new Error('process.kill must not be called for invalid metadata')
        })

        await expect(writeSettingsFile(settingsPath, '{"updated": true}', '{}')).rejects.toThrow(
          'invalid lock metadata',
        )

        expect(killSpy).not.toHaveBeenCalled()
        await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{}')
        await expect(readFile(lockPath, 'utf8')).resolves.toBe(lockText)
        expect((await readdir(dir)).sort()).toEqual(['.settings.jsonc.lock', 'settings.jsonc'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('does not remove a new lock that replaces a dead lock during inspection', async ({
      skip,
    }) => {
      if (process.platform === 'win32') {
        skip('automatic stale lock recovery is intentionally disabled on Windows')
      }

      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')
      const lockPath = join(dir, '.settings.jsonc.lock')
      const displacedLockPath = join(dir, '.settings.jsonc.displaced-lock')
      const deadPid = 2_147_483_647
      const replacementText = settingsLockText(deadPid)

      try {
        await writeFile(settingsPath, '{}', 'utf8')
        await writeFile(lockPath, replacementText, { encoding: 'utf8', flag: 'wx' })
        const originalLockStats = await lstat(lockPath)
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          expect(pid).toBe(deadPid)
          expect(signal).toBe(0)
          renameSync(lockPath, displacedLockPath)
          writeFileSync(lockPath, replacementText, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
          throw processProbeError('ESRCH')
        })

        await expect(writeSettingsFile(settingsPath, '{"updated": true}', '{}')).rejects.toThrow(
          'lock changed while stale lock recovery was checking it',
        )

        await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{}')
        await expect(readFile(lockPath, 'utf8')).resolves.toBe(replacementText)
        await expect(readFile(displacedLockPath, 'utf8')).resolves.toBe(replacementText)
        expect((await lstat(lockPath)).ino).not.toBe(originalLockStats.ino)
        expect((await readdir(dir)).sort()).toEqual([
          '.settings.jsonc.displaced-lock',
          '.settings.jsonc.lock',
          'settings.jsonc',
        ])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('rejects an in-place edit after compare and cleans all temporary files', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')

      try {
        await writeFile(settingsPath, '{}', 'utf8')

        await expect(
          writeSettingsFile(
            settingsPath,
            async () => {
              await writeFile(settingsPath, '{"concurrent": true}', 'utf8')
              return '{"updated": true}'
            },
            '{}',
          ),
        ).rejects.toThrow('settings file changed since it was loaded')
        await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{"concurrent": true}')
        expect(await readdir(dir)).toEqual(['settings.jsonc'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('rejects an atomic replacement after compare and cleans all temporary files', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')
      const replacementPath = join(dir, 'replacement.jsonc')

      try {
        await writeFile(settingsPath, '{}', 'utf8')

        await expect(
          writeSettingsFile(
            settingsPath,
            async () => {
              await writeFile(replacementPath, '{"replacement": true}', 'utf8')
              await rename(replacementPath, settingsPath)
              return '{"updated": true}'
            },
            '{}',
          ),
        ).rejects.toThrow('settings file changed since it was loaded')
        await expect(readFile(settingsPath, 'utf8')).resolves.toBe('{"replacement": true}')
        expect(await readdir(dir)).toEqual(['settings.jsonc'])
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })
})
