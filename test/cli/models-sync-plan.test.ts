import { describe, expect, it } from 'vitest'
import { getInitialModelSelections, planModelSyncChanges } from '../../src/cli/models/sync-plan.js'

describe('planModelSyncChanges', () => {
  it('keeps existing model keys when upstream ids are selected', () => {
    const plan = planModelSyncChanges({
      existingModels: {
        friendly: { upstreamModel: 'provider/model-a', aliases: [], headers: {}, plugins: [] },
      },
      discoveredModels: [{ id: 'provider/model-a' }],
      selectedIds: ['provider/model-a'],
    })

    expect(plan).toEqual({
      newModels: {
        friendly: { upstreamModel: 'provider/model-a', aliases: [], headers: {}, plugins: [] },
      },
      added: 0,
      kept: 1,
      removed: 0,
    })
  })

  it('adds discovered limits to new model entries', () => {
    const plan = planModelSyncChanges({
      existingModels: {},
      discoveredModels: [{ id: 'provider/model-b', limit: { context: 128000, output: 8192 } }],
      selectedIds: ['provider/model-b'],
    })

    expect(plan.newModels['provider/model-b']).toEqual({
      upstreamModel: 'provider/model-b',
      limit: { context: 128000, output: 8192 },
    })
    expect(plan.added).toBe(1)
  })

  it('counts removed existing models when they are not selected', () => {
    const plan = planModelSyncChanges({
      existingModels: {
        old: { upstreamModel: 'provider/old', aliases: [], headers: {}, plugins: [] },
        kept: { upstreamModel: 'provider/kept', aliases: [], headers: {}, plugins: [] },
      },
      discoveredModels: [{ id: 'provider/kept' }],
      selectedIds: ['provider/kept'],
    })

    expect(plan.kept).toBe(1)
    expect(plan.removed).toBe(1)
    expect(plan.newModels).not.toHaveProperty('old')
  })

  it('deduplicates selected upstream ids', () => {
    const plan = planModelSyncChanges({
      existingModels: {},
      discoveredModels: [{ id: 'provider/model' }],
      selectedIds: ['provider/model', 'provider/model'],
    })

    expect(plan.added).toBe(1)
    expect(Object.keys(plan.newModels)).toEqual(['provider/model'])
  })

  it('derives initial selections from existing models that still exist upstream', () => {
    expect(
      getInitialModelSelections({
        existingModels: {
          keep: { upstreamModel: 'provider/keep', aliases: [], headers: {}, plugins: [] },
          missing: { upstreamModel: 'provider/missing', aliases: [], headers: {}, plugins: [] },
        },
        discoveredModels: [{ id: 'provider/keep' }],
      }),
    ).toEqual(['provider/keep'])
  })

  it('deduplicates initial selections with the same upstream model', () => {
    expect(
      getInitialModelSelections({
        existingModels: {
          first: { upstreamModel: 'provider/shared', aliases: [], headers: {}, plugins: [] },
          second: { upstreamModel: 'provider/shared', aliases: [], headers: {}, plugins: [] },
        },
        discoveredModels: [{ id: 'provider/shared' }],
      }),
    ).toEqual(['provider/shared'])
  })
})
