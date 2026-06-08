import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import {
  computeModelsEdits,
  applyMultipleProviderModels,
  writeSettingsFile,
} from '../src/cli/settings-writer.js'
import type { ModelRouteConfig } from '../src/config.js'

describe('settings-writer', () => {
  describe('computeModelsEdits', () => {
    it('adds models to a provider that has no models', () => {
      const rawText = `{
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKey": "test-key"
    }
  }
}`

      const newModels: Record<string, ModelRouteConfig> = {
        'gpt-4o': { upstreamModel: 'gpt-4o', aliases: [], headers: {}, plugins: [] },
      }

      const result = computeModelsEdits(rawText, 'openrouter', newModels)
      const parsed = JSON.parse(result)

      expect(parsed.providers.openrouter.models['gpt-4o'].upstreamModel).toBe('gpt-4o')
    })

    it('replaces models for a provider', () => {
      const rawText = `{
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      "baseURL": "https://openrouter.ai/api/v1",
      "models": {
        "old-model": { "upstreamModel": "old-model" }
      }
    }
  }
}`

      const newModels: Record<string, ModelRouteConfig> = {
        'new-model': { upstreamModel: 'new-model', aliases: [], headers: {}, plugins: [] },
      }

      const result = computeModelsEdits(rawText, 'openrouter', newModels)
      const parsed = JSON.parse(result)

      expect(parsed.providers.openrouter.models['new-model'].upstreamModel).toBe('new-model')
      expect(parsed.providers.openrouter.models['old-model']).toBeUndefined()
    })

    it('preserves comments outside the modified region', () => {
      const rawText = `{
  // top-level comment
  "providers": {
    "openrouter": {
      "type": "openai-compatible",
      // provider comment
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKey": "test-key",
      "models": {
        "gpt-4o": { "upstreamModel": "gpt-4o" }
      }
    }
  }
}`

      const newModels: Record<string, ModelRouteConfig> = {
        'gpt-4o': { upstreamModel: 'gpt-4o', aliases: [], headers: {}, plugins: [] },
        'claude-3': { upstreamModel: 'claude-3', aliases: [], headers: {}, plugins: [] },
      }

      const result = computeModelsEdits(rawText, 'openrouter', newModels)

      expect(result).toContain('// top-level comment')
      expect(result).toContain('// provider comment')

      const parsed = parseJsonc(result) as Record<string, unknown>
      const providers = parsed.providers as Record<string, Record<string, unknown>>
      const models = providers.openrouter!.models as Record<string, { upstreamModel: string }>
      expect(models['claude-3']?.upstreamModel).toBe('claude-3')
    })
  })

  describe('applyMultipleProviderModels', () => {
    it('applies changes to multiple providers sequentially', () => {
      const rawText = `{
  "providers": {
    "provider-a": {
      "type": "openai-compatible",
      "baseURL": "https://a.example.com/v1",
      "models": {}
    },
    "provider-b": {
      "type": "openai-compatible",
      "baseURL": "https://b.example.com/v1",
      "models": {}
    }
  }
}`

      const changes = [
        {
          providerName: 'provider-a',
          newModels: {
            'model-a1': { upstreamModel: 'model-a1', aliases: [], headers: {}, plugins: [] },
          },
        },
        {
          providerName: 'provider-b',
          newModels: {
            'model-b1': { upstreamModel: 'model-b1', aliases: [], headers: {}, plugins: [] },
          },
        },
      ]

      const result = applyMultipleProviderModels(rawText, changes)
      const parsed = JSON.parse(result)

      expect(parsed.providers['provider-a'].models['model-a1'].upstreamModel).toBe('model-a1')
      expect(parsed.providers['provider-b'].models['model-b1'].upstreamModel).toBe('model-b1')
    })

    it('second edit operates on text after first edit', () => {
      const rawText = `{
  "providers": {
    "alpha": {
      "type": "openai-compatible",
      "baseURL": "https://a.example.com/v1",
      "models": {}
    },
    "beta": {
      "type": "openai-compatible",
      "baseURL": "https://b.example.com/v1",
      "models": {}
    }
  }
}`

      const changes = [
        {
          providerName: 'alpha',
          newModels: {
            'gpt-4': { upstreamModel: 'gpt-4', aliases: [], headers: {}, plugins: [] },
          },
        },
        {
          providerName: 'beta',
          newModels: {
            'claude-3': { upstreamModel: 'claude-3', aliases: [], headers: {}, plugins: [] },
          },
        },
      ]

      const result = applyMultipleProviderModels(rawText, changes)
      const parsed = JSON.parse(result)

      expect(Object.keys(parsed.providers.alpha.models)).toContain('gpt-4')
      expect(Object.keys(parsed.providers.beta.models)).toContain('claude-3')
    })
  })

  describe('writeSettingsFile', () => {
    it('writes modified text to file', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-writer-'))
      const settingsPath = join(dir, 'settings.jsonc')

      await writeFile(settingsPath, '{}', 'utf8')
      await writeSettingsFile(settingsPath, '{"updated": true}')

      const content = await readFile(settingsPath, 'utf8')
      expect(content).toBe('{"updated": true}')
    })
  })
})
