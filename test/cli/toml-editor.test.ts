import { describe, it, expect } from 'vitest'
import {
  formatTomlString,
  formatTomlBool,
  formatTableHeaderPath,
  setTopLevelKey,
  setProviderTable,
  readTopLevelKey,
  readProviderTableField,
} from '../../src/cli/codex/toml-editor.js'

describe('formatTomlString', () => {
  it('wraps in double quotes and escapes backslash/quote', () => {
    expect(formatTomlString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
  it('plain value', () => {
    expect(formatTomlString('llm-proxy-model-catalog.json')).toBe('"llm-proxy-model-catalog.json"')
  })
  it('escapes control characters (newline, tab, etc.)', () => {
    expect(formatTomlString('a\nb')).toBe('"a\\nb"')
    expect(formatTomlString('a\tb')).toBe('"a\\tb"')
    expect(formatTomlString('a\rb')).toBe('"a\\rb"')
  })
})

describe('formatTomlBool', () => {
  it('true/false', () => {
    expect(formatTomlBool(true)).toBe('true')
    expect(formatTomlBool(false)).toBe('false')
  })
})

describe('formatTableHeaderPath', () => {
  it('bare keys joined by dot', () => {
    expect(formatTableHeaderPath(['model_providers', 'llm-proxy'])).toBe('model_providers.llm-proxy')
  })
  it('non-bare key quoted', () => {
    expect(formatTableHeaderPath(['model_providers', 'weird id'])).toBe('model_providers."weird id"')
  })
})

describe('setTopLevelKey', () => {
  it('inserts into empty file with trailing newline', () => {
    expect(setTopLevelKey('', 'model', formatTomlString('glm-5.2'))).toBe('model = "glm-5.2"\n')
  })
  it('replaces existing root key, preserves leading comment', () => {
    const content = '# my model\nmodel = "gpt-5"\n'
    expect(setTopLevelKey(content, 'model', formatTomlString('glm-5.2')))
      .toBe('# my model\nmodel = "glm-5.2"\n')
  })
  it('inserts before first table with blank separator', () => {
    const content = '[model_providers.openai]\nname = "OpenAI"\n'
    const out = setTopLevelKey(content, 'model', formatTomlString('glm-5.2'))
    expect(out).toBe('model = "glm-5.2"\n\n[model_providers.openai]\nname = "OpenAI"\n')
  })
  it('does not touch same-named key inside a table', () => {
    const content = '[foo]\nmodel = "x"\n'
    const out = setTopLevelKey(content, 'model', formatTomlString('glm-5.2'))
    expect(out).toBe('model = "glm-5.2"\n\n[foo]\nmodel = "x"\n')
  })
  it('appends at EOF when no table and key missing', () => {
    const content = 'model_provider = "openai"\n'
    const out = setTopLevelKey(content, 'model', formatTomlString('glm-5.2'))
    expect(out).toBe('model_provider = "openai"\nmodel = "glm-5.2"\n')
  })
  it('preserves CRLF line endings', () => {
    const content = 'model = "gpt-5"\r\n'
    expect(setTopLevelKey(content, 'model', formatTomlString('glm-5.2'))).toBe('model = "glm-5.2"\r\n')
  })
})

describe('setProviderTable', () => {
  const fields = { name: 'LLM Proxy', base_url: 'http://127.0.0.1:8056/codex/v1', wire_api: 'responses' }
  it('appends new table at EOF with leading blank line', () => {
    const content = 'model = "glm-5.2"\n'
    const out = setProviderTable(content, 'llm-proxy', fields)
    expect(out).toBe(
      'model = "glm-5.2"\n\n[model_providers.llm-proxy]\nname = "LLM Proxy"\nbase_url = "http://127.0.0.1:8056/codex/v1"\nwire_api = "responses"\n',
    )
  })
  it('replaces existing table body wholesale, dropping extra fields', () => {
    const content = '[model_providers.llm-proxy]\nname = "old"\nenv_key = "X"\n'
    const out = setProviderTable(content, 'llm-proxy', fields)
    expect(out).toBe(
      '[model_providers.llm-proxy]\nname = "LLM Proxy"\nbase_url = "http://127.0.0.1:8056/codex/v1"\nwire_api = "responses"\n',
    )
    expect(out).not.toContain('env_key')
  })
  it('stops at next table header', () => {
    const content = '[model_providers.llm-proxy]\nname = "old"\n[model_providers.openai]\nname = "OpenAI"\n'
    const out = setProviderTable(content, 'llm-proxy', fields)
    expect(out).toContain('[model_providers.openai]\nname = "OpenAI"')
    expect(out).not.toContain('name = "old"')
  })
  it('does not match array-of-tables [[...]]', () => {
    const content = '[[model_providers.llm-proxy]]\nname = "old"\n'
    const out = setProviderTable(content, 'llm-proxy', fields)
    // array table untouched; new flat table appended
    expect(out).toContain('[[model_providers.llm-proxy]]\nname = "old"')
    expect(out).toContain('[model_providers.llm-proxy]\nname = "LLM Proxy"')
  })
  it('recognizes existing header with trailing comment (replaces, not duplicates)', () => {
    const content = '[model_providers.llm-proxy] # my provider\nname = "old"\n'
    const out = setProviderTable(content, 'llm-proxy', fields)
    // old body replaced, no duplicate header appended
    expect(out).toContain('[model_providers.llm-proxy] # my provider')
    expect(out).toContain('name = "LLM Proxy"')
    expect(out).not.toContain('name = "old"')
    const headerCount = (out.match(/\[model_providers\.llm-proxy\]/g) ?? []).length
    expect(headerCount).toBe(1)
  })
})

describe('splitLines (mixed line endings)', () => {
  it('splits mixed CRLF/LF content into clean lines (no embedded newlines)', () => {
    // round-trip via setTopLevelKey which uses splitLines internally.
    // Old split(eol) on mixed content left embedded \r/\n inside lines, corrupting matching.
    const content = 'model = "a"\r\nname = "b"\n'
    const out = setTopLevelKey(content, 'model', formatTomlString('c'))
    // model replaced (proves the CRLF line was matched cleanly)...
    expect(out).toContain('model = "c"')
    // ...and the lone-LF line is preserved intact (proves it wasn't swallowed/corrupted).
    expect(out).toContain('name = "b"')
    // No line should contain an embedded bare \n or \r mid-line (only as part of an EOL).
    // After join with dominant EOL (\r\n here), each logical line is `...\r\n` — verify the
    // lone-LF line did not keep its original trailing \n glued to the next line's content.
    expect(out.includes('"b"\n')).toBe(false)
  })
})

describe('readTopLevelKey', () => {
  it('reads root value', () => {
    expect(readTopLevelKey('model = "glm-5.2"\n', 'model')).toBe('glm-5.2')
  })
  it('returns undefined when missing', () => {
    expect(readTopLevelKey('model_provider = "x"\n', 'model')).toBeUndefined()
  })
  it('does not read key inside table', () => {
    expect(readTopLevelKey('[foo]\nmodel = "x"\n', 'model')).toBeUndefined()
  })
  it('strips trailing inline comment from value', () => {
    expect(readTopLevelKey('model = "x" # default\n', 'model')).toBe('x')
  })
})

describe('readProviderTableField', () => {
  it('reads field from target table', () => {
    const content = '[model_providers.llm-proxy]\nname = "LLM Proxy"\nbase_url = "http://x/codex/v1"\n'
    expect(readProviderTableField(content, 'llm-proxy', 'base_url')).toBe('http://x/codex/v1')
  })
  it('returns undefined when table missing', () => {
    expect(readProviderTableField('model = "x"\n', 'llm-proxy', 'base_url')).toBeUndefined()
  })
  it('returns undefined when field missing', () => {
    const content = '[model_providers.llm-proxy]\nname = "LLM Proxy"\n'
    expect(readProviderTableField(content, 'llm-proxy', 'base_url')).toBeUndefined()
  })
  it('strips trailing inline comment from field value', () => {
    const content = '[model_providers.llm-proxy]\nbase_url = "http://y" # proxy\n'
    expect(readProviderTableField(content, 'llm-proxy', 'base_url')).toBe('http://y')
  })
})
