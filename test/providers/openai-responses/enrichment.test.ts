import { describe, expect, it } from 'vitest'
import { buildResponsesEnrichment } from '../../../src/providers/openai-responses/enrichment.js'

describe('buildResponsesEnrichment', () => {
  it('keeps native OpenAI enrichment passthrough without shim flags', () => {
    const enrichment = buildResponsesEnrichment(
      {
        model: 'gpt-5',
        input: 'hi',
        tools: [
          { type: 'custom', name: 'apply_patch' },
          {
            type: 'namespace',
            name: 'codex_app',
            tools: [{ type: 'function', name: 'load_ws' }],
          },
          { type: 'tool_search', execution: 'client' },
        ],
      },
      'openai',
    )

    expect(enrichment).toMatchObject({ namespacePassthrough: true })
    expect(enrichment?.customToolNames).toEqual(new Set(['apply_patch']))
    expect(enrichment?.namespaceFlatMap?.get('codex_app__load_ws')).toEqual({
      namespace: 'codex_app',
      name: 'load_ws',
    })
    expect(enrichment?.customToolShimmed).toBeUndefined()
    expect(enrichment?.toolSearchShimmed).toBeUndefined()
  })

  it('keeps native OpenAI namespace passthrough even without declared tools', () => {
    expect(buildResponsesEnrichment({ model: 'gpt-5', input: 'hi' }, 'openai')).toEqual({
      namespacePassthrough: true,
    })
  })

  it('marks non-OpenAI custom tools and client tool_search as shimmed', () => {
    const enrichment = buildResponsesEnrichment(
      {
        model: 'glm-4.6',
        input: 'hi',
        tools: [
          { type: 'custom', name: 'my_grammar_tool' },
          { type: 'tool_search', execution: 'client' },
        ],
      },
      'openai-compatible',
    )

    expect(enrichment).toMatchObject({ customToolShimmed: true, toolSearchShimmed: true })
    expect(enrichment?.customToolNames).toEqual(new Set(['my_grammar_tool']))
  })

  it('returns undefined for non-OpenAI requests without enrichment needs', () => {
    expect(
      buildResponsesEnrichment({ model: 'glm-4.6', input: 'hi' }, 'openai-compatible'),
    ).toBeUndefined()
  })
})
