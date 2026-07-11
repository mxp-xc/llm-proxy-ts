import type { ModelRouteInput } from '../../config.js'
import type { DiscoveredModel } from '../../plugins/types.js'

interface ModelSyncPlanInput {
  existingModels: Record<string, ModelRouteInput>
  discoveredModels: DiscoveredModel[]
  selectedIds: string[]
}

export interface ModelSyncPlan {
  newModels: Record<string, ModelRouteInput>
  added: number
  kept: number
  removed: number
}

export function getInitialModelSelections(input: {
  existingModels: Record<string, ModelRouteInput>
  discoveredModels: DiscoveredModel[]
}): string[] {
  const discoveredIds = new Set(input.discoveredModels.map((model) => model.id))
  const initialValues = new Set<string>()
  for (const config of Object.values(input.existingModels)) {
    if (discoveredIds.has(config.upstreamModel)) {
      initialValues.add(config.upstreamModel)
    }
  }
  return [...initialValues]
}

export function planModelSyncChanges({
  existingModels,
  discoveredModels,
  selectedIds,
}: ModelSyncPlanInput): ModelSyncPlan {
  const selected = new Set(selectedIds)
  const discoveredById = new Map(discoveredModels.map((model) => [model.id, model]))
  const existingByUpstreamModel = new Map(
    Object.entries(existingModels).map(([modelKey, config]) => [config.upstreamModel, modelKey]),
  )
  const newModels: Record<string, ModelRouteInput> = {}
  let kept = 0
  let added = 0

  for (const modelId of selected) {
    const existingKey = existingByUpstreamModel.get(modelId)

    if (existingKey) {
      newModels[existingKey] = existingModels[existingKey]!
      kept++
      continue
    }

    const discovered = discoveredById.get(modelId)
    const entry: ModelRouteInput = { upstreamModel: modelId }
    if (discovered?.limit) {
      entry.limit = discovered.limit
    }
    newModels[modelId] = entry
    added++
  }

  return {
    newModels,
    added,
    kept,
    removed: Object.keys(existingModels).length - kept,
  }
}
