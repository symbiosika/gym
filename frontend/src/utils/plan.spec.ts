import { describe, expect, it } from 'vitest'
import {
  activeStep,
  currentVariation,
  duplicateStep,
  percentDone,
  planTotal,
  planVariations,
  progressTotal,
  rebalanceToTarget,
  variationsWithImage,
} from './plan'
import type { RecordingPlan } from '@/types/gym'

const plan: RecordingPlan = {
  summary: '',
  sceneSetup: [],
  randomizations: [],
  source: 'manual',
  createdAt: '',
  steps: [
    {
      id: 'a',
      title: 'A',
      instructions: '',
      episodes: 5,
      variations: [
        { label: 'near', episodes: 2 },
        { label: 'far', episodes: 3 },
      ],
    },
    { id: 'b', title: 'B', instructions: '', episodes: 4, variations: [{ label: 'rot', episodes: 4 }] },
  ],
}

describe('plan helpers', () => {
  it('duplicates a step right after the original, with its own id and its own copies', () => {
    const copy: RecordingPlan = JSON.parse(JSON.stringify(plan))
    copy.steps[0]!.variations[0]!.image = { ref: 'db:f1', source: 'upload', prompt: '', createdAt: '' }
    const dup = duplicateStep(copy, 0, 'local-1')!
    expect(copy.steps.map((s) => s.id)).toEqual(['a', 'local-1', 'b'])
    expect(dup.title).toBe('A')
    expect(dup.episodes).toBe(5)
    expect(dup.variations).toEqual(copy.steps[0]!.variations)
    expect(dup.variations[0]!.image?.ref).toBe('db:f1')
    expect(planTotal(copy)).toBe(14)
    // the copy is its own: editing it leaves the original alone
    dup.variations[0]!.label = 'changed'
    dup.variations[0]!.image!.ref = 'db:other'
    expect(copy.steps[0]!.variations[0]!.label).toBe('near')
    expect(copy.steps[0]!.variations[0]!.image?.ref).toBe('db:f1')
    expect(duplicateStep(copy, 9, 'local-2')).toBeNull()
    expect(copy.steps).toHaveLength(3)
  })

  it('sums the plan and the progress', () => {
    expect(planTotal(plan)).toBe(9)
    expect(progressTotal({ completed: { a: 5, b: 1 }, currentStepId: 'b', updatedAt: '' })).toBe(6)
    expect(percentDone(6, 9)).toBe(67)
    expect(percentDone(3, 0)).toBe(0)
  })

  it('walks the variations in order', () => {
    expect(currentVariation(plan.steps[0]!, 0)).toEqual({ index: 0, doneInVariation: 0 })
    expect(currentVariation(plan.steps[0]!, 2)).toEqual({ index: 1, doneInVariation: 0 })
    expect(currentVariation(plan.steps[0]!, 4)).toEqual({ index: 1, doneInVariation: 2 })
    expect(currentVariation(plan.steps[0]!, 9).index).toBe(1)
  })

  it('flattens the variations and counts their images', () => {
    expect(planVariations(plan).map((x) => `${x.stepId}:${x.variationIndex}`)).toEqual(['a:0', 'a:1', 'b:0'])
    expect(variationsWithImage(plan)).toBe(0)
    const withImage = {
      ...plan,
      steps: [
        {
          ...plan.steps[0]!,
          variations: [
            { label: 'near', episodes: 2, image: { ref: 'db:f1', source: 'ai' as const, prompt: 'p', createdAt: '' } },
          ],
        },
      ],
    }
    expect(variationsWithImage(withImage)).toBe(1)
    expect(planVariations(null)).toEqual([])
  })

  it('distributes the episodes onto the target', () => {
    const p: RecordingPlan = JSON.parse(JSON.stringify(plan))
    rebalanceToTarget(p, 40)
    expect(planTotal(p)).toBe(40)
    expect(p.steps[0]!.episodes).toBe(p.steps[0]!.variations.reduce((a, v) => a + v.episodes, 0))
    expect(p.steps[0]!.variations[1]!.episodes).toBeGreaterThan(p.steps[0]!.variations[0]!.episodes)
    // every variation keeps at least one episode, also when the target is small
    rebalanceToTarget(p, 3)
    expect(planTotal(p)).toBe(3)
    expect(p.steps.flatMap((s) => s.variations).every((v) => v.episodes >= 1)).toBe(true)
  })

  it('finds the step to work on', () => {
    expect(activeStep(plan, null)!.id).toBe('a')
    expect(activeStep(plan, { completed: { a: 5 }, currentStepId: 'a', updatedAt: '' })!.id).toBe('b')
    expect(activeStep(plan, { completed: { a: 5, b: 4 }, currentStepId: 'b', updatedAt: '' })).toBeNull()
  })
})
