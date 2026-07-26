import { createServer } from 'node:http'
import { createAdaptorServer } from '@hono/node-server'
import { describe, expect, it } from 'vitest'
import { listenForStartup, resolveServerPort } from '../../src/server/server.js'

describe('resolveServerPort', () => {
  it('uses the configured port when no override is provided', () => {
    expect(resolveServerPort(8000)).toBe(8000)
  })

  it('uses a valid command-line port override', () => {
    expect(resolveServerPort(8000, '4312')).toBe(4312)
  })

  it.each(['0', '65536', '1.5', 'abc', ''])('rejects invalid port override %j', (value) => {
    expect(() => resolveServerPort(8000, value)).toThrow()
  })
})

describe('listenForStartup', () => {
  it('resolves only after the server is listening', async () => {
    const server = createAdaptorServer({ fetch: () => new Response('ok') })
    try {
      const address = await listenForStartup(server, '127.0.0.1', 0)

      expect(server.listening).toBe(true)
      expect(address.address).toBe('127.0.0.1')
      expect(address.port).toBeGreaterThan(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('rejects the original startup error when the port is already in use', async () => {
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve))
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('expected a network address')
    const candidate = createAdaptorServer({ fetch: () => new Response('ok') })

    try {
      await expect(listenForStartup(candidate, '127.0.0.1', address.port)).rejects.toMatchObject({
        code: 'EADDRINUSE',
      })
      expect(candidate.listening).toBe(false)
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()))
    }
  })
})
