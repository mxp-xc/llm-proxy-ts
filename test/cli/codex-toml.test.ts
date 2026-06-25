import { describe, it, expect } from 'vitest'
import { applyCodexConfigEdits } from '../../src/cli/codex/toml.js'

const edits = {
  catalogFilename: 'llm-proxy-model-catalog.json',
  providerId: 'llm-proxy',
  providerName: 'LLM Proxy',
  baseUrl: 'http://127.0.0.1:8056/codex/v1',
  wireApi: 'responses' as const,
  modelSlug: 'zhipu/glm-5.2',
}

describe('applyCodexConfigEdits', () => {
  it('applies all 4 edits to an empty config with no overwrite reports', () => {
    const { content, overwritten } = applyCodexConfigEdits('', edits)
    expect(content).toContain('model_catalog_json = "llm-proxy-model-catalog.json"')
    expect(content).toContain('model_provider = "llm-proxy"')
    expect(content).toContain('model = "zhipu/glm-5.2"')
    expect(content).toContain('[model_providers.llm-proxy]')
    expect(content).toContain('base_url = "http://127.0.0.1:8056/codex/v1"')
    expect(content).toContain('wire_api = "responses"')
    expect(overwritten).toEqual([])
  })

  it('reports overwrite when model already set to a different value', () => {
    const content = 'model = "gpt-5"\n'
    const { content: out, overwritten } = applyCodexConfigEdits(content, edits)
    expect(out).toContain('model = "zhipu/glm-5.2"')
    expect(overwritten.some((r) => r.key === 'model' && r.oldValue === 'gpt-5')).toBe(true)
  })

  it('reports overwrite when provider table already exists', () => {
    const content = '[model_providers.llm-proxy]\nname = "old"\nenv_key = "X"\n'
    const { overwritten } = applyCodexConfigEdits(content, edits)
    expect(overwritten.some((r) => r.kind === 'provider-table' && r.key === 'llm-proxy')).toBe(true)
  })

  it('is idempotent: second run yields same content and no overwrites', () => {
    const first = applyCodexConfigEdits('', edits)
    const second = applyCodexConfigEdits(first.content, edits)
    expect(second.content).toBe(first.content)
    expect(second.overwritten).toEqual([])
  })

  it('preserves existing comments and other providers', () => {
    const content = '# my codex config\nmodel = "gpt-5"\n\n[model_providers.openai]\nname = "OpenAI"\n'
    const { content: out } = applyCodexConfigEdits(content, edits)
    expect(out).toContain('# my codex config')
    expect(out).toContain('[model_providers.openai]\nname = "OpenAI"')
  })

  it('is idempotent when existing model value contains an escaped quote', () => {
    // existing config already has the target slug written with an escaped quote in it.
    // slug with a literal quote char proves the comparison must be symmetric (de-quote, no unescape).
    const slugEdits = { ...edits, modelSlug: 'a"b' }
    const content = 'model = "a\\"b"\n'
    const { overwritten } = applyCodexConfigEdits(content, slugEdits)
    // existing raw value `a\"b` (de-quoted) == new formatted value `a\"b` (de-quoted) => no overwrite
    expect(overwritten).toEqual([])
  })
})
