import { afterEach, describe, expect, it, vi } from 'vitest'

const createDirectFetchMock = vi.hoisted(() =>
  vi.fn(() => ((input, init) => globalThis.fetch(input, init)) as typeof fetch),
)

vi.mock('../../src/providers/shared/provider-factory.js', async (importOriginal) => ({
  ...(await importOriginal()),
  createDirectFetch: createDirectFetchMock,
}))

import { createApp } from '../../src/server/app.js'
import { createProviderRegistry, TokenManager } from '../../src/index.js'
import {
  createOpenAIResponsesRequestBodyMergeFetch,
  filterOpenAIResponsesResponseHeaders,
  mergeOpenAIResponsesRequestBody,
  type OpenAIResponsesPassthroughFetchState,
} from '../../src/providers/openai-responses/passthrough.js'
import {
  ADDITIONAL_TOOLS_ANCHOR_PREFIX,
  AGENT_MESSAGE_ANCHOR_PREFIX,
} from '../../src/providers/openai-responses/protocol.js'
import { makeGateway } from '../helpers/gateway.js'
import { makeSettings } from '../helpers/settings.js'
import { authCodeConfig, createMemoryPersistence } from '../helpers/oauth.js'
import type { LanguageModelOptions, ProviderRegistry } from '../../src/providers/registry.js'
import type { ModelGateway } from '../../src/server/types.js'
import type { ProxyStreamPart } from '../../src/providers/shared/aisdk-types.js'
import type { Logger } from '../../src/types.js'

afterEach(() => {
  vi.unstubAllGlobals()
  createDirectFetchMock.mockClear()
})

