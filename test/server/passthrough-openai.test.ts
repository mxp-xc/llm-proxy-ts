import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/server/app.js'
import { createProviderRegistry, TokenManager } from '../../src/index.js'
import {
  createOpenAIResponsesRequestBodyMergeFetch,
  filterOpenAIResponsesResponseHeaders,
  mergeOpenAIResponsesRequestBody,
  type OpenAIResponsesPassthroughFetchState,
} from '../../src/providers/openai-responses/passthrough.js'
import { makeGateway } from '../helpers/gateway.js'
import { makeSettings } from '../helpers/settings.js'
import { authCodeConfig, createMemoryPersistence } from '../helpers/oauth.js'
import type { LanguageModelOptions, ProviderRegistry } from '../../src/providers/registry.js'
import type { ModelGateway } from '../../src/server/types.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import type pino from 'pino'

afterEach(() => vi.unstubAllGlobals())

describe('openai provider /v1/responses via AI SDK passthrough override', () => {
  function makeOpenaiSettings() {
    return makeSettings({
      openai: {
        type: 'openai',
        baseURL: 'http://mock-upstream/v1',
        apiKey: 'sk-test',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
      },
    })
  }

  function makeOpenAICompatibleSettings() {
    return makeSettings({
      compatible: {
        type: 'openai-compatible',
        baseURL: 'http://mock-upstream/v1',
        apiKey: 'sk-test',
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-compat', aliases: [], headers: {}, plugins: [] } },
      },
    })
  }

  function makeCapturingRegistry() {
    const languageModelCalls: Array<{
      providerName: string
      upstreamModel: string
      modelHeaders: Record<string, string>
      options?: LanguageModelOptions
    }> = []
    const registry: ProviderRegistry = {
      languageModel(providerName, upstreamModel, modelHeaders, options) {
        languageModelCalls.push({
          providerName,
          upstreamModel,
          modelHeaders,
          ...(options !== undefined ? { options } : {}),
        })
        return {
          model: { provider: `test:${providerName}`, modelId: upstreamModel } as never,
          keySelection: { index: 0, count: 1 },
        }
      },
      passthroughTransport() {
        throw new Error('native passthrough transport should not be used')
      },
    }
    return { registry, languageModelCalls }
  }

  function makeRawResponseBody() {
    return {
      id: 'resp_upstream',
      object: 'response',
      created_at: 1_800_000_000,
      model: 'gpt-5',
      status: 'completed',
      output: [
        {
          id: 'msg_1',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello', annotations: [] }],
        },
      ],
      output_text: 'hello',
      upstream_extra: { preserved: true },
    }
  }

  function makeTestLogger() {
    const error = vi.fn()
    const child = vi.fn()
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error,
      fatal: vi.fn(),
      child,
    } as unknown as pino.Logger
    child.mockReturnValue(logger)
    return { logger, error }
  }

  it('does not re-add raw instructions when the SDK input already contains them', () => {
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'gpt-5',
        input: [
          {
            role: 'developer',
            content: 'Be helpful\nBe precise',
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
      },
      {
        model: 'gpt-5.5',
        instructions: 'Be helpful',
        input: [
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'Be precise' }],
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        ],
        prompt_cache_key: 'cache-key',
      },
    )

    expect(merged).not.toHaveProperty('instructions')
    expect(merged.prompt_cache_key).toBe('cache-key')
  })

  it('restores raw include and raw-only web_search tool fields in the merged SDK body', () => {
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'gpt-5',
        input: [{ role: 'user', content: 'hello' }],
        include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
        tools: [
          {
            type: 'web_search',
            external_web_access: true,
          },
        ],
      },
      {
        model: 'gpt-5.5',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        include: ['reasoning.encrypted_content'],
        tools: [
          {
            type: 'web_search',
            external_web_access: true,
            search_content_types: ['text', 'image'],
          },
        ],
      },
    )

    expect(merged.include).toEqual(['reasoning.encrypted_content'])
    expect(merged.tools).toEqual([
      {
        type: 'web_search',
        external_web_access: true,
        search_content_types: ['text', 'image'],
      },
    ])
  })

  it('sets text/event-stream accept header for streaming upstream responses requests', async () => {
    let capturedHeaders: Headers | undefined
    const fetchWithMerge = createOpenAIResponsesRequestBodyMergeFetch({
      model: 'gpt-5.5',
      input: 'hello',
      stream: true,
    })(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers)
      return Response.json(makeRawResponseBody())
    })

    await fetchWithMerge('http://mock-upstream/v1/responses', {
      method: 'POST',
      headers: { accept: '*/*', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', input: 'hello', stream: true }),
    })

    expect(capturedHeaders?.get('accept')).toBe('text/event-stream')
  })

  it('captures upstream response headers from the request-scoped fetch wrapper', async () => {
    const fetchState: OpenAIResponsesPassthroughFetchState = {}
    const fetchWithMerge = createOpenAIResponsesRequestBodyMergeFetch(
      { model: 'gpt-5.5', input: 'hello' },
      fetchState,
    )(async () =>
      Response.json(makeRawResponseBody(), {
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'upstream-request-id',
        },
      }),
    )

    await fetchWithMerge('http://mock-upstream/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5', input: 'hello' }),
    })

    expect(fetchState.responseHeaders?.get('x-request-id')).toBe('upstream-request-id')
  })

  it('preserves upstream x-request-id under x-upstream-request-id', () => {
    const headers = filterOpenAIResponsesResponseHeaders(
      new Headers({
        'content-type': 'application/json',
        'x-request-id': 'upstream-request-id',
      }),
    )

    expect(headers?.get('x-request-id')).toBe('upstream-request-id')
    expect(headers?.get('x-upstream-request-id')).toBe('upstream-request-id')
  })

  it('uses AI SDK generate with responseBody include and returns upstream parsed body fields', async () => {
    const settings = makeOpenaiSettings()
    const { registry, languageModelCalls } = makeCapturingRegistry()
    const rawResponseBody = makeRawResponseBody()
    let generateInput: Parameters<ModelGateway['generate']>[0] | undefined
    const gateway = makeGateway({
      async generate(input) {
        generateInput = input
        return {
          text: 'semantic text should not be rendered',
          finishReason: 'stop',
          response: {
            body: rawResponseBody,
            headers: {
              'content-type': 'application/json',
              'content-length': '999',
              'x-upstream-request-id': 'upstream-request',
            },
          },
        } as never
      },
    })
    const app = createApp({ settings, providerRegistry: registry, gateway })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(rawResponseBody)
    expect(res.headers.get('x-upstream-request-id')).toBe('upstream-request')
    expect(res.headers.get('content-length')).toBeNull()
    expect(languageModelCalls).toHaveLength(1)
    expect(languageModelCalls[0]?.options?.customFetch).toBeTypeOf('function')
    expect(generateInput?.options).toEqual({
      include: { requestBody: true, responseBody: true },
    })
  })

  it('uses AI SDK stream with rawChunks include and rebuilds SSE from raw parts only', async () => {
    const settings = makeOpenaiSettings()
    const { registry } = makeCapturingRegistry()
    let streamInput: Parameters<ModelGateway['stream']>[0] | undefined
    const rawCreated = {
      type: 'response.created',
      sequence_number: 0,
      response: { id: 'resp_1', object: 'response', status: 'in_progress', output: [] },
    }
    const rawCompleted = {
      type: 'response.completed',
      sequence_number: 1,
      response: makeRawResponseBody(),
    }
    const gateway = makeGateway({
      stream(input) {
        streamInput = input
        return (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'raw', rawValue: rawCreated }
          yield { type: 'text-delta', id: 'txt_1', text: 'must be ignored' }
          yield { type: 'raw', rawValue: rawCompleted }
          yield {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: {} as never,
          }
        })()
      },
    })
    const app = createApp({ settings, providerRegistry: registry, gateway })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi', stream: true }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: response.created')
    expect(text).toContain(`data: ${JSON.stringify(rawCreated)}`)
    expect(text).toContain('event: response.completed')
    expect(text).toContain(`data: ${JSON.stringify(rawCompleted)}`)
    expect(text).not.toContain('must be ignored')
    expect(text).not.toContain('[DONE]')
    expect(streamInput?.options).toEqual({
      include: { requestBody: true, rawChunks: true },
    })
  })

  it('preserves upstream stream x-request-id under x-upstream-request-id', async () => {
    const settings = makeOpenaiSettings()
    const rawCreated = {
      type: 'response.created',
      sequence_number: 0,
      response: { id: 'resp_1', created_at: 1_800_000_000, model: 'gpt-5' },
    }
    const rawCompleted = {
      type: 'response.completed',
      sequence_number: 1,
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }
    vi.stubGlobal('fetch', async () => {
      const body = [rawCreated, rawCompleted]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join('')
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'content-length': '999',
          'x-request-id': 'stream-upstream-request',
        },
      })
    })
    const providerRegistry = await createProviderRegistry(settings)
    const app = createApp({ settings, providerRegistry })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi', stream: true }),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('x-upstream-request-id')).toBe('stream-upstream-request')
    expect(res.headers.get('content-length')).toBeNull()
    const text = await res.text()
    expect(text).toContain(`data: ${JSON.stringify(rawCreated)}`)
    expect(text).toContain(`data: ${JSON.stringify(rawCompleted)}`)
  })

  it('merges raw request body as top-level missing-only fields into the SDK body', async () => {
    const settings = makeOpenaiSettings()
    let forwardedBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return Response.json(makeRawResponseBody(), {
        headers: { 'content-type': 'application/json', 'x-upstream-request-id': 'upstream' },
      })
    })
    const providerRegistry = await createProviderRegistry(settings)
    const app = createApp({ settings, providerRegistry })

    const rawInput = [
      {
        type: 'message',
        role: 'user',
        raw_item_should_not_be_deep_merged: true,
        content: [
          {
            type: 'input_text',
            text: 'hello',
            raw_part_should_not_be_deep_merged: true,
          },
        ],
      },
    ]
    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/chat',
        input: rawInput,
        stream: false,
        service_tier: 'flex',
        client_metadata: { session_id: 's1' },
        store: null,
        metadata: { raw_only: true },
      }),
    })

    expect(res.status).toBe(200)
    expect(forwardedBody?.model).toBe('gpt-5')
    expect(forwardedBody?.stream).toBe(false)
    expect(forwardedBody?.service_tier).toBe('flex')
    expect(forwardedBody?.client_metadata).toEqual({ session_id: 's1' })
    expect(forwardedBody?.store).toBeNull()
    expect(forwardedBody?.metadata).toEqual({ raw_only: true })
    expect(forwardedBody?.input).not.toEqual(rawInput)
    expect(JSON.stringify(forwardedBody?.input)).not.toContain('raw_item_should_not_be_deep_merged')
    expect(JSON.stringify(forwardedBody?.input)).not.toContain('raw_part_should_not_be_deep_merged')
  })

  it('rebuilds response.failed SSE from retry-wrapped AI SDK stream errors', async () => {
    const settings = makeOpenaiSettings()
    const { registry } = makeCapturingRegistry()
    const failedFrame = {
      type: 'response.failed',
      sequence_number: 2,
      response: {
        ...makeRawResponseBody(),
        status: 'failed',
        error: { code: 'rate_limit_exceeded', message: 'too many requests' },
      },
    }
    const apiCallError = {
      name: 'AI_APICallError',
      data: failedFrame,
      responseBody: JSON.stringify(failedFrame),
    }
    const retryError = {
      name: 'AI_RetryError',
      lastError: apiCallError,
    }
    const gateway = makeGateway({
      stream() {
        return (async function* (): AsyncIterable<ProxyStreamPart> {
          yield { type: 'error', error: retryError }
        })()
      },
    })
    const app = createApp({ settings, providerRegistry: registry, gateway })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi', stream: true }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('event: response.failed')
    expect(text).toContain(`data: ${JSON.stringify(failedFrame)}`)
  })

  it('keeps non-openai providers on the normal AI SDK matrix renderer', async () => {
    const settings = makeOpenAICompatibleSettings()
    const { registry } = makeCapturingRegistry()
    let generateInput: Parameters<ModelGateway['generate']>[0] | undefined
    const gateway = makeGateway({
      async generate(input) {
        generateInput = input
        return {
          text: 'compat hello',
          finishReason: 'stop',
          response: { body: { id: 'raw_should_not_be_returned' } },
          toolCalls: [],
        } as never
      },
    })
    const app = createApp({ settings, providerRegistry: registry, gateway })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'compatible/chat', input: 'hi' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).not.toBe('raw_should_not_be_returned')
    expect(body.output_text).toBe('compat hello')
    expect(generateInput?.options).toBeUndefined()
  })

  it('returns 503 login body when AI SDK OAuth fetch requires login', async () => {
    const settings = makeSettings({
      openai: {
        type: 'openai',
        baseURL: 'http://mock-upstream/v1',
        apiKey: null,
        headers: {},
        plugins: [],
        models: { chat: { upstreamModel: 'gpt-5', aliases: [], headers: {}, plugins: [] } },
        oauth: authCodeConfig,
      },
    })
    const tokenManager = new TokenManager(createMemoryPersistence())
    await tokenManager.load()
    const providerRegistry = await createProviderRegistry(settings, tokenManager)
    const { logger, error } = makeTestLogger()
    const app = createApp({ settings, providerRegistry, logger })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/chat', input: 'hi' }),
    })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toMatchObject({
      type: 'auth_required',
      code: 'oauth_login_needed',
    })
    expect(body.error.loginUrl).toContain('/oauth/login/openai')
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ code: 'auth_required' }),
        phase: 'generate',
      }),
      'upstream request failed',
    )
  })
})
