import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/Users/test'),
}))

import { homedir } from 'node:os'
import {
  resolveCodexHome,
  resolveCodexConfigPath,
  resolveCodexCatalogPath,
} from '../../src/cli/codex/home.js'

const mockedHomedir = vi.mocked(homedir)

beforeEach(() => {
  vi.unstubAllEnvs()
  mockedHomedir.mockReturnValue('/Users/test')
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveCodexHome', () => {
  it('uses CODEX_HOME when set', () => {
    vi.stubEnv('CODEX_HOME', '/custom/codex')
    expect(resolveCodexHome()).toBe('/custom/codex')
  })
  it('falls back to homedir/.codex when CODEX_HOME empty', () => {
    vi.stubEnv('CODEX_HOME', '')
    mockedHomedir.mockReturnValue('/Users/test')
    expect(resolveCodexHome()).toBe('/Users/test/.codex')
  })
  it('falls back when CODEX_HOME unset', () => {
    // delete is not reversed by vi.unstubAllEnvs(); save/restore to avoid leaking.
    const orig = process.env.CODEX_HOME
    delete process.env.CODEX_HOME
    try {
      mockedHomedir.mockReturnValue('/Users/test')
      expect(resolveCodexHome()).toBe('/Users/test/.codex')
    } finally {
      if (orig === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = orig
    }
  })
})

describe('resolveCodexConfigPath', () => {
  it('joins config.toml', () => {
    expect(resolveCodexConfigPath('/c/h')).toBe('/c/h/config.toml')
  })
})

describe('resolveCodexCatalogPath', () => {
  it('joins default catalog filename', () => {
    expect(resolveCodexCatalogPath('/c/h')).toBe('/c/h/llm-proxy-model-catalog.json')
  })
  it('accepts custom filename', () => {
    expect(resolveCodexCatalogPath('/c/h', 'other.json')).toBe('/c/h/other.json')
  })
})
