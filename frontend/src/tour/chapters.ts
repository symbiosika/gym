import type { RouteLocationRaw } from 'vue-router'
import type { BlockStep, TourMaterial } from '@/types/gym'

/**
 * The chapters of the guided tour as data: which screen each step opens,
 * which element it points at (`data-tour="…"`), and which part of the tour
 * material it needs. The texts are in the locales under
 * `tour.steps.<chapter>.<step>`. The runner (runner.ts) only reads this.
 *
 * The tour is read-only: a step names a page to open and, at most, UI state
 * to show (the spec manager). It never names an action that writes.
 */
export const TOUR_CHAPTERS = ['skill', 'recording', 'specs', 'pretrain', 'evaluation', 'analysis'] as const
export type TourChapterId = (typeof TOUR_CHAPTERS)[number]

/** What a step may need of the material, besides the skill every step needs. */
export type TourNeed =
  | 'criticSpecName'
  | 'specStored'
  | 'recordingBlockId'
  | 'datasetId'
  | 'exportId'
  | 'policyId'
  | 'evaluationBlockId'
  | 'reportId'

/** The page a step opens. A block page opens the step to look at, read-only. */
export type TourPage =
  | { name: 'Skill'; tab: 'blocks' | 'strategy' | 'pretrain' | 'policies' | 'evaluations' | 'audit' }
  | { name: 'Block'; block: 'recording' | 'evaluation'; step?: BlockStep }
  | { name: 'SpecWizard' }
  | { name: 'StartBlock' }
  | { name: 'EvaluationReport' }
  | { name: 'Analysis' }

/** UI state a step shows on top of its page: the spec manager, on its form or its YAML. */
export interface TourUi {
  specManager?: 'form' | 'yaml'
}

export interface TourStep {
  id: string
  /**
   * the `data-tour` name of the element the step points at; none for the
   * opening step of a chapter, which says what the activity is for, in the
   * middle of the page
   */
  element?: string
  page: TourPage
  needs?: TourNeed[]
  ui?: TourUi
  /** another chapter this step points on to, offered as a link in its text */
  link?: TourChapterId
}

const skill = (tab: Extract<TourPage, { name: 'Skill' }>['tab']): TourPage => ({ name: 'Skill', tab })
const recordingBlock = (step?: BlockStep): TourPage => ({ name: 'Block', block: 'recording', step })
const evaluationBlock = (step?: BlockStep): TourPage => ({ name: 'Block', block: 'evaluation', step })

