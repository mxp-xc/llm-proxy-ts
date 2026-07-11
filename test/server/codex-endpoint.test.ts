import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { makeSettings } from '../helpers/settings.js'
import { stubRegistry } from '../helpers/registry.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import { makeGateway } from '../helpers/gateway.js'
import type { GenerateTextReturn } from '../../src/server/types.js'
import { CodexCatalogCache, type CodexCatalogFetcher } from '../../src/codex-catalog.js'

const openrouterSettings = makeSettings({
  openrouter: {
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'secret',
    headers: {},
    plugins: [],
    models: { chat: { upstreamModel: 'openrouter/chat', aliases: [], headers: {}, plugins: [] } },
  },
})

const FULL_MODEL = {
  slug: 'gpt-5.4',
  display_name: 'GPT-5.4',
  supported_reasoning_levels: [],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 0,
  base_instructions: 'x',
  supports_reasoning_summaries: false,
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  supports_parallel_tool_calls: false,
  experimental_supported_tools: [],
}

const codexFetcher: CodexCatalogFetcher = async () => JSON.stringify({ models: [FULL_MODEL] })

describe('GET /codex/v1/models', () => {
  it('returns codex ModelsResponse with one entry per listModels id', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogCache: new CodexCatalogCache(codexFetcher),
    })
    const res = await app.request('/codex/v1/models')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.models).toHaveLength(1)
    expect(body.models[0].slug).toBe('openrouter/chat')
    expect(body.models[0].visibility).toBe('list')
    expect(body.models[0].supported_in_api).toBe(true)
  })

  it('injects x-request-id (middleware covers /codex)', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogCache: new CodexCatalogCache(codexFetcher),
    })
    const res = await app.request('/codex/v1/models')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('returns 503 when codex fetch fails', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogCache: new CodexCatalogCache(async () => {
        throw new Error('codex not installed')
      }),
    })
    const res = await app.request('/codex/v1/models')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.type).toBe('server_error')
    expect(body.error.message).toContain('codex not installed')
  })

  it('returns 503 with short reason (no ZodError JSON) on catalog schema failure', async () => {
    const app = createApp({
      settings: openrouterSettings,
      providerRegistry: stubRegistry,
      codexCatalogCache: new CodexCatalogCache(async () => JSON.stringify({ models: [{}] })),
    })
    const res = await app.request('/codex/v1/models')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.type).toBe('server_error')
    expect(body.error.message).toContain('schema validation failed')
    expect(body.error.message).not.toMatch(/"issues"|"path"|"received"/)
  })
})

/** 剥离响应中的随机字段(id / created_at),用于跨路径结构对比。 */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'id' || k === 'created_at') continue
      out[k] = stripVolatile(v)
    }
    return out
  }
  return value
}

const responsesBody = JSON.stringify({ model: 'openrouter/chat', input: 'hi' })

