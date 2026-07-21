import { afterEach, describe, expect, it, vi } from 'vitest'

describe('logging module import', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('node:fs')
  })

  it('does not create directories, scan logs, or open files', async () => {
    const mkdirSync = vi.fn()
    const readdirSync = vi.fn()
    const createWriteStream = vi.fn()
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return { ...actual, mkdirSync, readdirSync, createWriteStream }
    })

    await import('../../src/server/logging.js')

    expect(mkdirSync).not.toHaveBeenCalled()
    expect(readdirSync).not.toHaveBeenCalled()
    expect(createWriteStream).not.toHaveBeenCalled()
  })
})
