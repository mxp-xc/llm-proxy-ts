import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import type { AISDKInput } from '../../src/providers/shared/aisdk-types.js'
import type { GenerateTextReturn } from '../../src/server/types.js'
import { makeGateway } from '../helpers/gateway.js'
import { createProviderRegistryStub } from '../helpers/registry.js'
import { makeSettings } from '../helpers/settings.js'

const providerRegistry = createProviderRegistryStub()

function successfulResult(): GenerateTextReturn {
  return {
    text: 'ok',
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as GenerateTextReturn
}

describe('disabled-tools request filtering', () => {
  it('filters provider and model tools from Chat Completions input', async () => {
    let captured: AISDKInput | undefined
    const settings = makeSettings({
      openrouter: {
        type: 'openai-compatible',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        options: { 'disabled-tools': ['provider_blocked'] },
        models: {
          chat: {
            upstreamModel: 'gpt-5',
            aliases: [],
            headers: {},
            plugins: [],
            'disabled-tools': ['model_blocked'],
          },
        },
      },
    })
    const gateway = makeGateway({
      async generate({ callInput }) {
        captured = callInput
        return successfulResult()
      },
    })
    const app = createApp({ settings, gateway, providerRegistry })

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openrouter/chat',
        messages: [{ role: 'user', content: 'hi' }],
        tools: ['keep', 'provider_blocked', 'model_blocked'].map((name) => ({
          type: 'function',
          function: { name, parameters: { type: 'object' } },
        })),
        tool_choice: { type: 'function', function: { name: 'model_blocked' } },
      }),
    })

    expect(response.status).toBe(200)
    expect(Object.keys(captured?.tools ?? {})).toEqual(['keep'])
    expect(captured?.toolChoice).toBe('auto')
  })

  it('filters provider and model tools from Anthropic Messages input', async () => {
    let captured: AISDKInput | undefined
    const settings = makeSettings({
      claude: {
        type: 'anthropic',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        options: { 'disabled-tools': ['provider_blocked'] },
        models: {
          sonnet: {
            upstreamModel: 'claude-sonnet-4-5',
            aliases: [],
            headers: {},
            plugins: [],
            'disabled-tools': [{ glob: 'model_*' }],
          },
        },
      },
    })
    const gateway = makeGateway({
      async generate({ callInput }) {
        captured = callInput
        return successfulResult()
      },
    })
    const app = createApp({ settings, gateway, providerRegistry })

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude/sonnet',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        tools: ['keep', 'provider_blocked', 'model_blocked'].map((name) => ({
          name,
          input_schema: { type: 'object' },
        })),
        tool_choice: { type: 'any' },
      }),
    })

    expect(response.status).toBe(200)
    expect(Object.keys(captured?.tools ?? {})).toEqual(['keep'])
    expect(captured?.toolChoice).toBe('required')
  })

  it('filters native namespace, hosted, and dynamically discovered Responses tools', async () => {
    let captured: AISDKInput | undefined
    const settings = makeSettings({
      openai: {
        type: 'openai',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        options: { 'disabled-tools': ['web_search'] },
        models: {
          chat: {
            upstreamModel: 'gpt-5',
            aliases: [],
            headers: {},
            plugins: [],
            'disabled-tools': [{ glob: 'spawn_*' }],
          },
        },
      },
    })
    const gateway = makeGateway({
      async generate({ callInput }) {
        captured = callInput
        return {
          text: '',
          finishReason: 'stop',
          response: { body: { id: 'resp_1', output: [] } },
        } as GenerateTextReturn
      },
    })
    const app = createApp({ settings, gateway, providerRegistry })

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/chat',
        input: [
          { type: 'tool_search_call', call_id: 'ts_1', arguments: { query: 'agent' } },
          {
            type: 'tool_search_output',
            call_id: 'ts_1',
            tools: [
              {
                type: 'namespace',
                name: 'multi_agent_v1',
                tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
              },
            ],
          },
        ],
        tools: [
          { type: 'function', name: 'keep', parameters: { type: 'object' } },
          {
            type: 'namespace',
            name: 'multi_agent_v1',
            tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
          },
          { type: 'web_search', external_web_access: true },
        ],
        tool_choice: 'required',
      }),
    })

    expect(response.status).toBe(200)
    expect(Object.keys(captured?.tools ?? {})).toEqual(['keep'])
    expect(captured?.toolChoice).toBe('required')
  })
})
