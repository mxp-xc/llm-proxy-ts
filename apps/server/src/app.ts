import { generateText, streamText } from 'ai';
import { Hono } from 'hono';
import type { Settings, TokenManager, AuthStatus, ResolvedAuthPlugin } from '@llm-proxy/core';
import { OAuthError, inspectVendorSseError, mapOpenAIChatRequestToAISDKInput, validateOpenAIChatRequest, renderOpenAIChatCompletion, renderOpenAIChatCompletionSSE, getModel, listModels, RoutingError, RoutingTable, createProviderRegistry } from '@llm-proxy/core';
import type { ProviderRegistry } from '@llm-proxy/core';
import pino from 'pino';
import { logger as defaultLogger, requestId } from './logging.js';
import { createOAuthCallbackApp } from './oauth/callback.js';
import type { ProviderAuthStatus } from './oauth/startup.js';

export type { Settings } from '@llm-proxy/core';

export interface ModelGateway {
  generate(input: { model: unknown; callInput: any; requestModel: string; abortSignal?: AbortSignal }): Promise<any>;
  stream(input: { model: unknown; callInput: any; requestModel: string; abortSignal?: AbortSignal }): AsyncIterable<unknown>;
}

export interface AppDependencies {
  settings: Settings;
  providerRegistry?: ProviderRegistry;
  gateway?: ModelGateway;
  logger?: pino.Logger;
  tokenManager?: TokenManager;
  nonce?: string;
  authStatuses?: ProviderAuthStatus[];
  authPlugins?: Map<string, ResolvedAuthPlugin>;
  authFilePath?: string;
}

type AppEnv = {
  Variables: {
    requestId: string;
    logger: pino.Logger;
    requestedModel?: string;
    actualModel?: string;
    provider?: string;
  };
};

export function createApp({
  settings,
  tokenManager,
  logger = defaultLogger,
  providerRegistry,
  gateway = defaultGateway,
  nonce,
  authStatuses,
  authPlugins,
  authFilePath,
}: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const routingTable = RoutingTable.fromSettings(settings);
  const resolvedRegistry = providerRegistry ?? createProviderRegistry(settings, tokenManager, logger, authPlugins, authFilePath);

  // 挂载 OAuth 回调路由
  if (tokenManager && nonce) {
    const oauthApp = createOAuthCallbackApp({ settings, tokenManager, nonce });
    app.route('/oauth', oauthApp);
  }

  app.use('*', async (c, next) => {
    const id = requestId();
    const reqLogger = logger.child({ requestId: id });
    c.set('requestId', id);
    c.set('logger', reqLogger);

    const start = performance.now();
    reqLogger.info({ method: c.req.method, path: c.req.path }, 'request started');

    await next();

    const duration = performance.now() - start;
    reqLogger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs: Math.round(duration),
        provider: c.get('provider'),
        requestedModel: c.get('requestedModel'),
        actualModel: c.get('actualModel'),
      },
      'request completed',
    );
    c.header('x-request-id', id);
  });

  app.get('/health', (c) => {
    const base: Record<string, unknown> = {
      status: 'ok',
      service: settings.service.name,
      providersConfigured: Object.keys(settings.providers).length,
    };

    if (authStatuses && authStatuses.length > 0) {
      base.auth = Object.fromEntries(
        authStatuses.map((s) => [
          s.provider,
          s.status === 'valid'
            ? { status: s.status }
            : { status: s.status, loginUrl: s.loginUrl },
        ]),
      );
    }

    return c.json(base);
  });

  app.get('/v1/models', (c) => c.json(listModels(settings)));

  app.get('/v1/models/*', (c) => {
    const modelId = c.req.path.replace('/v1/models/', '');
    if (!modelId) {
      return c.json(
        { error: { type: 'invalid_request_error', message: 'Model ID is required' } },
        400,
      );
    }
    const model = getModel(settings, modelId);
    if (!model) {
      return c.json(
        { error: { type: 'invalid_request_error', message: `Model '${modelId}' not found` } },
        404,
      );
    }
    return c.json(model);
  });

  app.post('/v1/chat/completions', async (c) => {
    let request;
    try {
      request = validateOpenAIChatRequest(await c.req.json());
    } catch {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            code: 'invalid_request',
            message: 'Invalid OpenAI chat completion request',
          },
        },
        400,
      );
    }

    let route;
    try {
      route = routingTable.resolve(request.model);
    } catch (error) {
      if (error instanceof RoutingError) {
        return c.json(error.toResponse(), error.status as 404);
      }
      throw error;
    }

    c.set('provider', route.providerName);
    c.set('requestedModel', request.model);
    c.set('actualModel', route.upstreamModel);

    const callInput = mapOpenAIChatRequestToAISDKInput(request, route.providerName);
    let model;
    try {
      model = resolvedRegistry.languageModel(route.providerName, route.upstreamModel, route.headers);
    } catch (error) {
      if (error instanceof OAuthError && error.code === 'auth_required') {
        return c.json(
          {
            error: {
              type: 'auth_required',
              code: 'oauth_login_needed',
              message: error.message,
              loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
            },
          },
          503,
        );
      }
      throw error;
    }
    const abortController = new AbortController();

    if (request.stream) {
      try {
        const stream = gateway.stream({ model, callInput, requestModel: request.model, abortSignal: abortController.signal });
        const inspection = await withRequestTimeout(
          inspectFirstStreamChunk(route.plugins, stream),
          settings.requestTimeoutMs,
          abortController,
        );
        if (inspection.error) {
          return c.json(inspection.error.body, inspection.error.status as 429);
        }
        return new Response(readableStreamFromAsyncIterable(renderOpenAIChatCompletionSSE({ model: request.model, stream: inspection.stream })), {
          headers: { 'content-type': 'text/event-stream' },
        });
      } catch (error) {
        c.get('logger').error({ err: error }, 'stream request failed');
        if (error instanceof OAuthError && error.code === 'auth_required') {
          return c.json(
            {
              error: {
                type: 'auth_required',
                code: 'oauth_login_needed',
                message: error.message,
                loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
              },
            },
            503,
          );
        }
        if (error instanceof RequestTimeoutError) {
          return upstreamTimeoutResponse();
        }
        return upstreamErrorResponse();
      }
    }

    try {
      const result = await withRequestTimeout(
        gateway.generate({ model, callInput, requestModel: request.model, abortSignal: abortController.signal }),
        settings.requestTimeoutMs,
        abortController,
      );
      return c.json(
        renderOpenAIChatCompletion({
          model: request.model,
          text: result.text,
          finishReason: result.finishReason,
          usage: result.usage,
          response: result.response,
          toolCalls: result.toolCalls,
        }),
      );
    } catch (error) {
      c.get('logger').error({ err: error }, 'generation request failed');
      if (error instanceof OAuthError && error.code === 'auth_required') {
        return c.json(
          {
            error: {
              type: 'auth_required',
              code: 'oauth_login_needed',
              message: error.message,
              loginUrl: `http://127.0.0.1:${settings.service.port}/oauth/login/${route.providerName}`,
            },
          },
          503,
        );
      }
      if (error instanceof RequestTimeoutError) {
        return upstreamTimeoutResponse();
      }
      return upstreamErrorResponse();
    }
  });

  return app;
}

