/** 模型 token 限制 */
export interface ModelLimit {
  /** 总上下文窗口长度（含输入+输出）。来自上游 context_length 等字段 */
  context?: number | undefined
  /** 输入 token 上限。无上游标准字段，需手动配置 */
  input?: number | undefined
  /** 输出 token 上限。来自上游 max_output_tokens 等字段 */
  output?: number | undefined
}

export interface OpenAIModel {
  id: string
  object: string
  created?: number
  owned_by?: string
  limit?: ModelLimit
}

export interface OpenAIModelList {
  object: 'list'
  data: OpenAIModel[]
}
