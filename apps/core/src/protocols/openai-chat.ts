import { jsonSchema, type ToolSet } from 'ai';
import { z } from 'zod/v3';

const openAIToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    arguments: z.string().optional(),
  }),
});

const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.unknown().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(openAIToolCallSchema).optional(),
  })
  .superRefine((message, ctx) => {
    if (message.role === 'tool' && !message.tool_call_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tool_call_id'],
        message: 'tool_call_id is required for tool messages',
      });
    }
    if (message.role === 'tool' && message.content === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'content is required for tool messages',
      });
    }
    if (message.role === 'assistant' && message.content == null && !message.tool_calls?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['content'],
        message: 'assistant content is required without tool_calls',
      });
    }
  });

const functionToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  }),
});

export const openAIChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    tools: z.array(functionToolSchema).optional(),
    tool_choice: z
      .union([
        z.enum(['auto', 'none', 'required']),
        z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }) }),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
  })
  .passthrough();

export type OpenAIChatRequest = z.infer<typeof openAIChatRequestSchema>;

export interface AISDKInput {
  messages: Array<Record<string, unknown>>;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  tools?: ToolSet;
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };
  providerOptions?: Record<string, Record<string, unknown>>;
}

const mappedRequestKeys = new Set([
  'model',
  'messages',
  'stream',
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'tools',
  'tool_choice',
]);

export function validateOpenAIChatRequest(value: unknown): OpenAIChatRequest {
  return openAIChatRequestSchema.parse(value);
}

export function mapOpenAIChatRequestToAISDKInput(request: OpenAIChatRequest, providerName?: string): AISDKInput {
  const input: AISDKInput = {
    messages: request.messages.map(mapMessage),
  };

  if (request.temperature !== undefined) input.temperature = request.temperature;
  if (request.top_p !== undefined) input.topP = request.top_p;
  if (request.presence_penalty !== undefined) input.presencePenalty = request.presence_penalty;
  if (request.frequency_penalty !== undefined) input.frequencyPenalty = request.frequency_penalty;
  if (request.max_completion_tokens !== undefined) input.maxOutputTokens = request.max_completion_tokens;
  else if (request.max_tokens !== undefined) input.maxOutputTokens = request.max_tokens;
  if (request.stop !== undefined) input.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  if (request.tools) input.tools = Object.fromEntries(request.tools.map((tool) => [tool.function.name, mapFunctionTool(tool)]));
  if (request.tool_choice) {
    input.toolChoice = mapToolChoice(request.tool_choice);
  }
  if (providerName) {
    const providerOptions = mapProviderOptions(request);
    if (Object.keys(providerOptions).length > 0) {
      input.providerOptions = { [providerName]: providerOptions };
    }
  }

  return input;
}

function mapMessage(message: z.infer<typeof messageSchema>): Record<string, unknown> {
  if (message.role === 'assistant' && message.tool_calls?.length) {
    const content: Array<Record<string, unknown>> = message.tool_calls.map((toolCall) => ({
      type: 'tool-call',
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      input: parseToolCallInput(toolCall.function.arguments),
    }));
    if (typeof message.content === 'string' && message.content.length > 0) {
      content.unshift({ type: 'text', text: message.content });
    }

    return {
      role: 'assistant',
      content,
    };
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: message.tool_call_id,
          toolName: message.tool_call_id ?? 'tool',
          output: mapToolResultOutput(message.content),
        },
      ],
    };
  }

  return message as Record<string, unknown>;
}

function parseToolCallInput(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function mapToolResultOutput(content: unknown): { type: 'text'; value: string } | { type: 'json'; value: unknown } {
  if (typeof content === 'string') {
    return { type: 'text', value: content };
  }
  return { type: 'json', value: content };
}

function mapFunctionTool(tool: z.infer<typeof functionToolSchema>): ToolSet[string] {
  const definition: ToolSet[string] = {
    inputSchema: jsonSchema(tool.function.parameters),
  };
  if (tool.function.description !== undefined) {
    definition.description = tool.function.description;
  }
  return definition;
}

function mapToolChoice(choice: NonNullable<OpenAIChatRequest['tool_choice']>): NonNullable<AISDKInput['toolChoice']> {
  if (typeof choice === 'string') return choice;
  return { type: 'tool', toolName: choice.function.name };
}

function mapProviderOptions(request: OpenAIChatRequest): Record<string, unknown> {
  return Object.fromEntries(Object.entries(request).filter(([key]) => !mappedRequestKeys.has(key)));
}