describe('openai provider /v1/responses via AI SDK passthrough override', () => {
  function makeOpenaiSettings(supportsVision?: boolean) {
    return makeSettings({
      openai: {
        type: 'openai',
        baseURL: 'http://mock-upstream/v1',
        apiKey: 'sk-test',
        headers: {},
        plugins: [],
        ...(supportsVision === undefined ? {} : { options: { supports_vision: supportsVision } }),
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
    const warn = vi.fn()
    const logger: Logger = {
      info: vi.fn(),
      warn,
      error,
      fatal: vi.fn(),
      child: () => logger,
    }
    return { logger, error, warn }
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
    expect(merged.input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: 'Be helpful\nBe precise',
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ])
  })

  it('restores filtered easy-message fields without replacing SDK-merged instructions', () => {
    const inputFile = {
      type: 'input_file',
      file_url: 'file:///C:/workspace/context.txt',
      opaque: 'preserve-file-field',
    }
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'gpt-5',
        input: [
          {
            role: 'developer',
            content: 'Be helpful\nBe precise',
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
            content: [inputFile, { type: 'input_text', text: 'Be precise' }],
            opaque_message_field: 'preserve-message-field',
          },
        ],
      },
      { restoreFilteredInputItems: true },
    )

    expect(merged).not.toHaveProperty('instructions')
    expect(merged.input).toEqual([
      {
        type: 'message',
        role: 'developer',
        content: [
          { type: 'input_text', text: 'Be helpful' },
          inputFile,
          { type: 'input_text', text: 'Be precise' },
        ],
        opaque_message_field: 'preserve-message-field',
      },
    ])
  })

  it('matches same-role filtered messages by their retained text', () => {
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'gpt-5',
        input: [{ role: 'system', content: 'retained system text' }],
      },
      {
        model: 'gpt-5.5',
        input: [
          { type: 'message', role: 'system', content: [] },
          {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: 'retained system text' }],
            opaque_message_field: 'preserve-second-message',
          },
        ],
      },
      { restoreFilteredInputItems: true },
    )

    expect(merged.input).toEqual([
      {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: 'retained system text' }],
        opaque_message_field: 'preserve-second-message',
      },
    ])
  })

  it('aligns SDK-normalized system/developer roles without matching other roles', () => {
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'gpt-5',
        input: [
          { role: 'developer', content: 'system text' },
          { role: 'developer', content: 'developer text' },
          { role: 'user', content: 'shared text' },
        ],
      },
      {
        model: 'gpt-5.5',
        input: [
          {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: 'system text' }],
            opaque_message_field: 'preserve-system',
          },
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'developer text' }],
            opaque_message_field: 'preserve-developer',
          },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'shared text' }],
            opaque_message_field: 'do-not-match-assistant',
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'shared text' }],
            opaque_message_field: 'preserve-user',
          },
        ],
      },
      { restoreFilteredInputItems: true },
    )

    expect(merged.input).toEqual([
      {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: 'system text' }],
        opaque_message_field: 'preserve-system',
      },
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'developer text' }],
        opaque_message_field: 'preserve-developer',
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'shared text' }],
        opaque_message_field: 'preserve-user',
      },
    ])
  })

  it('restores unmatched non-text system/developer messages in raw input order', () => {
    const inputFile = { type: 'input_file', file_url: 'file:///C:/workspace/context.txt' }
    const agentAnchor = {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [
        {
          type: 'output_text',
          text: `${AGENT_MESSAGE_ANCHOR_PREFIX}00000000-0000-4000-8000-000000000000`,
        },
      ],
    }
    const additionalToolsAnchor = {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [
        {
          type: 'output_text',
          text: `${ADDITIONAL_TOOLS_ANCHOR_PREFIX}00000000-0000-4000-8000-000000000000`,
        },
      ],
    }
    const agentMessage = {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/worker',
      content: [{ type: 'input_text', text: 'delegate' }],
    }
    const additionalTools = {
      type: 'additional_tools',
      tools: [{ type: 'function', name: 'inspect' }],
    }
    const functionCall = {
      type: 'function_call',
      call_id: 'call_1',
      name: 'inspect',
      arguments: '{}',
    }
    const mappedToolSearchOutput = {
      type: 'function_call_output',
      call_id: 'tool_search_1',
      output: 'mapped tool search output',
    }
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'gpt-5',
        input: [
          mappedToolSearchOutput,
          agentAnchor,
          agentMessage,
          functionCall,
          additionalToolsAnchor,
          additionalTools,
          { role: 'user', content: 'before' },
          { type: 'function_call_output', call_id: 'call_1', output: 'sdk output' },
          { role: 'user', content: 'after' },
        ],
      },
      {
        model: 'gpt-5.5',
        input: [
          {
            type: 'message',
            role: 'system',
            content: [inputFile],
            opaque_message_field: 'preserve-system-file',
          },
          { type: 'tool_search_output', id: 'tool_search_1', tools: [] },
          agentMessage,
          functionCall,
          {
            type: 'message',
            role: 'developer',
            content: [inputFile],
            opaque_message_field: 'preserve-developer-file',
          },
          additionalTools,
          { type: 'message', role: 'user', content: 'before' },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: [{ type: 'input_text', text: 'raw output' }],
          },
          { type: 'message', role: 'user', content: 'after' },
          {
            type: 'message',
            role: 'assistant',
            content: [],
            opaque_message_field: 'do-not-insert-empty-assistant',
          },
        ],
      },
      { restoreFilteredInputItems: true },
    )

    expect(merged.input).toEqual([
      {
        type: 'message',
        role: 'system',
        content: [inputFile],
        opaque_message_field: 'preserve-system-file',
      },
      mappedToolSearchOutput,
      agentMessage,
      functionCall,
      {
        type: 'message',
        role: 'developer',
        content: [inputFile],
        opaque_message_field: 'preserve-developer-file',
      },
      additionalTools,
      { type: 'message', role: 'user', content: 'before' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [{ type: 'input_text', text: 'raw output' }],
      },
      { type: 'message', role: 'user', content: 'after' },
    ])
  })

  it('restores a filtered file-only assistant message without restoring an empty assistant', () => {
    const fileOnlyAssistant = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'input_file', file_url: 'file:///C:/workspace/context.txt' }],
      opaque_message_field: 'preserve-assistant-file',
    }
    const userMessage = { type: 'message', role: 'user', content: 'continue' }

    const merged = mergeOpenAIResponsesRequestBody(
      { model: 'gpt-5', input: [{ role: 'user', content: 'continue' }] },
      {
        model: 'gpt-5.5',
        input: [
          fileOnlyAssistant,
          {
            type: 'message',
            role: 'assistant',
            content: [],
            opaque_message_field: 'do-not-restore-empty-assistant',
          },
          userMessage,
        ],
      },
      { restoreFilteredInputItems: true },
    )

    expect(merged.input).toEqual([fileOnlyAssistant, userMessage])
  })

  it('keeps file-only system/developer messages around reasoning with unstable IDs', () => {
    const inputFile = { type: 'input_file', file_url: 'file:///C:/workspace/context.txt' }
    const firstSDKReasoning = {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'first sdk reasoning' }],
    }
    const secondSDKReasoning = {
      type: 'reasoning',
      id: 'sdk-generated-reasoning-id',
      summary: [{ type: 'summary_text', text: 'second sdk reasoning' }],
    }
    const leadingSystem = { type: 'message', role: 'system', content: [inputFile] }
    const middleDeveloper = { type: 'message', role: 'developer', content: [inputFile] }

    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'gpt-5',
        input: [firstSDKReasoning, secondSDKReasoning],
      },
      {
        model: 'gpt-5.5',
        input: [
          leadingSystem,
          { type: 'reasoning', id: 'raw-reasoning-id', summary: [] },
          middleDeveloper,
          { type: 'reasoning', summary: [] },
        ],
      },
      { restoreFilteredInputItems: true },
    )

    expect(merged.input).toEqual([
      leadingSystem,
      firstSDKReasoning,
      middleDeveloper,
      secondSDKReasoning,
    ])
  })

  it('keeps a file-only system message before a stored compaction reference', () => {
    const leadingSystem = {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_file', file_url: 'file:///C:/workspace/context.txt' }],
    }
    const itemReference = { type: 'item_reference', id: 'compaction_1' }

    const merged = mergeOpenAIResponsesRequestBody(
      { model: 'gpt-5', input: [itemReference] },
      {
        model: 'gpt-5.5',
        input: [leadingSystem, { type: 'compaction', id: 'compaction_1' }],
      },
      { restoreFilteredInputItems: true },
    )

    expect(merged.input).toEqual([leadingSystem, itemReference])
  })

  it('keeps file-only messages around tool search calls whose IDs are rewritten', () => {
    const inputFile = { type: 'input_file', file_url: 'file:///C:/workspace/context.txt' }
    const leadingSystem = { type: 'message', role: 'system', content: [inputFile] }
    const middleDeveloper = { type: 'message', role: 'developer', content: [inputFile] }
    const firstSDKCall = {
      type: 'tool_search_call',
      id: 'tool_search_1',
      call_id: null,
      execution: 'server',
      arguments: {},
    }
    const secondSDKCall = {
      type: 'tool_search_call',
      id: 'tool_search_2',
      call_id: null,
      execution: 'server',
      arguments: {},
    }

    const merged = mergeOpenAIResponsesRequestBody(
      { model: 'gpt-5', input: [firstSDKCall, secondSDKCall] },
      {
        model: 'gpt-5.5',
        input: [
          leadingSystem,
          { type: 'tool_search_call', call_id: 'tool_search_1', arguments: {} },
          middleDeveloper,
          { type: 'tool_search_call', id: 'tool_search_2', arguments: {} },
        ],
      },
      { restoreFilteredInputItems: true },
    )

    expect(merged.input).toEqual([leadingSystem, firstSDKCall, middleDeveloper, secondSDKCall])
  })

  it('keeps a file-only system message before a tool search output whose ID is rewritten', () => {
    const leadingSystem = {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_file', file_url: 'file:///C:/workspace/context.txt' }],
    }
    const sdkToolSearchOutput = {
      type: 'tool_search_output',
      call_id: 'tool_search_1',
      execution: 'client',
      status: 'completed',
      tools: [],
    }
    const userMessage = { type: 'message', role: 'user', content: 'after' }

    const merged = mergeOpenAIResponsesRequestBody(
      { model: 'gpt-5', input: [sdkToolSearchOutput, userMessage] },
      {
        model: 'gpt-5.5',
        input: [
          leadingSystem,
          { type: 'tool_search_output', id: 'tool_search_1', tools: [] },
          userMessage,
        ],
      },
      { restoreFilteredInputItems: true },
    )

    expect(merged.input).toEqual([leadingSystem, sdkToolSearchOutput, userMessage])
  })

  it('matches duplicate stored item references in raw input order', () => {
    const inputFile = { type: 'input_file', file_url: 'file:///C:/workspace/context.txt' }
    const leadingSystem = { type: 'message', role: 'system', content: [inputFile] }
    const middleDeveloper = { type: 'message', role: 'developer', content: [inputFile] }
    const firstReference = { type: 'item_reference', id: 'duplicate_id' }
    const secondReference = { type: 'item_reference', id: 'duplicate_id' }

    const merged = mergeOpenAIResponsesRequestBody(
      { model: 'gpt-5', input: [firstReference, secondReference] },
      {
        model: 'gpt-5.5',
        input: [
          leadingSystem,
          { type: 'compaction', id: 'duplicate_id' },
          middleDeveloper,
          { type: 'tool_search_output', call_id: 'duplicate_id', tools: [] },
        ],
      },
      { restoreFilteredInputItems: true },
    )

    expect(merged.input).toEqual([leadingSystem, firstReference, middleDeveloper, secondReference])
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

  it.each([
    {
      name: 'leading',
      rawInput: [
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'function', name: 'a' }],
        },
        { type: 'message', role: 'user', content: 'a' },
      ],
      sdkInput: [{ role: 'user', content: 'sdk-a' }],
      expectedTypes: ['additional_tools', 'message'],
    },
    {
      name: 'middle',
      rawInput: [
        { type: 'message', role: 'developer', content: 'a' },
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'function', name: 'b' }],
        },
        { type: 'message', role: 'user', content: 'b' },
      ],
      sdkInput: [
        { role: 'developer', content: 'sdk-a' },
        { role: 'user', content: 'sdk-b' },
      ],
      expectedTypes: ['message', 'additional_tools', 'message'],
    },
    {
      name: 'trailing and repeated',
      rawInput: [
        { type: 'message', role: 'user', content: 'a' },
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'function', name: 'b' }],
        },
        {
          type: 'additional_tools',
          role: 'developer',
          tools: [{ type: 'function', name: 'c' }],
        },
      ],
      sdkInput: [{ role: 'user', content: 'sdk-a' }],
      expectedTypes: ['message', 'additional_tools', 'additional_tools'],
    },
  ])(
    'injects $name additional_tools without replacing SDK messages',
    ({ rawInput, sdkInput, expectedTypes }) => {
      const merged = mergeOpenAIResponsesRequestBody(
        {
          model: 'upstream',
          input: sdkInput,
          tools: [{ type: 'function', name: 'from-additional-tools' }],
        },
        { model: 'route/model', input: rawInput },
      )

      expect(
        (merged.input as Array<Record<string, unknown>>).map((item) => item.type ?? item.role),
      ).toEqual(expectedTypes)
      expect(JSON.stringify(merged.input)).toContain('sdk-a')
      expect(merged).not.toHaveProperty('tools')
    },
  )

  it('aligns additional_tools around raw web_search_call items skipped by the SDK mapping', () => {
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'upstream',
        input: [
          { role: 'developer', content: 'sdk-a' },
          { role: 'user', content: 'sdk-b' },
        ],
        tools: [{ type: 'function', name: 'later' }],
      },
      {
        model: 'route/model',
        input: [
          { type: 'message', role: 'developer', content: 'raw-a' },
          { type: 'web_search_call', id: 'ws_1', status: 'completed' },
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [{ type: 'function', name: 'later' }],
          },
          { type: 'message', role: 'user', content: 'raw-b' },
        ],
      },
    )

    expect(merged.input).toEqual([
      { type: 'message', role: 'developer', content: 'sdk-a' },
      expect.objectContaining({ type: 'additional_tools' }),
      { type: 'message', role: 'user', content: 'sdk-b' },
    ])
  })

  it('trusts SDK-native additional_tools while restoring missing message types', () => {
    const nativeAdditionalTools = { type: 'additional_tools', role: 'developer', tools: [] }
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'upstream',
        input: [nativeAdditionalTools, { role: 'user', content: 'sdk' }],
        tools: [{ type: 'function', name: 'sdk' }],
      },
      {
        model: 'route/model',
        input: [{ type: 'additional_tools', role: 'developer', tools: [] }],
      },
    )

    expect(merged.input).toEqual([
      nativeAdditionalTools,
      { type: 'message', role: 'user', content: 'sdk' },
    ])
    expect(merged.tools).toEqual([{ type: 'function', name: 'sdk' }])
  })

  it('removes only the internal anchor when the SDK emits additional_tools natively', () => {
    const marker = `${ADDITIONAL_TOOLS_ANCHOR_PREFIX}00000000-0000-4000-8000-000000000000`
    const nativeAdditionalTools = {
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'function', name: 'sdk' }],
    }
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'upstream',
        input: [
          {
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: marker }],
          },
          nativeAdditionalTools,
        ],
        tools: [{ type: 'function', name: 'sdk' }],
      },
      {
        model: 'route/model',
        input: [{ type: 'additional_tools', role: 'developer', tools: [] }],
      },
    )

    expect(merged.input).toEqual([nativeAdditionalTools])
    expect(merged.tools).toEqual([{ type: 'function', name: 'sdk' }])
  })

  it('restores raw agent_message items from internal anchors', () => {
    const marker = `${AGENT_MESSAGE_ANCHOR_PREFIX}00000000-0000-4000-8000-000000000000`
    const rawAgentMessage = {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/worker',
      content: [
        { type: 'input_text', text: 'Reply with exactly: task received' },
        { type: 'encrypted_content', encrypted_content: 'encrypted-task-payload' },
      ],
      custom_field: 'preserve-me',
    }
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'upstream',
        input: [
          { role: 'user', content: 'before' },
          {
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: marker }],
          },
          { role: 'user', content: 'after' },
        ],
      },
      {
        model: 'route/model',
        input: [
          { type: 'message', role: 'user', content: 'raw-before' },
          rawAgentMessage,
          { type: 'message', role: 'user', content: 'raw-after' },
        ],
      },
    )

    expect(merged.input).toEqual([
      { type: 'message', role: 'user', content: 'before' },
      rawAgentMessage,
      { type: 'message', role: 'user', content: 'after' },
    ])
  })

  it('restores raw SDK-native agent_message items and removes only the internal anchor', () => {
    const marker = `${AGENT_MESSAGE_ANCHOR_PREFIX}00000000-0000-4000-8000-000000000000`
    const nativeAgentMessage = {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/worker',
      content: [
        { type: 'input_text', text: 'Reply with exactly: task received' },
        { type: 'encrypted_content', encrypted_content: 'sdk-encrypted-task-payload' },
      ],
    }
    const rawAgentMessage = {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/worker',
      content: [
        { type: 'input_text', text: 'Reply with exactly: task received' },
        { type: 'encrypted_content', encrypted_content: 'raw-encrypted-task-payload' },
      ],
      custom_field: 'preserve-me',
    }
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'upstream',
        input: [
          {
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: marker }],
          },
          nativeAgentMessage,
        ],
      },
      {
        model: 'route/model',
        input: [rawAgentMessage],
      },
    )

    expect(merged.input).toEqual([rawAgentMessage])
  })

  it('does not mistake an SDK-native agent_message for an internal anchor', () => {
    const marker = `${AGENT_MESSAGE_ANCHOR_PREFIX}00000000-0000-4000-8000-000000000000`
    const nativeAgentMessage = {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/worker',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: marker }],
    }
    const merged = mergeOpenAIResponsesRequestBody(
      { model: 'upstream', input: [nativeAgentMessage] },
      { model: 'route/model', input: [nativeAgentMessage] },
    )

    expect(merged.input).toEqual([nativeAgentMessage])
  })

  it.each([
    {
      name: 'non-array SDK input',
      sdkInput: 'sdk',
      expected: 'Cannot align agent_message with non-array SDK input',
    },
    {
      name: 'missing anchor',
      sdkInput: [],
      expected: 'Cannot align agent_message with SDK input: expected 1 anchors, found 0',
    },
  ])('rejects unsafe agent_message alignment with $name', ({ sdkInput, expected }) => {
    const encryptedContent = 'must-not-appear-in-error'
    let error: Error | undefined
    try {
      mergeOpenAIResponsesRequestBody(
        { model: 'upstream', input: sdkInput },
        {
          model: 'route/model',
          input: [
            {
              type: 'agent_message',
              author: '/root',
              recipient: '/root/worker',
              content: [{ type: 'encrypted_content', encrypted_content: encryptedContent }],
            },
          ],
        },
      )
    } catch (cause) {
      error = cause as Error
    }

    expect(error?.message).toContain(expected)
    expect(error?.message).not.toContain(encryptedContent)
  })

  it('keeps raw top-level tools separate from input additional_tools', () => {
    const rawTopTools = [{ type: 'function', name: 'top' }]
    const merged = mergeOpenAIResponsesRequestBody(
      {
        model: 'upstream',
        input: [{ role: 'user', content: 'sdk' }],
        tools: [
          { type: 'function', name: 'top' },
          { type: 'function', name: 'later' },
        ],
      },
      {
        model: 'route/model',
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [{ type: 'function', name: 'later' }],
          },
          { type: 'message', role: 'user', content: 'raw' },
        ],
        tools: rawTopTools,
      },
    )

    expect(merged.tools).toEqual(rawTopTools)
  })

  it('throws when raw and SDK input items cannot be aligned safely', () => {
    expect(() =>
      mergeOpenAIResponsesRequestBody(
        { model: 'upstream', input: [] },
        {
          model: 'route/model',
          input: [
            { type: 'message', role: 'user', content: 'raw' },
            { type: 'additional_tools', role: 'developer', tools: [] },
          ],
        },
      ),
    ).toThrow('Cannot align additional_tools with SDK input')
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

  it('preserves reasoning mode in the final upstream request body', async () => {
    const settings = makeOpenaiSettings()
    let forwardedBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return Response.json(makeRawResponseBody(), {
        headers: { 'content-type': 'application/json' },
      })
    })
    const providerRegistry = await createProviderRegistry(settings)
    const app = createApp({ settings, providerRegistry })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/chat',
        input: 'hi',
        reasoning: { effort: 'high', mode: 'pro', summary: 'auto' },
      }),
    })

    expect(res.status).toBe(200)
    expect(forwardedBody?.reasoning).toEqual({
      effort: 'high',
      mode: 'pro',
      summary: 'auto',
    })
  })

  it('omits null reasoning mode and context from the final upstream request body', async () => {
    const settings = makeOpenaiSettings()
    let forwardedBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return Response.json(makeRawResponseBody(), {
        headers: { 'content-type': 'application/json' },
      })
    })
    const providerRegistry = await createProviderRegistry(settings)
    const app = createApp({ settings, providerRegistry })

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/chat',
        input: 'hi',
        reasoning: { effort: 'high', mode: null, context: null, summary: 'auto' },
      }),
    })

    expect(res.status).toBe(200)
    expect(forwardedBody?.reasoning).toEqual({ effort: 'high', summary: 'auto' })
  })

  it('maps chat reasoning_effort into the final OpenAI Responses request body', async () => {
    const settings = makeOpenaiSettings()
    let forwardedBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return Response.json(makeRawResponseBody(), {
        headers: { 'content-type': 'application/json' },
      })
    })
    const providerRegistry = await createProviderRegistry(settings)
    const app = createApp({ settings, providerRegistry })

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/chat',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'high',
      }),
    })

    expect(res.status).toBe(200)
    expect(forwardedBody?.reasoning).toEqual({ effort: 'high', summary: 'auto' })
  })

  it('preserves positional additional_tools in the final non-streaming SDK request body', async () => {
    const settings = makeOpenaiSettings()
    let forwardedBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return Response.json(makeRawResponseBody(), {
        headers: { 'content-type': 'application/json' },
      })
    })
    const providerRegistry = await createProviderRegistry(settings)
    const app = createApp({ settings, providerRegistry })

    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/chat',
        input: [
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'developer marker' }],
          },
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [
              {
                type: 'function',
                name: 'lookup',
                parameters: { type: 'object', properties: {} },
              },
            ],
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'user marker' }],
          },
        ],
        reasoning: { effort: 'medium', context: 'all_turns' },
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(forwardedBody?.model).toBe('gpt-5')
    expect(forwardedBody?.reasoning).toEqual({ effort: 'medium', context: 'all_turns' })
    expect(forwardedBody).not.toHaveProperty('tools')
    expect(
      (forwardedBody?.input as Array<Record<string, unknown>>).map(
        (item) => item.type ?? item.role,
      ),
    ).toEqual(['message', 'additional_tools', 'message'])
    expect(forwardedBody?.input).toEqual([
      { type: 'message', role: 'developer', content: 'developer marker' },
      expect.objectContaining({ type: 'additional_tools', role: 'developer' }),
      expect.objectContaining({ type: 'message', role: 'user' }),
    ])
  })

  it('preserves opaque agent_message fields in the final SDK request body', async () => {
    const settings = makeOpenaiSettings()
    let forwardedBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      return Response.json(makeRawResponseBody(), {
        headers: { 'content-type': 'application/json' },
      })
    })
    const providerRegistry = await createProviderRegistry(settings)
    const app = createApp({ settings, providerRegistry })
    const agentMessage = {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/worker',
      content: [
        { type: 'input_text', text: 'Reply with exactly: task received' },
        { type: 'encrypted_content', encrypted_content: 'encrypted-task-payload' },
      ],
      custom_field: 'preserve-me',
    }

    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/chat',
        input: [agentMessage],
        stream: false,
      }),
    })

    expect(res.status).toBe(200)
    expect(forwardedBody?.input).toEqual([agentMessage])
    expect(JSON.stringify(forwardedBody?.input)).not.toContain('Agent message from')
    expect(JSON.stringify(forwardedBody?.input)).not.toContain('llm_proxy_')
  })

  it.each([false, true])(
    'does not restore filtered agent_message images in the final SDK request body (stream=%s)',
    async (stream) => {
      const settings = makeOpenaiSettings(false)
      let forwardedBody: Record<string, unknown> | undefined
      vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
        forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        if (!stream) return Response.json(makeRawResponseBody())

        const events = [
          {
            type: 'response.created',
            sequence_number: 0,
            response: {
              id: 'resp_stream',
              object: 'response',
              status: 'in_progress',
              output: [],
            },
          },
          {
            type: 'response.completed',
            sequence_number: 1,
            response: makeRawResponseBody(),
          },
        ]
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      })
      const providerRegistry = await createProviderRegistry(settings)
      const app = createApp({ settings, providerRegistry })
      const imageBase64 = 'data:image/png;base64,must-not-reach-upstream'
      const imageUrl = 'https://sensitive.example/image.png'
      const filePath = 'C:\\workspace\\images\\keep.png'
      const expectedAgentMessage = {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/worker',
        content: [
          { type: 'input_text', text: `inspect image path: ${filePath}` },
          { type: 'input_file', file_url: 'file:///C:/workspace/images/keep.png' },
          { type: 'encrypted_content', encrypted_content: 'opaque-encrypted-content' },
        ],
        custom_field: { file_path: filePath, opaque: 'preserve-me' },
      }

      const res = await app.request('/codex/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'openai/chat',
          input: [
            {
              ...expectedAgentMessage,
              content: [
                expectedAgentMessage.content[0],
                { type: 'input_image', image_url: imageBase64 },
                expectedAgentMessage.content[1],
                { type: 'input_image', image_url: imageUrl },
                expectedAgentMessage.content[2],
              ],
            },
          ],
          stream,
          opaque_top_level: { preserve: true },
        }),
      })

      expect(res.status).toBe(200)
      await res.text()
      expect(forwardedBody?.stream).toBe(stream)
      expect(forwardedBody?.opaque_top_level).toEqual({ preserve: true })
      expect(forwardedBody?.input).toEqual([expectedAgentMessage])
      const serialized = JSON.stringify(forwardedBody)
      expect(serialized).not.toContain('input_image')
      expect(serialized).not.toContain(imageBase64)
      expect(serialized).not.toContain(imageUrl)
      expect(serialized).toContain(filePath.replaceAll('\\', '\\\\'))
    },
  )

  it.each([false, true])(
    'preserves filtered easy-message and call-output wire items (stream=%s)',
    async (stream) => {
      const settings = makeOpenaiSettings(false)
      let forwardedBody: Record<string, unknown> | undefined
      vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
        forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        if (!stream) return Response.json(makeRawResponseBody())

        const events = [
          {
            type: 'response.created',
            sequence_number: 0,
            response: {
              id: 'resp_stream',
              object: 'response',
              status: 'in_progress',
              output: [],
            },
          },
          {
            type: 'response.completed',
            sequence_number: 1,
            response: makeRawResponseBody(),
          },
        ]
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      })
      const providerRegistry = await createProviderRegistry(settings)
      const app = createApp({ settings, providerRegistry })
      const imageData = 'data:image/png;base64,must-not-reach-call-output-upstream'
      const imageUrl = 'https://sensitive.example/easy-message.png'
      const inputFile = {
        type: 'input_file',
        file_url: 'file:///C:/workspace/images/keep.png',
        opaque_file_field: 'preserve-file-field',
      }
      const expectedSystemMessage = {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: 'system instruction' }],
        opaque_message_field: 'preserve-system-message',
      }
      const expectedFileOnlySystemMessage = {
        type: 'message',
        role: 'system',
        content: [inputFile],
        opaque_message_field: 'preserve-file-only-system-message',
      }
      const expectedDeveloperMessage = {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'developer instruction' }],
        opaque_message_field: 'preserve-developer-message',
      }
      const expectedEasyMessage = {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'inspect C:\\workspace\\images\\keep.png' },
          inputFile,
        ],
        opaque_message_field: { preserve: true },
      }
      const expectedFunctionOutput = {
        type: 'function_call_output',
        call_id: 'call_function',
        output: [
          { type: 'input_text', text: 'function before' },
          inputFile,
          { type: 'input_text', text: 'function after' },
        ],
        opaque_output_field: 'preserve-function-output',
      }
      const expectedCustomOutput = {
        type: 'custom_tool_call_output',
        call_id: 'call_custom',
        output: [
          { type: 'input_text', text: 'custom before' },
          inputFile,
          { type: 'input_text', text: 'custom after' },
        ],
        opaque_output_field: 'preserve-custom-output',
      }

      const res = await app.request('/codex/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'openai/chat',
          input: [
            expectedSystemMessage,
            {
              ...expectedFileOnlySystemMessage,
              content: [
                { type: 'input_image', image_url: imageData },
                expectedFileOnlySystemMessage.content[0],
              ],
            },
            expectedDeveloperMessage,
            {
              ...expectedEasyMessage,
              content: [
                expectedEasyMessage.content[0],
                { type: 'input_image', image_url: imageUrl },
                expectedEasyMessage.content[1],
              ],
            },
            {
              type: 'function_call',
              call_id: 'call_function',
              name: 'inspect',
              arguments: '{}',
            },
            {
              ...expectedFunctionOutput,
              output: [
                expectedFunctionOutput.output[0],
                { type: 'input_image', image_url: imageData },
                expectedFunctionOutput.output[1],
                expectedFunctionOutput.output[2],
              ],
            },
            {
              type: 'custom_tool_call',
              call_id: 'call_custom',
              name: 'shell',
              input: 'inspect image',
            },
            {
              ...expectedCustomOutput,
              output: [
                expectedCustomOutput.output[0],
                { type: 'input_image', image_url: imageData },
                expectedCustomOutput.output[1],
                expectedCustomOutput.output[2],
              ],
            },
            {
              type: 'function_call',
              call_id: 'call_image_only',
              name: 'inspect',
              arguments: '{}',
            },
            {
              type: 'function_call_output',
              call_id: 'call_image_only',
              output: [{ type: 'input_image', image_url: imageData }],
              opaque_output_field: 'preserve-image-only-output',
            },
          ],
          tools: [
            {
              type: 'function',
              name: 'inspect',
              parameters: { type: 'object', properties: {} },
            },
            { type: 'custom', name: 'shell', format: { type: 'text' } },
          ],
          stream,
        }),
      })

      expect(res.status).toBe(200)
      await res.text()
      const forwardedInput = forwardedBody?.input as Array<Record<string, unknown>>
      expect(forwardedInput[0]).toEqual(expectedSystemMessage)
      expect(forwardedInput[1]).toEqual(expectedFileOnlySystemMessage)
      expect(forwardedInput[2]).toEqual(expectedDeveloperMessage)
      expect(forwardedInput[3]).toEqual(expectedEasyMessage)
      expect(
        forwardedInput.find(
          (item) => item.type === 'function_call_output' && item.call_id === 'call_function',
        ),
      ).toEqual({
        ...expectedFunctionOutput,
        output: [
          expectedFunctionOutput.output[0],
          {
            type: 'input_text',
            text: expect.stringContaining('[llm-proxy-ts vision fallback]'),
          },
          expectedFunctionOutput.output[1],
          expectedFunctionOutput.output[2],
        ],
      })
      expect(
        forwardedInput.find(
          (item) => item.type === 'custom_tool_call_output' && item.call_id === 'call_custom',
        ),
      ).toEqual({
        ...expectedCustomOutput,
        output: [
          expectedCustomOutput.output[0],
          {
            type: 'input_text',
            text: expect.stringContaining('[llm-proxy-ts vision fallback]'),
          },
          expectedCustomOutput.output[1],
          expectedCustomOutput.output[2],
        ],
      })
      expect(
        forwardedInput.find(
          (item) => item.type === 'function_call_output' && item.call_id === 'call_image_only',
        ),
      ).toEqual({
        type: 'function_call_output',
        call_id: 'call_image_only',
        output: expect.stringContaining('[llm-proxy-ts vision fallback]'),
        opaque_output_field: 'preserve-image-only-output',
      })
      const serialized = JSON.stringify(forwardedBody)
      expect(serialized).not.toContain('input_image')
      expect(serialized).not.toContain(imageData)
      expect(serialized).not.toContain(imageUrl)
      expect(serialized).toContain('[llm-proxy-ts vision fallback]')
    },
  )

  it.each([
    { name: 'without conversation or store', conversation: undefined, store: undefined },
    { name: 'with conversation', conversation: 'conv_123', store: undefined },
    { name: 'with store', conversation: undefined, store: true },
  ])(
    'preserves agent_message and additional_tools wire items $name',
    async ({ conversation, store }) => {
      const settings = makeOpenaiSettings()
      let forwardedBody: Record<string, unknown> | undefined
      vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
        forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        return Response.json(makeRawResponseBody(), {
          headers: { 'content-type': 'application/json' },
        })
      })
      const providerRegistry = await createProviderRegistry(settings)
      const app = createApp({ settings, providerRegistry })
      const firstAgentMessage = {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/worker',
        content: [
          { type: 'input_text', text: 'Reply with exactly: task received' },
          { type: 'encrypted_content', encrypted_content: 'encrypted-task-payload' },
        ],
      }
      const additionalTools = {
        type: 'additional_tools',
        role: 'developer',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }
      const secondAgentMessage = {
        type: 'agent_message',
        author: '/root/worker',
        recipient: '/root',
        content: [{ type: 'input_text', text: '42' }],
      }
      const rawInput = [firstAgentMessage, additionalTools, secondAgentMessage]

      const res = await app.request('/codex/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'openai/chat',
          ...(conversation !== undefined && { conversation }),
          ...(store !== undefined && { store }),
          input: rawInput,
          stream: false,
        }),
      })

      expect(res.status).toBe(200)
      expect(forwardedBody?.input).toEqual(rawInput)
      expect(forwardedBody).not.toHaveProperty('tools')
      expect(JSON.stringify(forwardedBody?.input)).not.toContain('llm_proxy_')
    },
  )

  it('preserves positional additional_tools in the final streaming SDK request body', async () => {
    const settings = makeOpenaiSettings()
    let forwardedBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      forwardedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const events = [
        {
          type: 'response.created',
          sequence_number: 0,
          response: { id: 'resp_stream', object: 'response', status: 'in_progress', output: [] },
        },
        {
          type: 'response.completed',
          sequence_number: 1,
          response: makeRawResponseBody(),
        },
      ]
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const providerRegistry = await createProviderRegistry(settings)
    const app = createApp({ settings, providerRegistry })
    const agentMessage = {
      type: 'agent_message',
      author: '/root',
      recipient: '/root/worker',
      content: [
        { type: 'input_text', text: 'Reply with exactly: task received' },
        { type: 'encrypted_content', encrypted_content: 'stream-encrypted-task-payload' },
      ],
    }

    const res = await app.request('/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/chat',
        input: [
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'developer marker' }],
          },
          agentMessage,
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [
              {
                type: 'function',
                name: 'lookup',
                parameters: { type: 'object', properties: {} },
              },
            ],
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'user marker' }],
          },
        ],
        reasoning: { effort: 'medium', context: 'all_turns' },
        stream: true,
      }),
    })

    expect(res.status).toBe(200)
    await res.text()
    expect(forwardedBody?.stream).toBe(true)
    expect(forwardedBody?.reasoning).toEqual({ effort: 'medium', context: 'all_turns' })
    expect(forwardedBody).not.toHaveProperty('tools')
    expect(
      (forwardedBody?.input as Array<Record<string, unknown>>).map(
        (item) => item.type ?? item.role,
      ),
    ).toEqual(['message', 'agent_message', 'additional_tools', 'message'])
    expect((forwardedBody?.input as unknown[])[1]).toEqual(agentMessage)
    expect(JSON.stringify(forwardedBody?.input)).not.toContain('llm_proxy_')
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
    const { logger, warn } = makeTestLogger()
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
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ code: 'auth_required' }),
        phase: 'generate',
      }),
      'upstream authentication required',
    )
  })
})
