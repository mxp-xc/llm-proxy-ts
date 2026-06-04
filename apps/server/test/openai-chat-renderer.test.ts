import { describe, expect, it } from 'vitest';
import { renderOpenAIChatCompletion, renderOpenAIChatCompletionSSE } from '../src/protocols/openai-chat-renderer.js';

describe('OpenAI chat renderer', () => {
  it('renders text completions', () => {
    const body = renderOpenAIChatCompletion({
      model: 'openrouter/chat',
      text: 'hello',
      finishReason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      response: { id: 'upstream-id', timestamp: new Date(0) },
    });

    expect(body).toMatchObject({
      id: 'upstream-id',
      object: 'chat.completion',
      created: 0,
      model: 'openrouter/chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  });

  it('renders non-streaming tool calls', () => {
    const body = renderOpenAIChatCompletion({
      model: 'openrouter/chat',
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'NYC' } }],
    });

    expect(body.choices[0]!.message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
    ]);
    expect(body.choices[0]!.finish_reason).toBe('tool_calls');
  });

  it('renders text and done SSE chunks', async () => {
    async function* parts() {
      yield { type: 'text-delta', text: 'hel' };
      yield { type: 'text-delta', text: 'lo' };
      yield { type: 'finish', finishReason: 'stop' };
    }

    const chunks: string[] = [];
    for await (const chunk of renderOpenAIChatCompletionSSE({ model: 'openrouter/chat', stream: parts() })) {
      chunks.push(new TextDecoder().decode(chunk));
    }

    expect(chunks.join('')).toContain('"content":"hel"');
    expect(chunks.join('')).toContain('"content":"lo"');
    expect(chunks.at(-1)).toBe('data: [DONE]\n\n');
  });

  it('keeps a stable SSE tool call index across complete tool call events', async () => {
    async function* parts() {
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'NYC' } };
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { unit: 'fahrenheit' } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }

    const events = await collectSseEvents(parts());
    const toolCalls = events
      .flatMap((event) => event.choices)
      .flatMap((choice) => choice.delta.tool_calls ?? []);

    expect(toolCalls.map((toolCall) => toolCall.index)).toEqual([0, 0]);
    expect(events.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('renders complete tool call arguments when no argument deltas were emitted', async () => {
    async function* parts() {
      yield { type: 'tool-call-start', toolCallId: 'call_1', toolName: 'get_weather' };
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'NYC' } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }

    const events = await collectSseEvents(parts());
    const toolCalls = events
      .flatMap((event) => event.choices)
      .flatMap((choice) => choice.delta.tool_calls ?? []);

    expect(toolCalls).toMatchObject([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
    ]);
  });

  it('does not repeat complete tool call arguments after argument deltas were emitted', async () => {
    async function* parts() {
      yield { type: 'tool-call-start', toolCallId: 'call_1', toolName: 'get_weather' };
      yield { type: 'tool-call-args-delta', toolCallId: 'call_1', argsTextDelta: '{"city"' };
      yield { type: 'tool-call-delta', toolCallId: 'call_1', inputTextDelta: ':"NYC"}' };
      yield { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'NYC' } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }

    const events = await collectSseEvents(parts());
    const toolCalls = events
      .flatMap((event) => event.choices)
      .flatMap((choice) => choice.delta.tool_calls ?? []);

    expect(toolCalls).toMatchObject([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
      { index: 0, function: { arguments: '{"city"' } },
      { index: 0, function: { arguments: ':"NYC"}' } },
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
    ]);
    expect(toolCalls.at(-1)?.function).not.toHaveProperty('arguments');
  });

  it('renders AI SDK v6 tool input events and suppresses duplicate complete arguments', async () => {
    async function* parts() {
      yield { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' };
      yield { type: 'tool-input-delta', id: 'call_1', delta: '{"city"' };
      yield { type: 'tool-input-delta', id: 'call_1', delta: ':"NYC"}' };
      yield { type: 'tool-input-end', id: 'call_1' };
      yield { type: 'tool-call', id: 'call_1', toolName: 'get_weather', input: { city: 'NYC' } };
      yield { type: 'finish', finishReason: 'tool-calls' };
    }

    const events = await collectSseEvents(parts());
    const toolCalls = events
      .flatMap((event) => event.choices)
      .flatMap((choice) => choice.delta.tool_calls ?? []);

    expect(toolCalls).toMatchObject([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
      { index: 0, function: { arguments: '{"city"' } },
      { index: 0, function: { arguments: ':"NYC"}' } },
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } },
    ]);
    expect(toolCalls.at(-1)?.function).not.toHaveProperty('arguments');
  });
});

async function collectSseEvents(stream: AsyncIterable<unknown>): Promise<Array<any>> {
  const chunks: string[] = [];
  for await (const chunk of renderOpenAIChatCompletionSSE({ model: 'openrouter/chat', stream })) {
    chunks.push(new TextDecoder().decode(chunk));
  }

  return chunks
    .join('')
    .split('\n\n')
    .filter((event) => event.startsWith('data: {'))
    .map((event) => JSON.parse(event.slice('data: '.length)));
}
