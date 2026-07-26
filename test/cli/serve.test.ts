import { describe, expect, it } from 'vitest'
import { createServeCommand } from '../../src/cli/serve.js'

describe('serve command', () => {
  it('parses a port override', () => {
    const command = createServeCommand()

    command.parseOptions(['--port', '4312'])

    expect(command.opts()).toMatchObject({ port: 4312 })
  })

  it.each(['0', '65536', '1.5', 'abc'])('rejects invalid port %j', (port) => {
    const command = createServeCommand()

    expect(() => command.parseOptions(['--port', port])).toThrow()
  })
})
