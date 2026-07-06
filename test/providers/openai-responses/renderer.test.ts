import { describe, expect, it } from 'vitest'
import type { ProxyStreamPart } from '../../../src/providers/shared/aisdk-types.js'
import type {
  OpenAIResponseStreamEvent,
  ResponseOutputTextDeltaEvent,
  ResponseCompletedEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseWebSearchCall,
} from '../../../src/providers/openai-responses/types.js'
import {
  renderOpenAIResponse,
  renderOpenAIResponseSSE,
} from '../../../src/providers/openai-responses/renderer.js'
import { collectSSEFrames } from '../../helpers/sse.js'

describe('renderOpenAIResponse', () => {
  it('renders text response', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: 'Hello world',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
    expect(result.object).toBe('response')
    expect(result.model).toBe('gpt-4o')
    expect(result.status).toBe('completed')
    expect(result.output_text).toBe('Hello world')
    expect(result.output).toHaveLength(1)
    const first = result.output[0]!
    expect(first.type).toBe('message')
    if (first.type === 'message') {
      expect(first.role).toBe('assistant')
      expect(first.content[0]).toEqual({
        type: 'output_text',
        text: 'Hello world',
        annotations: [],
      })
    }
    expect(result.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    })
  })

  it('renders tool calls', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'call_123', toolName: 'get_weather', input: { location: 'Paris' } },
      ],
    })
    expect(result.status).toBe('incomplete')
    const fc = result.output.find((o) => o.type === 'function_call')
    expect(fc).toBeDefined()
    if (fc && fc.type === 'function_call') {
      expect(fc.call_id).toBe('call_123')
      expect(fc.name).toBe('get_weather')
      expect(fc.arguments).toBe('{"location":"Paris"}')
    }
  })

  it('renders text + tool calls together', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: 'Let me check',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'call_123', toolName: 'get_weather', input: { location: 'Paris' } },
      ],
    })
    expect(result.output).toHaveLength(2)
    expect(result.output[0]!.type).toBe('message')
    expect(result.output[1]!.type).toBe('function_call')
    expect(result.status).toBe('incomplete')
  })

  it('maps finishReason to status', () => {
    expect(renderOpenAIResponse({ model: 'gpt-4o', text: 'hi', finishReason: 'stop' }).status).toBe(
      'completed',
    )
    expect(
      renderOpenAIResponse({ model: 'gpt-4o', text: 'hi', finishReason: 'length' }).status,
    ).toBe('incomplete')
    expect(
      renderOpenAIResponse({ model: 'gpt-4o', text: 'hi', finishReason: 'content-filter' }).status,
    ).toBe('incomplete')
  })

  it('uses response id and timestamp when provided', () => {
    const ts = new Date('2024-01-01T00:00:00Z')
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: 'hi',
      finishReason: 'stop',
      response: { id: 'resp_abc123', timestamp: ts },
    })
    expect(result.id).toBe('resp_abc123')
    expect(result.created_at).toBe(Math.floor(ts.getTime() / 1000))
  })

  it('generates resp_ prefixed id when no response id', () => {
    const result = renderOpenAIResponse({ model: 'gpt-4o', text: 'hi', finishReason: 'stop' })
    expect(result.id).toMatch(/^resp_/)
  })

  it('omits usage in non-streaming when all tokens are zero', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: 'hi',
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    expect(result.usage).toBeUndefined()
  })

  it('passes cacheReadTokens and reasoningTokens through in non-streaming response', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: 'hi',
      finishReason: 'stop',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 20,
        cacheReadTokens: 3,
        reasoningTokens: 7,
      },
    })
    expect(result.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 20,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 7 },
    })
  })

  it('generates msg_ prefixed id for message output items', () => {
    const result = renderOpenAIResponse({ model: 'gpt-4o', text: 'hi', finishReason: 'stop' })
    expect(result.output[0]!.id).toMatch(/^msg_/)
  })

  it('generates fc_ prefixed id for function_call output items', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'call_123', toolName: 'get_weather', input: {} }],
    })
    const fc = result.output.find((o) => o.type === 'function_call')
    expect(fc!.id).toMatch(/^fc_/)
  })

  // Bug #5 — empty-string text should still produce a message output item
  it('produces message output item for empty-string text', () => {
    const result = renderOpenAIResponse({ model: 'gpt-4o', text: '', finishReason: 'stop' })
    expect(result.output).toHaveLength(1)
    expect(result.output[0]!.type).toBe('message')
    expect(result.output_text).toBe('')
  })

  // Bug #9 — string args should not be double-encoded
  it('does not double-encode string tool call input', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-4o',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'call_1', toolName: 'test', input: '{"already":"serialized"}' }],
    })
    const fc = result.output.find((o) => o.type === 'function_call')
    if (fc && fc.type === 'function_call') {
      expect(fc.arguments).toBe('{"already":"serialized"}')
    }
  })
})