export const CHAPTER_STEPS: Record<TourChapterId, TourStep[]> = {
  skill: [
    { id: 'goal', page: skill('blocks') },
    { id: 'create', element: 'start-skill', page: { name: 'StartBlock' } },
    { id: 'header', element: 'skill-header', page: skill('blocks') },
    { id: 'kpis', element: 'skill-kpis', page: skill('blocks') },
    { id: 'tabs', element: 'skill-tabs', page: skill('blocks') },
    { id: 'spec', element: 'skill-spec', page: skill('blocks'), link: 'specs' },
  ],
  specs: [
    { id: 'goal', page: skill('blocks') },
    { id: 'skillSpec', element: 'skill-spec', page: skill('blocks') },
    { id: 'list', element: 'spec-list', page: skill('blocks'), needs: ['specStored'], ui: { specManager: 'form' } },
    { id: 'purpose', element: 'spec-purpose', page: skill('blocks'), needs: ['specStored'], ui: { specManager: 'form' } },
    { id: 'task', element: 'spec-task', page: skill('blocks'), needs: ['specStored'], ui: { specManager: 'form' } },
    { id: 'indicators', element: 'spec-indicators', page: skill('blocks'), needs: ['specStored'], ui: { specManager: 'form' } },
    { id: 'hard', element: 'spec-hard', page: skill('blocks'), needs: ['specStored'], ui: { specManager: 'form' } },
    { id: 'scoring', element: 'spec-scoring', page: skill('blocks'), needs: ['specStored'], ui: { specManager: 'form' } },
    { id: 'yaml', element: 'spec-yaml', page: skill('blocks'), needs: ['specStored'], ui: { specManager: 'yaml' } },
    { id: 'prompts', element: 'upload-prompts', page: recordingBlock('upload'), needs: ['recordingBlockId', 'datasetId'] },
    { id: 'wizardNew', element: 'specwizard-new', page: { name: 'SpecWizard' } },
    { id: 'wizardSteps', element: 'specwizard-steps', page: { name: 'SpecWizard' } },
    { id: 'wizardOpen', element: 'specwizard-open', page: { name: 'SpecWizard' } },
  ],
  recording: [
    { id: 'goal', page: skill('strategy') },
    { id: 'runSheet', element: 'strategy-runsheet', page: skill('strategy') },
    { id: 'blocks', element: 'skill-blocks', page: skill('blocks'), needs: ['recordingBlockId'] },
    { id: 'wizard', element: 'wizard-steps', page: recordingBlock(), needs: ['recordingBlockId'] },
    { id: 'brief', element: 'wizard-brief', page: recordingBlock('brief'), needs: ['recordingBlockId'] },
    { id: 'plan', element: 'wizard-plan', page: recordingBlock('plan'), needs: ['recordingBlockId'] },
    { id: 'recording', element: 'wizard-recording', page: recordingBlock('recording'), needs: ['recordingBlockId'] },
    { id: 'upload', element: 'wizard-upload', page: recordingBlock('upload'), needs: ['recordingBlockId'] },
    { id: 'summary', element: 'review-summary', page: recordingBlock('review'), needs: ['datasetId'], link: 'specs' },
    { id: 'dataset', element: 'review-dataset', page: recordingBlock('review'), needs: ['datasetId'] },
    { id: 'report', element: 'review-report', page: recordingBlock('review'), needs: ['datasetId'] },
    { id: 'selection', element: 'selection-table', page: recordingBlock('selection'), needs: ['datasetId'] },
    { id: 'override', element: 'selection-override', page: recordingBlock('selection'), needs: ['datasetId'] },
    { id: 'export', element: 'selection-export', page: recordingBlock('selection'), needs: ['datasetId'] },
  ],
  pretrain: [
    { id: 'goal', page: skill('pretrain'), needs: ['datasetId'] },
    { id: 'table', element: 'pretrain-table', page: skill('pretrain'), needs: ['datasetId'] },
    { id: 'included', element: 'pretrain-included', page: skill('pretrain'), needs: ['datasetId'] },
    { id: 'review', element: 'pretrain-review', page: skill('pretrain'), needs: ['datasetId'] },
    { id: 'shortcuts', element: 'pretrain-shortcuts', page: skill('pretrain'), needs: ['datasetId'] },
    { id: 'positions', element: 'pretrain-positions', page: skill('pretrain'), needs: ['datasetId'] },
    { id: 'export', element: 'pretrain-export', page: skill('pretrain'), needs: ['datasetId'] },
    { id: 'exports', element: 'skill-exports', page: skill('blocks'), needs: ['exportId'] },
  ],
  evaluation: [
    { id: 'goal', page: skill('policies'), needs: ['policyId'] },
    { id: 'policies', element: 'policies-table', page: skill('policies'), needs: ['policyId'] },
    { id: 'course', element: 'evaluations-course', page: skill('evaluations'), needs: ['evaluationBlockId'] },
    { id: 'tiles', element: 'rollout-tiles', page: evaluationBlock('review'), needs: ['evaluationBlockId'] },
    { id: 'table', element: 'rollout-table', page: evaluationBlock('review'), needs: ['evaluationBlockId'] },
    { id: 'report', element: 'report-sections', page: { name: 'EvaluationReport' }, needs: ['reportId'] },
  ],
  analysis: [
    { id: 'goal', page: { name: 'Analysis' } },
    { id: 'filters', element: 'analysis-filters', page: { name: 'Analysis' } },
    { id: 'totals', element: 'analysis-totals', page: { name: 'Analysis' } },
    { id: 'perDay', element: 'analysis-perday', page: { name: 'Analysis' } },
    { id: 'flags', element: 'analysis-flags', page: { name: 'Analysis' } },
  ],
}

/** Does the material have what the step needs? Without a tour skill nothing is shown. */
export function stepPossible(step: TourStep, m: TourMaterial): boolean {
  if (!m.skill) return false
  return (step.needs ?? []).every((need) => (need === 'criticSpecName' ? !!m.skill?.criticSpecName : !!m[need]))
}

/** A chapter is offered when at least one of its steps that points at something is possible. */
export const chapterAvailable = (chapter: TourChapterId, m: TourMaterial): boolean =>
  CHAPTER_STEPS[chapter].some((step) => !!step.element && stepPossible(step, m))

/** The steps of the chapters, in order, that the material allows; a chapter with nothing to show is left out whole. */
export function tourSteps(chapters: readonly TourChapterId[], m: TourMaterial): { chapter: TourChapterId; step: TourStep }[] {
  return chapters
    .filter((chapter) => chapterAvailable(chapter, m))
    .flatMap((chapter) => CHAPTER_STEPS[chapter].filter((step) => stepPossible(step, m)).map((step) => ({ chapter, step })))
}

/** The route of a step's page, built from the material; null when the material lacks what the page needs. */
export function routeOf(page: TourPage, m: TourMaterial, tenantId: string): RouteLocationRaw | null {
  if (!m.skill) return null
  switch (page.name) {
    case 'Skill':
      return { name: 'Skill', params: { tenantId, skillId: m.skill.id }, query: { tab: page.tab } }
    case 'Block': {
      const blockId = page.block === 'recording' ? m.recordingBlockId : m.evaluationBlockId
      if (!blockId) return null
      return { name: 'Block', params: { tenantId, blockId }, query: page.step ? { step: page.step } : {} }
    }
    case 'SpecWizard':
      return { name: 'SpecWizard', params: { tenantId } }
    case 'StartBlock':
      return { name: 'StartBlock', params: { tenantId } }
    case 'EvaluationReport':
      return m.reportId ? { name: 'EvaluationReport', params: { tenantId, reportId: m.reportId } } : null
    case 'Analysis':
      return { name: 'Analysis', params: { tenantId }, query: { skillId: m.skill.id } }
  }
}

/** Every `data-tour` name the chapters point at, for the test that each one exists. */
export const tourElements = (): string[] => [
  ...new Set(Object.values(CHAPTER_STEPS).flatMap((steps) => steps.flatMap((s) => (s.element ? [s.element] : [])))),
]
