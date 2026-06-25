import { z } from 'zod/v3'

// ─── codex schemas ────────────────────────────────────────────────
// 描述 codex CLI 的外部 bundled catalog 输出，与本项目的 Settings 验证是不同关注点。
// 本模块为叶子模块，仅依赖 zod/v3，不 import config.js（避免与 config.ts 循环依赖）。

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
  .extend({
    templateSlug: z.string().min(1).optional(),
    context_window: z.number().int().positive().nullable().optional(),
  })
  .strip()

export type CodexModelOverride = z.infer<typeof codexModelOverrideSchema>

/** settings.codex 专属：在 codexModelOverrideSchema 基础上给 templateSlug / context_window 加默认值 */
export const codexSettingsSchema = codexModelOverrideSchema
  .extend({
    templateSlug: z.string().min(1).optional(),
    context_window: z.number().int().positive().default(200000),
  })
  .strip()

export type CodexSettings = z.infer<typeof codexSettingsSchema>
