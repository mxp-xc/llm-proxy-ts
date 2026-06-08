export interface OpenAIModel {
  id: string
  object: string
  created?: number
  owned_by?: string
}

export interface OpenAIModelList {
  object: 'list'
  data: OpenAIModel[]
}
