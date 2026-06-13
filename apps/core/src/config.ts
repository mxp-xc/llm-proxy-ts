import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { z } from 'zod/v3'
import { zodToJsonSchema } from 'zod-to-json-schema'

// ─── Plugin entry schema ────────────────────────────────────────

/** 单个插件条目的完整结构（transform 后） */
const pluginEntryObjectSchema = z.object({
  name: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  /** 仅全局级：关联的 provider 列表 */
  providers: z
    .union([z.string().min(1), z.array(z.string().min(1))])
    .optional()
    .transform((v) => (typeof v === 'string' ? [v] : (v ?? []))),
})

export const pluginEntrySchema = z
  .union([z.string().min(1), pluginEntryObjectSchema])
  .transform((v) =>
    typeof v === 'string'
      ? { name: v, config: {} as Record<string, unknown>, providers: [] as string[] }
      : v,
  )
  .refine((v) => v.name || v.module, { message: 'Plugin must have name or module' })

/** @deprecated 使用 pluginEntrySchema */
export const pluginConfigSchema = pluginEntrySchema

// ─── Schemas ─────────────────────────────────────────────────────

const apiKeySchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).nonempty()])
  .nullable()
  .optional()

export const modelRouteConfigSchema = z.object({
  upstreamModel: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional().default([]),
  headers: z.record(z.string(), z.string()).optional().default({}),
  plugins: z.array(pluginEntrySchema).optional().default([]),
})

export const oauthConfigSchema = z.object({
  flow: z.enum(['authorization_code', 'client_credentials']),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  tokenUrl: z.string().url(),
  authorizationUrl: z.string().url().optional(),
  scopes: z.array(z.string().min(1)).default([]),
  redirectUri: z.string().url().optional(),
  authFile: z.string().optional(),
})

const openAICompatibleProviderSchema = z.object({
  type: z.literal('openai-compatible'),
  baseURL: z.string().url(),
  apiKey: apiKeySchema,
  headers: z.record(z.string(), z.string()).default({}),
  plugins: z.array(pluginEntrySchema).default([]),
  models: z.record(z.string(), modelRouteConfigSchema).default({}),
  enableFlatModelLookup: z.boolean().optional(),
  oauth: oauthConfigSchema.optional(),
  modelsEndpoint: z.string().min(1).optional(),
})

const anthropicProviderSchema = z.object({
  type: z.literal('anthropic'),
  baseURL: z.string().url().optional(),
  apiKey: apiKeySchema,
  headers: z.record(z.string(), z.string()).default({}),
  plugins: z.array(pluginEntrySchema).default([]),
  models: z.record(z.string(), modelRouteConfigSchema).default({}),
  enableFlatModelLookup: z.boolean().optional(),
  oauth: oauthConfigSchema.optional(),
  anthropicVersion: z.string().min(1).optional(),
})

const openaiProviderSchema = z.object({
  type: z.literal('openai'),
  baseURL: z.string().url().optional(),
  apiKey: apiKeySchema,
  headers: z.record(z.string(), z.string()).default({}),
  plugins: z.array(pluginEntrySchema).default([]),
  models: z.record(z.string(), modelRouteConfigSchema).default({}),
  enableFlatModelLookup: z.boolean().optional(),
  oauth: oauthConfigSchema.optional(),
  organization: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
})

export const providerConfigSchema = z.discriminatedUnion('type', [
  openAICompatibleProviderSchema,
  anthropicProviderSchema,
  openaiProviderSchema,
])

export const settingsSchema = z.object({
  $schema: z.string().optional(),
  service: z
    .object({
      name: z.string().min(1).default('llm-proxy'),
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(8000),
    })
    .default({}),
  requestTimeoutMs: z.number().positive().default(30000),
  proxy: z
    .object({
      url: z.string().url(),
      verify: z.boolean().default(true),
    })
    .nullable()
    .default(null),
  routing: z
    .object({
      enableFlatModelLookup: z.boolean().default(false),
    })
    .default({}),
  plugins: z.array(pluginEntrySchema).default([]),
  providers: z.record(z.string(), providerConfigSchema).default({}),
})

export type PluginEntry = z.infer<typeof pluginEntrySchema>
/** @deprecated 使用 PluginEntry */
export type PluginConfig = PluginEntry
export type ModelRouteConfig = z.infer<typeof modelRouteConfigSchema>
/** 写入配置文件时使用的输入类型，aliases/headers/plugins 可省略（Zod default 填充）。 */
export type ModelRouteInput = z.input<typeof modelRouteConfigSchema>
export type OAuthConfig = z.infer<typeof oauthConfigSchema>
export type OpenAICompatibleProviderConfig = z.infer<typeof openAICompatibleProviderSchema>
export type AnthropicProviderConfig = z.infer<typeof anthropicProviderSchema>
export type OpenAIProviderConfig = z.infer<typeof openaiProviderSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type Settings = z.infer<typeof settingsSchema>

const envPlaceholderPattern = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

export function resolveEnvPlaceholders(value: unknown): unknown {
  if (typeof value === 'string') {
    const match = envPlaceholderPattern.exec(value)
    if (!match) {
      return value
    }

    const envName = match[1]
    if (!envName) {
      return value
    }

    const envValue = process.env[envName]
    if (envValue === undefined) {
      throw new Error(`Environment variable ${envName} is required`)
    }

    return envValue
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvPlaceholders(item))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEnvPlaceholders(item)]),
    )
  }

  return value
}

export async function loadSettingsFromFile(path: string): Promise<Settings> {
  const raw = await readFile(path, 'utf8')
  const errors: ParseError[] = []
  const parsed = parse(raw, errors, { allowTrailingComma: true })

  if (errors.length > 0) {
    throw new Error(`Failed to parse JSONC settings: ${errors[0]?.error}`)
  }

  return settingsSchema.parse(resolveEnvPlaceholders(parsed))
}

export function generateSettingsJsonSchema(): object {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...zodToJsonSchema(settingsSchema, {
      name: 'Settings',
      nameStrategy: 'title',
      $refStrategy: 'none',
    }),
    title: 'Settings',
  }
}

export async function writeSettingsJsonSchema(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(generateSettingsJsonSchema(), null, 2)}\n`, 'utf8')
}