const defaultGateway: ModelGateway = {
  async generate({ model, callInput, abortSignal }) {
    return generateText({ model, ...callInput, abortSignal } as Parameters<typeof generateText>[0]);
  },
  stream({ model, callInput, abortSignal }) {
    return streamText({ model, ...callInput, abortSignal } as Parameters<typeof streamText>[0]).fullStream as AsyncIterable<unknown>;
  },
};

class RequestTimeoutError extends Error {
  constructor() {
    super('Request timed out');
  }
}

async function withRequestTimeout<T>(promise: Promise<T>, timeoutMs: number, abortController: AbortController): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      abortController.abort();
      reject(new RequestTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function upstreamTimeoutResponse(): Response {
  return Response.json(
    {
      error: {
        type: 'upstream_error',
        code: 'upstream_request_timeout',
        message: 'Upstream provider request timed out',
      },
    },
    { status: 504 },
  );
}

function upstreamErrorResponse(): Response {
  return Response.json(
    {
      error: {
        type: 'upstream_error',
        code: 'upstream_request_failed',
        message: 'Upstream provider request failed',
      },
    },
    { status: 502 },
  );
}

async function inspectFirstStreamChunk(plugins: Settings['providers'][string]['plugins'], stream: AsyncIterable<unknown>) {
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    return { stream: replayStream(undefined, iterator, plugins) };
  }

  for (const plugin of plugins) {
    if (plugin.name !== 'vendor_sse_error') {
      continue;
    }
    const result = inspectVendorSseError(plugin.config, first.value);
    if (result) {
      return { error: result, stream: replayStream(undefined, iterator, plugins) };
    }
  }

  return { stream: replayStream(first.value, iterator, plugins) };
}

async function* replayStream(first: unknown, iterator: AsyncIterator<unknown>, plugins: Settings['providers'][string]['plugins'] = []): AsyncIterable<unknown> {
  if (first !== undefined) {
    yield first;
  }
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return;
    }
    const error = inspectStreamChunk(plugins, next.value);
    if (error) {
      yield { type: 'openai-error', body: error.body };
      return;
    }
    yield next.value;
  }
}

function inspectStreamChunk(plugins: Settings['providers'][string]['plugins'], chunk: unknown) {
  for (const plugin of plugins) {
    if (plugin.name !== 'vendor_sse_error') {
      continue;
    }
    const result = inspectVendorSseError(plugin.config, chunk);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function readableStreamFromAsyncIterable(iterable: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
  });
}
