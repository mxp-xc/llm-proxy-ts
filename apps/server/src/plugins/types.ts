import type { PluginConfig, Settings } from '@llm-proxy/core';

export interface PluginContext {
  requestId: string;
  settings: Settings;
  route?: unknown;
  request?: unknown;
}

export interface PluginResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ProviderCallPatch {
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
}

export interface ProviderResultPatch {
  body?: unknown;
}

export interface ProxyPlugin {
  name: string;
  beforeRequest?(ctx: PluginContext): Promise<void | PluginResponse>;
  beforeProviderCall?(ctx: PluginContext): Promise<void | ProviderCallPatch>;
  afterProviderResult?(ctx: PluginContext): Promise<void | ProviderResultPatch>;
  inspectStreamChunk?(ctx: PluginContext & { chunk: unknown }): Promise<void | PluginResponse>;
  mapProviderError?(ctx: PluginContext & { error: unknown }): Promise<void | PluginResponse>;
}

export type ResolvedPluginConfig = PluginConfig;