// ─── Streaming SSE Renderer Tests ─────────────────────────────

async function* textStream() {
  yield { type: 'text-delta', text: 'Hello' }
  yield { type: 'text-delta', text: ' world' }
  yield {
    type: 'finish',
    finishReason: 'stop',
    totalUsage: { inputTokens: 10, outputTokens: 5 },
    response: { id: 'resp_test123' },
  }
}

describe('renderOpenAIResponseSSE', () => {
  it('emits correct event sequence for text streaming', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: textStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes).toContain('response.created')
    expect(eventTypes).toContain('response.in_progress')
    expect(eventTypes).toContain('response.output_item.added')
    expect(eventTypes).toContain('response.content_part.added')
    expect(eventTypes.filter((t) => t === 'response.output_text.delta')).toHaveLength(2)
    expect(eventTypes).toContain('response.output_text.done')
    expect(eventTypes).toContain('response.content_part.done')
    expect(eventTypes).toContain('response.output_item.done')
    expect(eventTypes).toContain('response.completed')
  })

  it('emits text delta content', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: textStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const deltas = events
      .filter((e) => e.event === 'response.output_text.delta')
      .map((e) => e.data as ResponseOutputTextDeltaEvent)
    expect(deltas[0]!.delta).toBe('Hello')
    expect(deltas[1]!.delta).toBe(' world')
  })

  it('emits completed response with full data', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: textStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const completed = events.find((e) => e.event === 'response.completed')!
      .data as ResponseCompletedEvent
    expect(completed.response.object).toBe('response')
    expect(completed.response.status).toBe('completed')
    expect(completed.response.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    })
  })

  it('omits usage in completed response when usage is all zeros', async () => {
    async function* noUsageStream() {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'finish', finishReason: 'stop', response: { id: 'resp_no_usage' } }
    }
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: noUsageStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const completed = events.find((e) => e.event === 'response.completed')!
      .data as ResponseCompletedEvent
    expect(completed.response.usage).toBeUndefined()
  })

  it('passes cacheReadTokens and reasoningTokens through in SSE response.completed', async () => {
    async function* detailStream() {
      yield { type: 'text-delta', text: 'hi' }
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 20,
          inputTokenDetails: { cacheReadTokens: 3 },
          outputTokenDetails: { reasoningTokens: 7 },
        },
        response: { id: 'resp_detail' },
      }
    }
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: detailStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const completed = events.find((e) => e.event === 'response.completed')!
      .data as ResponseCompletedEvent
    expect(completed.response.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 20,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 7 },
    })
  })

  it('includes sequence_number in events', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: textStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    for (const event of events) {
      expect(typeof event.data.sequence_number).toBe('number')
    }
  })

  // Bug #3 / #1 — Streaming tool-call with complete part (no deltas)
  async function* toolCallStream() {
    yield {
      type: 'tool-call',
      toolCallId: 'call_123',
      toolName: 'get_weather',
      input: { location: 'Paris' },
    }
    yield {
      type: 'finish',
      finishReason: 'tool-calls',
      totalUsage: { inputTokens: 10, outputTokens: 5 },
      response: { id: 'resp_test' },
    }
  }

  it('emits tool-call events for complete tool-call part', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: toolCallStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes).toContain('response.output_item.added')
    expect(eventTypes).toContain('response.function_call_arguments.delta')
    expect(eventTypes).toContain('response.function_call_arguments.done')
    expect(eventTypes).toContain('response.output_item.done')
    expect(eventTypes).toContain('response.completed')
  })

  // Bug #2 — Error terminal behavior
  async function* errorStream() {
    yield { type: 'text-delta', text: 'Hello' }
    yield { type: 'error', error: new Error('upstream failed') }
  }

  it('emits response.failed after error and terminates stream', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: errorStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes).toContain('response.failed')
    expect(eventTypes).not.toContain('response.completed')
    const failed = events.find((e) => e.event === 'response.failed')!
    expect((failed.data as any).response.status).toBe('failed')
    expect((failed.data as any).response.error.message).toBe('upstream failed')
    // No events after response.failed
    const failedIndex = eventTypes.indexOf('response.failed')
    expect(eventTypes.length).toBe(failedIndex + 1)
  })

  // Bug #1 — response.completed includes tool calls
  it('includes function_call items in response.completed output', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: toolCallStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const completed = events.find((e) => e.event === 'response.completed')!
      .data as ResponseCompletedEvent
    const output = completed.response.output
    expect(output.some((item) => item.type === 'function_call')).toBe(true)
  })

  // Bug #3 — Streaming tool-call with incremental deltas
  async function* toolCallDeltaStream() {
    yield { type: 'tool-input-start', id: 'call_abc', toolName: 'search' }
    yield { type: 'tool-input-delta', id: 'call_abc', delta: '{"q":"h' }
    yield { type: 'tool-input-delta', id: 'call_abc', delta: 'ello"}' }
    yield { type: 'tool-call', toolCallId: 'call_abc', toolName: 'search', input: '{"q":"hello"}' }
    yield {
      type: 'finish',
      finishReason: 'tool-calls',
      totalUsage: { inputTokens: 5, outputTokens: 10 },
      response: { id: 'resp_delta' },
    }
  }

  it('handles tool-call-start and tool-call-delta incremental events', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: toolCallDeltaStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes).toContain('response.output_item.added')
    // Two deltas from tool-call-delta parts
    const argDeltas = events
      .filter((e) => e.event === 'response.function_call_arguments.delta')
      .map((e) => e.data as ResponseFunctionCallArgumentsDeltaEvent)
    expect(argDeltas.length).toBe(2)
    expect(argDeltas[0]!.delta).toBe('{"q":"h')
    expect(argDeltas[1]!.delta).toBe('ello"}')
    expect(eventTypes).toContain('response.function_call_arguments.done')
    expect(eventTypes).toContain('response.output_item.done')
    expect(eventTypes).toContain('response.completed')
  })

  // Bug #12 — new msgId after tool call
  async function* textThenToolCallStream() {
    yield { type: 'text-delta', text: 'Hello' }
    yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'fn', input: {} }
    yield { type: 'text-delta', text: ' world' }
    yield {
      type: 'finish',
      finishReason: 'stop',
      totalUsage: { inputTokens: 5, outputTokens: 5 },
      response: { id: 'resp_multi' },
    }
  }

  it('uses different msgId for text after tool call', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-4o',
      stream: textThenToolCallStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const addedItems = events
      .filter((e) => e.event === 'response.output_item.added')
      .map((e) => e.data as ResponseOutputItemAddedEvent)
    // First text message, then function_call, then second text message
    const msgItems = addedItems.filter((e) => e.item?.type === 'message')
    expect(msgItems.length).toBe(2)
    // The two message items should have different ids
    const ids = msgItems.map((e) => e.item.id)
    expect(ids[0]).not.toBe(ids[1])
  })

  // reasoning + encrypted_content 透传：@ai-sdk/openai 把 encrypted_content 写入 reasoning part 的 providerMetadata
  async function* reasoningStream() {
    yield {
      type: 'reasoning-start',
      id: 'rs-0',
      providerMetadata: { openai: { reasoningEncryptedContent: 'enc-blob' } },
    }
    yield { type: 'reasoning-delta', id: 'rs-0', text: 'thinking' }
    yield { type: 'reasoning-end', id: 'rs-0' }
    yield {
      type: 'finish',
      finishReason: 'stop',
      totalUsage: { inputTokens: 5, outputTokens: 5 },
      response: { id: 'resp_rs' },
    }
  }

  it('writes encrypted_content into reasoning output item from providerMetadata', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: reasoningStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const reasoningDone = events.find((e) => e.event === 'response.output_item.done')
    const item = (reasoningDone!.data as ResponseOutputItemDoneEvent).item
    expect(item.type).toBe('reasoning')
    if (item.type === 'reasoning') {
      expect(item.encrypted_content).toBe('enc-blob')
      expect(item.summary).toEqual([{ type: 'summary_text', text: 'thinking' }])
    }
  })

  // apply_patch → custom_tool_call 渲染（AI SDK 把上游 custom_tool_call 映射成 tool-call toolName='apply_patch'）
  // apply_patch 裸 patch 文本（含换行等特殊字符，验证 JSON.stringify → JSON.parse 还原）
  const applyPatchText = '*** Begin Patch\n*** Add File: foo.txt\n+hello\n*** End Patch'
  async function* applyPatchCallStream() {
    yield { type: 'tool-input-start', id: 'call_1', toolName: 'apply_patch' }
    yield { type: 'tool-input-delta', id: 'call_1', delta: '*** Begin Patch' }
    yield {
      type: 'tool-call',
      toolCallId: 'call_1',
      toolName: 'apply_patch',
      input: JSON.stringify(applyPatchText),
    }
    yield {
      type: 'finish',
      finishReason: 'tool-calls',
      totalUsage: { inputTokens: 5, outputTokens: 5 },
      response: { id: 'resp_ap' },
    }
  }

  it('renders apply_patch tool-call as custom_tool_call with decoded input', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: applyPatchCallStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const added = events.find((e) => e.event === 'response.output_item.added')
    expect((added!.data as ResponseOutputItemAddedEvent).item.type).toBe('custom_tool_call')
    const done = events.find((e) => e.event === 'response.output_item.done')
    const doneItem = (done!.data as ResponseOutputItemDoneEvent).item
    expect(doneItem.type).toBe('custom_tool_call')
    if (doneItem.type === 'custom_tool_call') {
      // input 被 AI SDK JSON.stringify 包裹，renderer JSON.parse 还原为裸 patch 文本
      expect(doneItem.input).toBe(applyPatchText)
    }
    expect(events.some((e) => e.event === 'response.custom_tool_call_input.delta')).toBe(true)
    expect(events.some((e) => e.event === 'response.function_call_arguments.delta')).toBe(false)
  })

  // web_search_call 渲染：AI SDK 把上游 web_search_call 映射成 tool-call(providerExecuted:true) + tool-result 对
  async function* webSearchCallStream() {
    yield { type: 'tool-input-start', id: 'ws_1', toolName: 'web_search', providerExecuted: true }
    yield { type: 'tool-input-end', id: 'ws_1' }
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
      output: { action: { type: 'search', query: 'rust async' } },
    }
    yield {
      type: 'finish',
      finishReason: 'stop',
      totalUsage: { inputTokens: 5, outputTokens: 5 },
      response: { id: 'resp_ws' },
    }
  }

  it('renders web_search tool-call + tool-result as web_search_call output item', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: webSearchCallStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const done = events.find((e) => e.event === 'response.output_item.done')
    const item = (done!.data as ResponseOutputItemDoneEvent).item
    expect(item.type).toBe('web_search_call')
    if (item.type === 'web_search_call') {
      expect(item.id).toBe('ws_1')
      expect(item.status).toBe('completed')
      expect(item.action).toEqual({ type: 'search', query: 'rust async' })
    }
  })

  // AI SDK mapWebSearchOutput 把上游 snake_case action.type 转成 camelCase（open_page→openPage），
  // mapWebSearchAction 需转回 snake_case（Codex 期望）。
  it('converts web_search action.type from camelCase back to snake_case (openPage→open_page)', async () => {
    async function* openPageStream() {
      yield {
        type: 'tool-call',
        toolCallId: 'ws_2',
        toolName: 'web_search',
        input: '{}',
        providerExecuted: true,
      }
      yield {
        type: 'tool-result',
        toolCallId: 'ws_2',
        toolName: 'web_search',
        output: { action: { type: 'openPage', url: 'https://example.com' } },
      }
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 5, outputTokens: 5 },
        response: { id: 'resp_op' },
      }
    }
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: openPageStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const done = events.find((e) => e.event === 'response.output_item.done')
    const item = (done!.data as ResponseOutputItemDoneEvent).item
    expect(item.type).toBe('web_search_call')
    if (item.type === 'web_search_call') {
      expect(item.action).toEqual({ type: 'open_page', url: 'https://example.com' })
    }
  })

  // Fix 1: hosted web_search_call 不应触发 'incomplete' status。
  // 上游内联执行 web_search，finishReason='stop' 时 Codex 期望 status='completed'。
  it('web_search + finish(stop) yields response.completed with status completed (not incomplete)', async () => {
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: webSearchCallStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const completed = events.find((e) => e.event === 'response.completed')!
      .data as ResponseCompletedEvent
    expect(completed.response.status).toBe('completed')
    // web_search_call 仍在 output 中
    expect(completed.response.output.some((o) => o.type === 'web_search_call')).toBe(true)
  })

  // Fix 1 (non-streaming): hosted web_search_call 不触发 incomplete
  it('non-streaming web_search + finish(stop) yields status completed', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: 'answer',
      finishReason: 'stop',
      toolCalls: [
        { toolCallId: 'ws_1', toolName: 'web_search', input: {}, providerExecuted: true },
      ],
    })
    expect(result.status).toBe('completed')
    expect(result.output.some((o) => o.type === 'web_search_call')).toBe(true)
  })

  // Fix 2: hosted tool-call 后紧跟 text-delta 再 tool-result —— text message 和 web_search_call
  // 必须在各自独立的 output_index，互不覆盖。AI SDK 实际背靠背发 tool-call/tool-result，
  // 此测试构造交错序列以验证状态机在 outputIndex 被占用时不冲突。
  it('hosted tool-call + text-delta + tool-result render at distinct output indices without overwriting', async () => {
    async function* interleavedStream() {
      yield { type: 'text-delta', text: 'before' }
      yield { type: 'tool-input-start', id: 'ws_2', toolName: 'web_search', providerExecuted: true }
      yield { type: 'tool-input-end', id: 'ws_2' }
      // hosted tool-call 到达：只记录 id，不占 outputIndex，不关闭 in-progress text message
      yield {
        type: 'tool-call',
        toolCallId: 'ws_2',
        toolName: 'web_search',
        input: '{}',
        providerExecuted: true,
      }
      // text-delta 到达：继续写入同一个 in-progress text message（不被 web_search_call 覆盖）
      yield { type: 'text-delta', text: '-after' }
      // hosted tool-result 到达：关闭 text message（index 0），再 added+done web_search_call（index 1）
      yield {
        type: 'tool-result',
        toolCallId: 'ws_2',
        toolName: 'web_search',
        output: { action: { type: 'search', query: 'q' } },
      }
      yield {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: { inputTokens: 5, outputTokens: 5 },
        response: { id: 'resp_inter' },
      }
    }
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: interleavedStream() as AsyncIterable<ProxyStreamPart>,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const addedItems = events
      .filter((e) => e.event === 'response.output_item.added')
      .map((e) => e.data as ResponseOutputItemAddedEvent)
    const doneItems = events
      .filter((e) => e.event === 'response.output_item.done')
      .map((e) => e.data as ResponseOutputItemDoneEvent)

    // message item 在 index 0，web_search_call 在 index 1
    const msgAdded = addedItems.find((e) => e.item?.type === 'message')
    const wsAdded = addedItems.find((e) => e.item?.type === 'web_search_call')
    expect(msgAdded).toBeDefined()
    expect(wsAdded).toBeDefined()
    expect(msgAdded!.output_index).toBe(0)
    expect(wsAdded!.output_index).toBe(1)

    // text message 累积了 before-after（未被 web_search 覆盖）
    const msgDone = doneItems.find((e) => e.item?.type === 'message')
    expect(msgDone).toBeDefined()
    if (msgDone!.item.type === 'message') {
      expect(msgDone!.item.content[0]!.text).toBe('before-after')
    }
    // web_search_call done 带正确 action
    const wsDone = doneItems.find((e) => e.item?.type === 'web_search_call')
    expect(wsDone).toBeDefined()
    expect(wsDone!.output_index).toBe(1)

    // completed.output 包含 message + web_search_call，status completed
    const completed = events.find((e) => e.event === 'response.completed')!
      .data as ResponseCompletedEvent
    expect(completed.response.status).toBe('completed')
    expect(completed.response.output.some((o) => o.type === 'message')).toBe(true)
    expect(completed.response.output.some((o) => o.type === 'web_search_call')).toBe(true)
  })

  // 非 apply_patch 的 custom tool（通过请求侧声明的 customToolNames 集合判别）也应渲染为 custom_tool_call。
  // AI SDK @3.0.71 不暴露 toolCallType 信号，故 renderer 依赖请求侧传入的 name 集合。
  it('renders custom tool by customToolNames set, not just apply_patch name', async () => {
    async function* customStream() {
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
        response: { id: 'resp_c' },
      }
    }
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: customStream() as AsyncIterable<ProxyStreamPart>,
      customToolNames: new Set(['my_grammar_tool']),
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const done = events.find((e) => e.event === 'response.output_item.done')
    expect((done!.data as ResponseOutputItemDoneEvent).item.type).toBe('custom_tool_call')
  })

  // 非流式路径也应通过 customToolNames 集合判别 custom tool
  it('renders custom tool by customToolNames set in non-streaming renderOpenAIResponse', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'call_1', toolName: 'my_grammar_tool', input: JSON.stringify('payload') },
      ],
      customToolNames: new Set(['my_grammar_tool']),
    })
    const item = result.output.find((o) => o.type === 'custom_tool_call')
    expect(item).toBeDefined()
    expect(result.output.some((o) => o.type === 'function_call')).toBe(false)
  })

  // shimmed custom tool: function tool returns {"input":"patch"}, renderer extracts input field
  it('decodes shimmed custom tool input as bare patch text in streaming', async () => {
    async function* shimmedStream() {
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'apply_patch',
        input: JSON.stringify({ input: applyPatchText }),
      }
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: { inputTokens: 5, outputTokens: 5 },
        response: { id: 'resp_s' },
      }
    }
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: shimmedStream() as AsyncIterable<ProxyStreamPart>,
      customToolNames: new Set(['apply_patch']),
      customToolShimmed: true,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const done = events.find((e) => e.event === 'response.output_item.done')
    const doneItem = (done!.data as ResponseOutputItemDoneEvent).item
    expect(doneItem.type).toBe('custom_tool_call')
    if (doneItem.type === 'custom_tool_call') {
      expect(doneItem.input).toBe(applyPatchText)
    }
  })

  it('decodes shimmed custom tool input as bare patch text in non-streaming', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        {
          toolCallId: 'call_1',
          toolName: 'apply_patch',
          input: JSON.stringify({ input: applyPatchText }),
        },
      ],
      customToolNames: new Set(['apply_patch']),
      customToolShimmed: true,
    })
    const item = result.output.find((o) => o.type === 'custom_tool_call')
    expect(item).toBeDefined()
    if (item && item.type === 'custom_tool_call') {
      expect(item.input).toBe(applyPatchText)
    }
  })

  it('decodes shimmed custom tool input from object args (AI SDK passes parsed object)', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'call_1', toolName: 'apply_patch', input: { input: applyPatchText } },
      ],
      customToolNames: new Set(['apply_patch']),
      customToolShimmed: true,
    })
    const item = result.output.find((o) => o.type === 'custom_tool_call')
    expect(item).toBeDefined()
    if (item && item.type === 'custom_tool_call') {
      expect(item.input).toBe(applyPatchText)
    }
  })

  it('skips tool-input-delta for shimmed custom tool and emits complete input at tool-call', async () => {
    async function* shimmedDeltaStream() {
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'apply_patch' }
      yield { type: 'tool-input-delta', id: 'call_1', delta: '{"inp' }
      yield { type: 'tool-input-delta', id: 'call_1', delta: 'ut":"*** Begin Patch"}' }
      yield { type: 'tool-input-end', id: 'call_1' }
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'apply_patch',
        input: JSON.stringify({ input: applyPatchText }),
      }
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: { inputTokens: 5, outputTokens: 5 },
        response: { id: 'resp_sd' },
      }
    }
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: shimmedDeltaStream() as AsyncIterable<ProxyStreamPart>,
      customToolNames: new Set(['apply_patch']),
      customToolShimmed: true,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const deltaEvents = events.filter((e) => e.event === 'response.custom_tool_call_input.delta')
    expect(deltaEvents.length).toBe(1)
    expect((deltaEvents[0]!.data as { delta: string }).delta).toBe(applyPatchText)
    const done = events.find((e) => e.event === 'response.output_item.done')
    const doneItem = (done!.data as ResponseOutputItemDoneEvent).item
    if (doneItem.type === 'custom_tool_call') {
      expect(doneItem.input).toBe(applyPatchText)
    }
  })

  it('renders shimmed tool_search as tool_search_call in streaming', async () => {
    async function* tsStream() {
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
        response: { id: 'resp_ts' },
      }
    }
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: tsStream() as AsyncIterable<ProxyStreamPart>,
      toolSearchShimmed: true,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    const done = events.find((e) => e.event === 'response.output_item.done')
    const doneItem = (done!.data as ResponseOutputItemDoneEvent).item
    expect(doneItem.type).toBe('tool_search_call')
    if (doneItem.type === 'tool_search_call') {
      expect(doneItem.call_id).toBe('ts_1')
      expect(doneItem.execution).toBe('client')
      expect(doneItem.arguments).toEqual({ query: 'browser', limit: 5 })
    }
  })

  it('renders shimmed tool_search as tool_search_call in non-streaming', () => {
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'ts_1', toolName: 'tool_search', input: { query: 'test', limit: 3 } },
      ],
      toolSearchShimmed: true,
    })
    const item = result.output.find((o) => o.type === 'tool_search_call')
    expect(item).toBeDefined()
    if (item && item.type === 'tool_search_call') {
      expect(item.call_id).toBe('ts_1')
      expect(item.execution).toBe('client')
      expect(item.arguments).toEqual({ query: 'test', limit: 3 })
    }
  })

  it('renders flattened toolName back to {name, namespace} in non-streaming', () => {
    const namespaceFlatMap = new Map([
      ['multi_agent_v1__spawn_agent', { namespace: 'multi_agent_v1', name: 'spawn_agent' }],
      [
        'mcp__codegraph__codegraph_search',
        { namespace: 'mcp__codegraph', name: 'codegraph_search' },
      ],
    ])
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'call_1', toolName: 'multi_agent_v1__spawn_agent', input: { message: 'hi' } },
        {
          toolCallId: 'call_2',
          toolName: 'mcp__codegraph__codegraph_search',
          input: { query: 'x' },
        },
        { toolCallId: 'call_3', toolName: 'exec_command', input: { cmd: 'ls' } },
      ],
      namespaceFlatMap,
    })
    const fc1 = result.output.find(
      (o) => o.type === 'function_call' && (o as { call_id?: string }).call_id === 'call_1',
    )
    const fc2 = result.output.find(
      (o) => o.type === 'function_call' && (o as { call_id?: string }).call_id === 'call_2',
    )
    const fc3 = result.output.find(
      (o) => o.type === 'function_call' && (o as { call_id?: string }).call_id === 'call_3',
    )
    expect(fc1).toMatchObject({
      type: 'function_call',
      name: 'spawn_agent',
      namespace: 'multi_agent_v1',
    })
    expect(fc2).toMatchObject({
      type: 'function_call',
      name: 'codegraph_search',
      namespace: 'mcp__codegraph',
    })
    // 普通工具不带 namespace 字段（codex master 不支持扁平名，namespace 字段必须省略，而非 undefined）
    expect(fc3).toMatchObject({ type: 'function_call', name: 'exec_command' })
    expect('namespace' in (fc3 as object)).toBe(false)
  })

  it('renders flattened toolName back to {name, namespace} in streaming', async () => {
    const namespaceFlatMap = new Map([
      ['multi_agent_v1__spawn_agent', { namespace: 'multi_agent_v1', name: 'spawn_agent' }],
    ])
    async function* gen() {
      yield {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'multi_agent_v1__spawn_agent',
        input: { message: 'hi' },
      }
      yield {
        type: 'finish',
        finishReason: 'tool-calls',
        totalUsage: { inputTokens: 5, outputTokens: 5 },
        response: { id: 'resp_x' },
      }
    }
    const stream = renderOpenAIResponseSSE({
      model: 'gpt-5',
      stream: gen() as AsyncIterable<ProxyStreamPart>,
      namespaceFlatMap,
    })
    const events = await collectSSEFrames<OpenAIResponseStreamEvent>(stream)
    // added item 也带拆回的 name/namespace
    const added = events.find((e) => e.event === 'response.output_item.added')
    const addedItem = (added!.data as ResponseOutputItemAddedEvent).item
    expect(addedItem.type).toBe('function_call')
    if (addedItem.type === 'function_call') {
      expect(addedItem.name).toBe('spawn_agent')
      expect((addedItem as { namespace?: string }).namespace).toBe('multi_agent_v1')
    }
    // done item
    const done = events.find((e) => e.event === 'response.output_item.done')
    const doneItem = (done!.data as ResponseOutputItemDoneEvent).item
    expect(doneItem.type).toBe('function_call')
    if (doneItem.type === 'function_call') {
      expect(doneItem.name).toBe('spawn_agent')
      expect((doneItem as { namespace?: string }).namespace).toBe('multi_agent_v1')
    }
    // response.completed 的 output 也含拆回字段（codex 实际消费）
    const completed = events.find((e) => e.event === 'response.completed')
    const completedOutput = (
      completed!.data as {
        response: { output: Array<{ type: string; name?: string; namespace?: string }> }
      }
    ).response.output
    const fc = completedOutput.find((o) => o.type === 'function_call')
    expect(fc?.name).toBe('spawn_agent')
    expect(fc?.namespace).toBe('multi_agent_v1')
  })

  it('renders codex_app namespace tool back to {name, namespace}', () => {
    const namespaceFlatMap = new Map([
      [
        'codex_app__load_workspace_dependencies',
        { namespace: 'codex_app', name: 'load_workspace_dependencies' },
      ],
    ])
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'call_1', toolName: 'codex_app__load_workspace_dependencies', input: {} },
      ],
      namespaceFlatMap,
    })
    const fc = result.output.find((o) => o.type === 'function_call')
    expect(fc).toMatchObject({
      type: 'function_call',
      name: 'load_workspace_dependencies',
      namespace: 'codex_app',
    })
  })

  it('does not resolve namespace for tool_search shimmed call (isTsShimmed takes priority)', () => {
    // namespaceFlatMap 误含 'tool_search' 时，tool_search 仍渲染为 tool_search_call（不被拆回为 function_call）
    const namespaceFlatMap = new Map([['tool_search', { namespace: 'wrong', name: 'tool_search' }]])
    const result = renderOpenAIResponse({
      model: 'gpt-5',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'ts_1', toolName: 'tool_search', input: { query: 'x' } }],
      toolSearchShimmed: true,
      namespaceFlatMap,
    })
    expect(result.output.find((o) => o.type === 'tool_search_call')).toBeDefined()
    // 不应出现 function_call（被误拆回）
    expect(result.output.find((o) => o.type === 'function_call')).toBeUndefined()
  })
})
