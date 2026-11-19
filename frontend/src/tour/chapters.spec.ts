import { describe, expect, it } from 'vitest'
import de from '@/locales/de.json'
import en from '@/locales/en.json'
import type { TourMaterial } from '@/types/gym'
import { CHAPTER_STEPS, chapterAvailable, routeOf, TOUR_CHAPTERS, tourElements, tourSteps } from './chapters'

/** every component and view, as source text: where the `data-tour` names live */
const sources = Object.entries(
  import.meta.glob(['/src/**/*.vue'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>,
)

const full: TourMaterial = {
  skill: { id: 's1', name: 'Cup to tray', criticSpecName: 'cup_tray', status: 'active' },
  recordingBlockId: 'b1',
  datasetId: 'd1',
  exportId: 'x1',
  policyId: 'p1',
  evaluationBlockId: 'b2',
  reportId: 'r1',
  specStored: true,
}
const bare: TourMaterial = {
  ...full,
  recordingBlockId: null,
  datasetId: null,
  exportId: null,
  policyId: null,
  evaluationBlockId: null,
  reportId: null,
  specStored: false,
}

describe('the elements the tour points at', () => {
  it.each(tourElements())('"%s" is marked on exactly one element in the sources', (name) => {
    const marked = new RegExp(`data-tour="${name}"|:data-tour="[^"]*'${name}'`, 'g')
    const hits = sources.flatMap(([file, text]) => (text.match(marked) ?? []).map(() => file))
    expect(hits).toHaveLength(1)
  })
})

describe('the texts of the tour', () => {
  const at = (root: unknown, path: string) =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], root)
  it('every chapter and step has its title and text in German and English', () => {
    for (const locale of [de, en]) {
      for (const chapter of TOUR_CHAPTERS) {
        expect(at(locale, `tour.chapters.${chapter}.title`), chapter).toBeTypeOf('string')
        expect(at(locale, `tour.chapters.${chapter}.lead`), chapter).toBeTypeOf('string')
        for (const step of CHAPTER_STEPS[chapter]) {
          expect(at(locale, `tour.steps.${chapter}.${step.id}.title`), `${chapter}.${step.id}`).toBeTypeOf('string')
          expect(at(locale, `tour.steps.${chapter}.${step.id}.text`), `${chapter}.${step.id}`).toBeTypeOf('string')
        }
      }
    }
  })
  it('no dash a style rule forbids', () => {
    expect(JSON.stringify(de.tour) + JSON.stringify(en.tour)).not.toMatch(/[–—]/)
  })
})

describe('the steps the material allows', () => {
  it('with everything, every step of every chapter', () => {
    const all = tourSteps(TOUR_CHAPTERS, full)
    expect(all).toHaveLength(Object.values(CHAPTER_STEPS).flat().length)
    expect(TOUR_CHAPTERS.every((c) => chapterAvailable(c, full))).toBe(true)
  })

  it('a skill without data keeps the steps that need nothing, and says which chapters have nothing', () => {
    expect(tourSteps(['skill'], bare)).toHaveLength(CHAPTER_STEPS.skill.length)
    // the spec manager needs a stored spec; the wizard's start page needs nothing
    expect(tourSteps(['specs'], bare).map((s) => s.step.id)).toEqual([
      'goal',
      'skillSpec',
      'wizardNew',
      'wizardSteps',
      'wizardOpen',
    ])
    expect(chapterAvailable('pretrain', bare)).toBe(false)
    expect(chapterAvailable('evaluation', bare)).toBe(false)
    expect(chapterAvailable('analysis', bare)).toBe(true)
  })

  it('without a tour skill there is nothing at all', () => {
    const none = { ...full, skill: null }
    expect(tourSteps(TOUR_CHAPTERS, none)).toEqual([])
    expect(TOUR_CHAPTERS.some((c) => chapterAvailable(c, none))).toBe(false)
  })

  it('no step asks for anything but a page and what to show on it', () => {
    for (const step of Object.values(CHAPTER_STEPS).flat()) {
      expect(Object.keys(step).every((k) => ['id', 'element', 'page', 'needs', 'ui', 'link'].includes(k))).toBe(true)
    }
  })
})

describe('the shape of a chapter', () => {
  it('every chapter opens with its goal, the only step that points at nothing', () => {
    for (const chapter of TOUR_CHAPTERS) {
      expect(CHAPTER_STEPS[chapter][0]).toMatchObject({ id: 'goal' })
      expect(CHAPTER_STEPS[chapter][0]!.element).toBeUndefined()
      expect(CHAPTER_STEPS[chapter].slice(1).every((s) => !!s.element)).toBe(true)
    }
  })

  it("recording comes before the critic specs, and both the skill and the critics' answer link on to the specs", () => {
    expect(TOUR_CHAPTERS.indexOf('recording')).toBeLessThan(TOUR_CHAPTERS.indexOf('specs'))
    const links = Object.values(CHAPTER_STEPS)
      .flat()
      .filter((s) => s.link)
    expect(links.map((s) => s.id).sort()).toEqual(['spec', 'summary'])
    expect(links.every((s) => TOUR_CHAPTERS.includes(s.link!))).toBe(true)
  })

  it('a chapter whose goal is all that would be left is not offered', () => {
    // the policy is there, the evaluation is not: its chapter still shows the policy
    expect(tourSteps(['evaluation'], { ...bare, policyId: 'p1' }).map((s) => s.step.id)).toEqual(['goal', 'policies'])
    expect(tourSteps(['pretrain'], bare)).toEqual([])
  })
})

describe('the page of a step', () => {
  it('opens the tab, the block step, the report and the analysis of the tour skill', () => {
    expect(routeOf({ name: 'Skill', tab: 'pretrain' }, full, 't')).toEqual({
      name: 'Skill',
      params: { tenantId: 't', skillId: 's1' },
      query: { tab: 'pretrain' },
    })
    expect(routeOf({ name: 'Block', block: 'evaluation', step: 'review' }, full, 't')).toEqual({
      name: 'Block',
      params: { tenantId: 't', blockId: 'b2' },
      query: { step: 'review' },
    })
    expect(routeOf({ name: 'Block', block: 'recording' }, full, 't')).toEqual({
      name: 'Block',
      params: { tenantId: 't', blockId: 'b1' },
      query: {},
    })
    expect(routeOf({ name: 'EvaluationReport' }, full, 't')).toEqual({
      name: 'EvaluationReport',
      params: { tenantId: 't', reportId: 'r1' },
    })
    expect(routeOf({ name: 'Analysis' }, full, 't')).toEqual({
      name: 'Analysis',
      params: { tenantId: 't' },
      query: { skillId: 's1' },
    })
  })

  it('is none when the material lacks the block or the report', () => {
    expect(routeOf({ name: 'Block', block: 'recording', step: 'review' }, bare, 't')).toBeNull()
    expect(routeOf({ name: 'EvaluationReport' }, bare, 't')).toBeNull()
  })
})
