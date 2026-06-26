import { describe, it, expect } from 'vitest'
import { resolveCliContext } from '../../src/cli/context.js'

describe('resolveCliContext', () => {
  it('returns rootDir and settingsPath pointing at config/settings.jsonc', () => {
    const ctx = resolveCliContext()
    expect(ctx.rootDir).toMatch(/llm-proxy-ts([/\\].*)?$/)
    // Cross-platform: path may use / or \
    expect(ctx.settingsPath).toMatch(/config[/\\]settings\.jsonc$/)
  })
})
