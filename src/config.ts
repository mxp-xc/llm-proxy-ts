import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { z } from 'zod/v3'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { isRecord } from './providers/protocol-types.js'

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
      ? { name: v, config: {} as Record<string, unknown>, providers: [] }
      : v,
  )
  .refine((v) => v.name || v.module, { message: 'Plugin must have name or module' })

// ─── Schemas ─────────────────────────────────────────────────────

const apiKeySchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).nonempty()])
  .nullable()
  .optional()

/** 模型 token 限制 */
export const modelLimitSchema = z.object({
  /** 总上下文窗口长度（含输入+输出） */
  context: z.number().int().positive().optional(),
  /** 输入 token 上限（无上游标准字段，需手动配置） */
  input: z.number().int().positive().optional(),
  /** 输出 token 上限 */
  output: z.number().int().positive().optional(),
})

// ─── codex schemas ────────────────────────────────────────────────

const codexReasoningLevelSchema = z
  .object({
    effort: z.string(),
    description: z.string().optional(),
  })
  .passthrough()

const codexModelMessagesSchema = z
  .object({
    instructions_template: z.string(),
    instructions_variables: z
      .object({
        personality_default: z.string(),
        personality_friendly: z.string().optional(),
        personality_pragmatic: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough()

const codexTruncationPolicySchema = z
  .object({
    mode: z.string(),
    limit: z.number(),
  })
  .passthrough()

/** codex bundled catalog 条目（解析 codex 输出，宽松 passthrough 容忍 codex 新增字段） */
export const codexModelInfoSchema = z
  .object({
    slug: z.string(),
    display_name: z.string(),
    description: z.string().nullable().optional(),
    default_reasoning_level: z.string().nullable().optional(),
    supported_reasoning_levels: z.array(codexReasoningLevelSchema),
    shell_type: z.string(),
    visibility: z.string(),
    supported_in_api: z.boolean(),
    priority: z.number(),
    additional_speed_tiers: z.array(z.string()).optional(),
    service_tiers: z.array(z.record(z.string(), z.unknown())).optional(),
    default_service_tier: z.string().nullable().optional(),
    availability_nux: z.record(z.string(), z.unknown()).nullable().optional(),
    upgrade: z.record(z.string(), z.unknown()).nullable().optional(),
    base_instructions: z.string(),
    model_messages: codexModelMessagesSchema.nullable().optional(),
    supports_reasoning_summaries: z.boolean(),
    default_reasoning_summary: z.string().optional(),
    support_verbosity: z.boolean(),
    default_verbosity: z.string().nullable().optional(),
    apply_patch_tool_type: z.string().nullable().optional(),
    web_search_tool_type: z.string().optional(),
    truncation_policy: codexTruncationPolicySchema,
    supports_parallel_tool_calls: z.boolean(),
    supports_image_detail_original: z.boolean().optional(),
    context_window: z.number().nullable().optional(),
    max_context_window: z.number().nullable().optional(),
    auto_compact_token_limit: z.number().nullable().optional(),
    comp_hash: z.string().nullable().optional(),
    effective_context_window_percent: z.number().optional(),
    experimental_supported_tools: z.array(z.record(z.string(), z.unknown())),
    input_modalities: z.array(z.string()).optional(),
    supports_search_tool: z.boolean().optional(),
    use_responses_lite: z.boolean().optional(),
    auto_review_model_override: z.string().nullable().optional(),
    tool_mode: z.string().nullable().optional(),
    multi_agent_version: z.string().nullable().optional(),
  })
  .passthrough()

export type CodexModelInfo = z.infer<typeof codexModelInfoSchema>

/** 4 层覆盖用：templateSlug + 所有 ModelInfo 字段（除 slug），全可选 */
export const codexModelOverrideSchema = codexModelInfoSchema
  .omit({ slug: true })
  .partial()
  .extend({ templateSlug: z.string().min(1).optional() })
  .strip()

export type CodexModelOverride = z.infer<typeof codexModelOverrideSchema>

/** settings.codex 专属：在 codexModelOverrideSchema 基础上给 templateSlug / context_window 加默认值 */
export const codexSettingsSchema = codexModelOverrideSchema
  .extend({
    templateSlug: z.string().min(1).default('gpt-5.4'),
    context_window: z.number().int().positive().default(200000),
  })
  .strip()

export type CodexSettings = z.infer<typeof codexSettingsSchema>

export const modelRouteConfigSchema = z.object({
  upstreamModel: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional().default([]),
  headers: z.record(z.string(), z.string()).optional().default({}),
  plugins: z.array(pluginEntrySchema).optional().default([]),
  limit: modelLimitSchema.optional(),
  codex: codexModelOverrideSchema.optional(),
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

// 所有 provider 类型共享的行为控制选项
const commonProviderOptionsSchema = z.object({
  streamOnly: z.boolean().optional(),
  enableFlatModelLookup: z.boolean().optional(),
  codex: codexModelOverrideSchema.optional(),
})

// openai-compatible 特定选项
const openaiCompatibleOptionsSchema = commonProviderOptionsSchema
  .extend({
    modelsEndpoint: z.string().min(1).optional(),
    includeUsage: z.boolean().optional(),
  })
  .strict()

// anthropic 特定选项
const anthropicOptionsSchema = commonProviderOptionsSchema
  .extend({
    anthropicVersion: z.string().min(1).optional(),
  })
  .strict()

// openai 特定选项
const openaiOptionsSchema = commonProviderOptionsSchema
  .extend({
    organization: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
  })
  .strict()

const baseProviderFields = {
  apiKey: apiKeySchema,
  headers: z.record(z.string(), z.string()).default({}),
  plugins: z.array(pluginEntrySchema).default([]),
  models: z.record(z.string(), modelRouteConfigSchema).default({}),
  oauth: oauthConfigSchema.optional(),
}

const openAICompatibleProviderSchema = z.object({
  type: z.literal('openai-compatible'),
  baseURL: z.string().url(),
  ...baseProviderFields,
  options: openaiCompatibleOptionsSchema.optional(),
})

const anthropicProviderSchema = z.object({
  type: z.literal('anthropic'),
  baseURL: z.string().url().optional(),
  ...baseProviderFields,
  options: anthropicOptionsSchema.optional(),
})

const openaiProviderSchema = z.object({
  type: z.literal('openai'),
  baseURL: z.string().url().optional(),
  ...baseProviderFields,
  options: openaiOptionsSchema.optional(),
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
  codex: codexSettingsSchema.default({}),
  providers: z.record(z.string(), providerConfigSchema).default({}),
})

export type PluginEntry = z.infer<typeof pluginEntrySchema>
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

/** 已从 provider 顶层迁移到 `options` 内的字段名 */
const MIGRATED_PROVIDER_FIELDS = new Set([
  'enableFlatModelLookup',
  'modelsEndpoint',
  'includeUsage',
  'anthropicVersion',
  'organization',
  'project',
])

/**
 * 检测旧版配置格式：provider 顶层存在已迁移到 `options` 的字段。
 * 必须在 Zod 解析之前运行，因为 Zod 默认 strip 模式会静默丢弃这些字段。
 */
function checkMigratedTopLevelFields(parsed: unknown): void {
  if (!isRecord(parsed)) return
  const providers = parsed['providers']
  if (!isRecord(providers)) return
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!isRecord(provider)) continue
    for (const key of Object.keys(provider)) {
      if (MIGRATED_PROVIDER_FIELDS.has(key)) {
        throw new Error(
          `Provider "${providerName}": "${key}" has been migrated to provider.options. ` +
          `Move \`${key}: ${String(provider[key])}\` to \`options: { ${key}: ... }\`. ` +
          `See docs/migration.md for details.`,
        )
      }
    }
  }
}

export function parseAndValidateSettings(raw: string): Settings {
  const errors: ParseError[] = []
  const parsed = parse(raw, errors, { allowTrailingComma: true })

  if (errors.length > 0) {
    throw new Error(`Failed to parse JSONC settings: ${errors[0]?.error}`)
  }

  const resolved = resolveEnvPlaceholders(parsed)
  checkMigratedTopLevelFields(resolved)

  return settingsSchema.parse(resolved)
}

export async function loadSettingsFromFile(path: string): Promise<Settings> {
  const raw = await readFile(path, 'utf8')
  return parseAndValidateSettings(raw)
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
