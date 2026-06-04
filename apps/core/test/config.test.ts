import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  generateSettingsJsonSchema,
  loadSettingsFromFile,
  resolveEnvPlaceholders,
} from '../src/config.js';

describe('config', () => {
  it('loads JSONC settings and resolves env placeholders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'));
    const settingsPath = join(dir, 'settings.jsonc');
    process.env.OPENROUTER_API_KEY = 'env-secret';

    await writeFile(
      settingsPath,
      `{
        // comments are allowed
        "service": { "name": "llm-proxy", "host": "127.0.0.1", "port": 8000 },
        "requestTimeoutMs": 30000,
        "proxy": { "url": "http://127.0.0.1:7890", "verify": false },
        "routing": { "enableFlatModelLookup": true },
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": "\${OPENROUTER_API_KEY}",
            "models": {
              "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1", "aliases": ["default"] }
            }
          }
        }
      }`,
    );

    const settings = await loadSettingsFromFile(settingsPath);

    expect(settings.proxy).toEqual({ url: 'http://127.0.0.1:7890', verify: false });
    expect(settings.providers.openrouter?.apiKey).toBe('env-secret');
    expect(settings.providers.openrouter?.models['deepseek-r1']?.upstreamModel).toBe(
      'deepseek/deepseek-r1',
    );
  });

  it('loads api key arrays and resolves env placeholders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'));
    const settingsPath = join(dir, 'settings.jsonc');
    process.env.OPENROUTER_API_KEY_1 = 'env-secret-1';
    process.env.OPENROUTER_API_KEY_2 = 'env-secret-2';

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": ["\${OPENROUTER_API_KEY_1}", "\${OPENROUTER_API_KEY_2}"],
            "models": {
              "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1" }
            }
          }
        }
      }`,
    );

    const settings = await loadSettingsFromFile(settingsPath);

    expect(settings.providers.openrouter?.apiKey).toEqual(['env-secret-1', 'env-secret-2']);
  });

  it('allows inline api keys', () => {
    expect(resolveEnvPlaceholders('ak-inline')).toBe('ak-inline');
  });

  it('rejects service ports outside the TCP port range', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'));
    const settingsPath = join(dir, 'settings.jsonc');

    await writeFile(
      settingsPath,
      `{
        "service": { "port": 65536 }
      }`,
    );

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow();
  });

  it('rejects empty model aliases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'));
    const settingsPath = join(dir, 'settings.jsonc');

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "models": {
              "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1", "aliases": [""] }
            }
          }
        }
      }`,
    );

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow();
  });

  it('rejects empty api key arrays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'));
    const settingsPath = join(dir, 'settings.jsonc');

    await writeFile(
      settingsPath,
      `{
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": [],
            "models": {
              "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1" }
            }
          }
        }
      }`,
    );

    await expect(loadSettingsFromFile(settingsPath)).rejects.toThrow();
  });

  it('generates a JSON schema from the Zod settings schema', () => {
    const schema = generateSettingsJsonSchema();

    expect(schema).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'Settings',
      type: 'object',
    });
    expect(JSON.stringify(schema)).toContain('providers');
    expect(JSON.stringify(schema)).toContain('apiKey');
  });

  it('accepts enableFlatModelLookup per-provider override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-proxy-config-'));
    const settingsPath = join(dir, 'settings.jsonc');

    await writeFile(
      settingsPath,
      `{
        "routing": { "enableFlatModelLookup": false },
        "providers": {
          "openrouter": {
            "type": "openai-compatible",
            "baseURL": "https://openrouter.ai/api/v1",
            "apiKey": "secret",
            "enableFlatModelLookup": true,
            "models": {
              "deepseek-r1": { "upstreamModel": "deepseek/deepseek-r1" }
            }
          }
        }
      }`,
    );

    const settings = await loadSettingsFromFile(settingsPath);
    expect(settings.providers.openrouter?.enableFlatModelLookup).toBe(true);
    expect(settings.routing.enableFlatModelLookup).toBe(false);
  });
});
