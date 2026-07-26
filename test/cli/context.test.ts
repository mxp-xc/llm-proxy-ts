import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import { writeTempSettings } from '../helpers/temp-file.js'
import { resolveCliContext } from '../../src/cli/context.js'

vi.mock('../../src/env.js', () => ({ loadEnvironmentFiles: vi.fn() }))

describe('resolveCliContext', () => {
  it('resolves an injected temporary settings path', async () => {
    const previousSettingsFile = process.env.LLM_PROXY_SETTINGS_FILE
    const temp = await writeTempSettings('{}', 'llm-proxy-cli-context-')

    try {
      process.env.LLM_PROXY_SETTINGS_FILE = temp.path

      const ctx = resolveCliContext()
      expect(ctx.rootDir).toBe(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))
      expect(ctx.settingsPath).toBe(temp.path)
    } finally {
      if (previousSettingsFile === undefined) {
        delete process.env.LLM_PROXY_SETTINGS_FILE
      } else {
        process.env.LLM_PROXY_SETTINGS_FILE = previousSettingsFile
      }
      await temp.cleanup()
    }
  })
})