describe('POST /codex/v1/responses', () => {
  it('returns the same non-streaming response as /v1/responses (minus volatile fields)', async () => {
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'hello',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as GenerateTextReturn
      },
    })
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })
    const [codexRes, v1Res] = await Promise.all([
      app.request('/codex/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: responsesBody,
      }),
      app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: responsesBody,
      }),
    ])
    expect(codexRes.status).toBe(200)
    expect(stripVolatile(await codexRes.json())).toEqual(stripVolatile(await v1Res.json()))
  })

  it('streams the same SSE event sequence as /v1/responses', async () => {
    const gateway = makeGateway({
      stream() {
        return (async function* () {
          yield { type: 'text-delta', text: 'Hello' }
          yield { type: 'text-delta', text: ' world' }
          yield {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          }
        })() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })
    const body = JSON.stringify({ model: 'openrouter/chat', input: 'hi', stream: true })
    const [codexRes, v1Res] = await Promise.all([
      app.request('/codex/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    ])
    expect(codexRes.status).toBe(200)
    expect(codexRes.headers.get('content-type')).toBe('text/event-stream')
    const eventTypes = (text: string) =>
      text
        .split('\n')
        .filter((l) => l.startsWith('event:'))
        .map((l) => l.slice(6).trim())
    expect(eventTypes(await codexRes.text())).toEqual(eventTypes(await v1Res.text()))
  })

  it('returns the same 404 error as /v1/responses for unknown model', async () => {
    const app = createApp({ settings: openrouterSettings, providerRegistry: stubRegistry })
    const body = JSON.stringify({ model: 'unknown/model', input: 'hi' })
    const [codexRes, v1Res] = await Promise.all([
      app.request('/codex/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      app.request('/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    ])
    expect(codexRes.status).toBe(404)
    expect(await codexRes.json()).toEqual(await v1Res.json())
  })

  it('accepts Codex-style requests mixing function and non-function tools (no 400)', async () => {
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'hello',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as GenerateTextReturn
      },
    })
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })
    const body = JSON.stringify({
      model: 'openrouter/chat',
      input: 'hi',
      tools: [
        { type: 'function', name: 'shell_command', parameters: { type: 'object' } },
        {
          type: 'custom',
          name: 'apply_patch',
          description: 'apply patch',
          format: { type: 'grammar' },
        },
        { type: 'namespace', name: 'mcp__node_repl', description: 'node repl' },
        { type: 'tool_search', execution: 'client' },
        { type: 'web_search', search_content_types: ['text'] },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning: { effort: 'xhigh' },
      store: false,
      stream: false,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: '019efcd8',
      text: { verbosity: 'low' },
      client_metadata: { session_id: '019efcd8' },
    })
    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.output).toBeDefined()
  })

  it('passes apply_patch through for openai-compatible provider and renders custom_tool_call', async () => {
    const settings = makeSettings({
      openai: {
        type: 'openai-compatible',
        baseURL: 'https://example.com/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
      },
    })
    const gateway = makeGateway({
      stream() {
        return (async function* () {
          yield {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'apply_patch',
            input: JSON.stringify('*** Begin Patch\n*** End Patch'),
          }
          yield {
            type: 'finish',
            finishReason: 'tool-calls',
            totalUsage: { inputTokens: 5, outputTokens: 5 },
          }
        })() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })
    const body = JSON.stringify({
      model: 'openai/chat',
      input: 'hi',
      stream: true,
      tools: [
        {
          type: 'custom',
          name: 'apply_patch',
          format: { type: 'grammar', syntax: 'lark', definition: 'start:' },
        },
      ],
    })
    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('custom_tool_call')
    expect(text).toContain('response.custom_tool_call_input.delta')
  })

  // 非 apply_patch 的 custom tool（通过请求侧声明的 customToolNames 集合判别）端到端：
  // 上游返回 toolName='my_grammar_tool'，请求侧声明该工具为 type:'custom'，
  // renderer 应渲染为 custom_tool_call 而非 function_call。
  it('renders non-apply_patch custom tool as custom_tool_call via declared customToolNames', async () => {
    const settings = makeSettings({
      openai: {
        type: 'openai-compatible',
        baseURL: 'https://example.com/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
      },
    })
    const gateway = makeGateway({
      stream() {
        return (async function* () {
          yield {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'my_grammar_tool',
            input: JSON.stringify('payload'),
          }
          yield {
            type: 'finish',
            finishReason: 'tool-calls',
            totalUsage: { inputTokens: 5, outputTokens: 5 },
          }
        })() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })
    const body = JSON.stringify({
      model: 'openai/chat',
      input: 'hi',
      stream: true,
      tools: [
        {
          type: 'custom',
          name: 'my_grammar_tool',
          format: { type: 'grammar', syntax: 'lark', definition: 'start:' },
        },
      ],
    })
    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('custom_tool_call')
    expect(text).not.toContain('"function_call"')
  })

  it('renders web_search_call for openai-compatible provider hosted tool', async () => {
    const settings = makeSettings({
      openai: {
        type: 'openai-compatible',
        baseURL: 'https://example.com/v1',
        apiKey: 'secret',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
      },
    })
    const gateway = makeGateway({
      stream() {
        return (async function* () {
          yield {
            type: 'tool-call',
            toolCallId: 'ws_1',
            toolName: 'web_search',
            input: '{}',
            providerExecuted: true,
          }
          yield {
            type: 'tool-result',
            toolCallId: 'ws_1',
            toolName: 'web_search',
            output: { action: { type: 'search', query: 'test' } },
          }
          yield {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: { inputTokens: 5, outputTokens: 5 },
          }
        })() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({ settings, gateway, providerRegistry: stubRegistry })
    const body = JSON.stringify({
      model: 'openai/chat',
      input: 'hi',
      stream: true,
      tools: [{ type: 'web_search', external_web_access: true }],
    })
    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('web_search_call')
    expect(text).not.toContain('"function_call"')
  })

  it('injects x-request-id (middleware covers /codex)', async () => {
    const gateway = makeGateway({
      async generate() {
        return {
          text: 'hello',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as GenerateTextReturn
      },
    })
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })
    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: responsesBody,
    })
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
  })

  // openai-compatible provider end-to-end: shimmed apply_patch
  it('shims apply_patch for openai-compatible provider and renders custom_tool_call', async () => {
    const gateway = makeGateway({
      stream() {
        return (async function* () {
          yield {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'apply_patch',
            input: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }),
          }
          yield {
            type: 'finish',
            finishReason: 'tool-calls',
            totalUsage: { inputTokens: 5, outputTokens: 5 },
          }
        })() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })
    const body = JSON.stringify({
      model: 'openrouter/chat',
      input: 'hi',
      stream: true,
      tools: [
        {
          type: 'custom',
          name: 'apply_patch',
          format: { type: 'grammar', syntax: 'lark', definition: 'start:' },
        },
      ],
    })
    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('custom_tool_call')
    expect(text).toContain('*** Begin Patch')
  })

  // openai-compatible provider end-to-end: shimmed tool_search
  it('shims tool_search for openai-compatible provider and renders tool_search_call', async () => {
    const gateway = makeGateway({
      stream() {
        return (async function* () {
          yield {
            type: 'tool-call',
            toolCallId: 'ts_1',
            toolName: 'tool_search',
            input: { query: 'browser', limit: 5 },
          }
          yield {
            type: 'finish',
            finishReason: 'tool-calls',
            totalUsage: { inputTokens: 5, outputTokens: 5 },
          }
        })() as AsyncIterable<ProxyStreamPart>
      },
    })
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })
    const body = JSON.stringify({
      model: 'openrouter/chat',
      input: 'hi',
      stream: true,
      tools: [
        {
          type: 'tool_search',
          execution: 'client',
          description: 'Tool discovery',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    })
    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('tool_search_call')
    expect(text).toContain('browser')
  })

  // 端到端：handle-protocol 接线（Task 4）—— 请求侧 tool_search_output 拍平 → 上游返回扁平名 tool-call
  // → renderer 拆回 {name, namespace}。覆盖 strategy.getNamespaceFlatMap → 三处传递 → resolveNamespacedToolName。
  it('resolves namespaced toolName back to {name, namespace} end-to-end via handle-protocol wiring', async () => {
    let capturedInput: { tools?: Record<string, unknown> } | undefined
    const gateway = makeGateway({
      async generate({ callInput }) {
        capturedInput = callInput
        return {
          text: '',
          finishReason: 'tool-calls',
          toolCalls: [
            {
              toolCallId: 'call_1',
              toolName: 'multi_agent_v1__spawn_agent',
              input: { message: 'hi' },
            },
          ],
          usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
        } as GenerateTextReturn
      },
    })
    const app = createApp({ settings: openrouterSettings, gateway, providerRegistry: stubRegistry })
    const body = JSON.stringify({
      model: 'openrouter/chat',
      input: [
        { type: 'tool_search_call', call_id: 'ts_1', arguments: { query: 'agent' } },
        {
          type: 'tool_search_output',
          call_id: 'ts_1',
          tools: [
            {
              type: 'namespace',
              name: 'multi_agent_v1',
              description: 'sub-agents',
              tools: [
                {
                  type: 'function',
                  name: 'spawn_agent',
                  description: 'spawn',
                  parameters: { type: 'object', properties: { message: { type: 'string' } } },
                },
              ],
            },
          ],
        },
      ],
      stream: false,
    })
    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(200)
    // 请求侧：tool_search_output 里的 namespace 工具被拍平成 'multi_agent_v1__spawn_agent' 加入 tools[]
    expect(capturedInput?.tools).toBeDefined()
    expect(Object.keys(capturedInput!.tools!)).toContain('multi_agent_v1__spawn_agent')
    const json = await res.json()
    const fc = json.output.find((o: { type: string }) => o.type === 'function_call')
    expect(fc).toBeDefined()
    expect(fc).toMatchObject({
      type: 'function_call',
      name: 'spawn_agent',
      namespace: 'multi_agent_v1',
      call_id: 'call_1',
    })
  })
})
