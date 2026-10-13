import type { PlanStep, PlanVariation, RecordingPlan, RecordingProgress } from '@/types/gym'

/** Episodes over all steps of a plan. */
export const planTotal = (plan: RecordingPlan | null | undefined): number =>
  plan?.steps.reduce((a, s) => a + s.variations.reduce((b, v) => b + v.episodes, 0), 0) ?? 0

/** One variation of a plan with the identity the image endpoints use: its step and its index in it. */
export interface FlatVariation {
  stepIndex: number
  variationIndex: number
  stepId: string
  variation: PlanVariation
}

/** All variations of a plan, in the order the operator works them. */
export const planVariations = (plan: RecordingPlan | null | undefined): FlatVariation[] =>
  plan?.steps.flatMap((s, stepIndex) =>
    s.variations.map((variation, variationIndex) => ({ stepIndex, variationIndex, stepId: s.id, variation })),
  ) ?? []

/** How many variations already carry a reference image. */
export const variationsWithImage = (plan: RecordingPlan | null | undefined): number =>
  planVariations(plan).filter((x) => x.variation.image).length

/**
 * A copy of a step, placed right after the original: same title, instructions,
 * variations and reference images, its own id. Ids that start with `local-`
 * are the editor's; the server gives the step its real id on save.
 */
export function duplicateStep(plan: RecordingPlan, index: number, id: string): PlanStep | null {
  const step = plan.steps[index]
  if (!step) return null
  const copy: PlanStep = {
    ...step,
    id,
    variations: step.variations.map((v) => ({ ...v, image: v.image ? { ...v.image } : v.image })),
  }
  plan.steps.splice(index + 1, 0, copy)
  return copy
}

/** Episodes counted so far. */
export const progressTotal = (progress: RecordingProgress | null | undefined): number =>
  Object.values(progress?.completed ?? {}).reduce((a, b) => a + b, 0)

/** Completed episodes of one step. */
export const stepDone = (progress: RecordingProgress | null | undefined, step: PlanStep): number =>
  Math.min(step.episodes, progress?.completed[step.id] ?? 0)

/**
 * Scale the episode counts of all variations so the plan hits the target:
 * proportional, at least one episode per variation, the rounding remainder on
 * the variations that lost the most. Mirrors the backend's rebalance, but here
 * the operator asks for it (backend/src/lib/ai/plan.ts).
 */
export function rebalanceToTarget(plan: RecordingPlan, target: number): void {
  const all = planVariations(plan).map((x) => x.variation)
  if (!all.length || target <= 0) return
  const sum = all.reduce((a, v) => a + Math.max(0, v.episodes), 0)
  const shares = all.map((v) => (sum > 0 ? (Math.max(0, v.episodes) * target) / sum : target / all.length))
  const counts = shares.map((x) => Math.max(1, Math.floor(x)))
  let rest = target - counts.reduce((a, b) => a + b, 0)
  const byRemainder = shares
    .map((x, i) => [x - Math.floor(x), i] as const)
    .sort((a, b) => b[0] - a[0])
    .map(([, i]) => i)
  for (let k = 0; rest > 0; k++, rest--) counts[byRemainder[k % counts.length]!]!++
  while (rest < 0) {
    const i = counts.indexOf(Math.max(...counts))
    if (counts[i]! <= 1) break
    counts[i]!--
    rest++
  }
  all.forEach((v, i) => (v.episodes = counts[i]!))
  for (const s of plan.steps) s.episodes = s.variations.reduce((a, v) => a + v.episodes, 0)
}

/** 0..100, capped. */
export const percentDone = (done: number, total: number): number =>
  total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

/**
 * The variation the operator should be on inside a step, given how many
 * episodes of the step are done: variations are worked in order.
 */
export function currentVariation(step: PlanStep, done: number): { index: number; doneInVariation: number } {
  let rest = done
  for (let i = 0; i < step.variations.length; i++) {
    const n = step.variations[i]!.episodes
    if (rest < n) return { index: i, doneInVariation: rest }
    rest -= n
  }
  return {
    index: Math.max(0, step.variations.length - 1),
    doneInVariation: step.variations[step.variations.length - 1]?.episodes ?? 0,
  }
}

/** The step to work on: the plan's current step, else the first unfinished one. */
export function activeStep(plan: RecordingPlan, progress: RecordingProgress | null | undefined): PlanStep | null {
  const current = plan.steps.find((s) => s.id === progress?.currentStepId)
  if (current && stepDone(progress, current) < current.episodes) return current
  return plan.steps.find((s) => stepDone(progress, s) < s.episodes) ?? null
}
