import type { ModelGateway } from '../../src/server/app.js'

export function makeGateway(opts: Partial<ModelGateway> = {}): ModelGateway {
  return {
    async generate() {
      throw new Error('not used')
    },
    stream() {
      throw new Error('not used')
    },
    ...opts,
  }
}
