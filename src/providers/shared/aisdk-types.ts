import type { ToolSet } from 'ai'

export interface AISDKInput {
  system?: string
  messages: Array<Record<string, unknown>>
  temperature?: number
  topP?: number
  presencePenalty?: number
  frequencyPenalty?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  tools?: ToolSet
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string }
  providerOptions?: Record<string, Record<string, unknown>>
}
