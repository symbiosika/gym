import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HARD_CRITICS,
  HARD_CRITIC_IDS,
  PRESET_IDS,
  defaultIndicators,
  emptySpec,
  fromSpec,
  fromYaml,
  presetSpec,
  slugOf,
  toSpec,
  toYaml,
  uniqueId,
  validateSpec,
} from './spec'

describe('spec form model', () => {
  it('reads a hand-written spec and keeps what it has no field for', () => {
    const form = fromYaml(
      [
        'name: cup',
        'version: 1',
        'task:',
        '  instruction: put the cup on the tray',
        '  per_episode: true',
        '  objects:',
        '    - name: cup',
        '      role: target_object',
        '    - name: tray',
        '      role: target_zone',
        '  expected_cycles: 2',
        'robot:',
        '  type: humanoid',
        '  active_arms: [left]',
        '  gripper:',
        '    closed_is_high: false',
        'soft_critics:',
        '  vlm:',
        '    model: gemini-3.7-flash',
        '  indicators:',
        '    - id: done',
        '      description: The cup is on the tray.',
        '      weight: 2',
        '      gate: true',
        '      gate_below: 0.4',
        'hard_critics:',
        '  - id: duration',
        '    weight: 1',
        '    params: { min_s: 3 }',
        '  - id: smoothness',
        '    weight: 0.5',
        'scoring:',
        '  accept_threshold: 0.8',
        '  ignore_flags: [TRACKERR]',
        '  z_cut: 2.5',
      ].join('\n'),
    )
    expect(form.task.instruction).toBe('put the cup on the tray')
    expect(form.task.perEpisode).toBe('always')
    expect(form.task.expectedCycles).toBe(2)
    expect(form.task.objects.map((o) => o.role)).toEqual(['target_object', 'target_zone'])
    expect(form.robot.activeArms).toEqual(['left'])
    expect(form.soft.indicators[0]).toMatchObject({ id: 'done', weight: 2, gate: true, gateBelow: 0.4 })
    // a spec that names checks runs those and only those: the others show as switched off
    expect(form.hardCritics.filter((c) => c.enabled).map((c) => c.id)).toEqual(['duration', 'smoothness'])
    expect(form.hardCritics.find((c) => c.id === 'duration')!.params).toEqual({ min_s: 3 })
    expect(form.scoring.acceptThreshold).toBe(0.8)
    expect(form.scoring.ignoreFlags).toEqual(['TRACKERR'])
    // the leftovers survive the round trip
    const back = toSpec(form, 'cup')
    expect(back.version).toBe(1)
    expect((back.robot as { gripper: object }).gripper).toEqual({ closed_is_high: false })
    expect((back.soft_critics as { vlm: object }).vlm).toEqual({ model: 'gemini-3.7-flash' })
    expect((back.scoring as { z_cut: number }).z_cut).toBe(2.5)
    expect((back.task as { per_episode: string }).per_episode).toBe('always')
  })

  it('shows the critics defaults for a spec without checks and writes them out in full', () => {
    const form = fromSpec({ task: { instruction: 'x' } })
    expect(form.hardCritics).toHaveLength(DEFAULT_HARD_CRITICS.length)
    expect(form.hardCritics.every((c) => c.enabled)).toBe(true)
    expect(form.hardCritics.find((c) => c.id === 'tracking_error')).toMatchObject({ weight: 1.5, gate: true, gateBelow: 0.1 })
    const spec = toSpec(form, 'x')
    expect((spec.hard_critics as { id: string }[]).map((c) => c.id)).toEqual(HARD_CRITIC_IDS)
    // nothing else is written when it is at its default
    expect(Object.keys(spec).sort()).toEqual(['hard_critics', 'name', 'task'])
    expect(spec.task).toEqual({ instruction: 'x' })
  })

  it('writes a switched-off check as enabled: false and a gate with its threshold', () => {
    const form = emptySpec()
    form.task.instruction = 'x'
    const tremor = form.hardCritics.find((c) => c.id === 'tremor')!
    tremor.enabled = false
    const smooth = form.hardCritics.find((c) => c.id === 'smoothness')!
    smooth.gate = true
    smooth.gateBelow = 0.15
    const rows = toSpec(form, 'x').hard_critics as Record<string, unknown>[]
    expect(rows.find((r) => r.id === 'tremor')).toEqual({ id: 'tremor', weight: 0.5, enabled: false })
    expect(rows.find((r) => r.id === 'smoothness')).toEqual({ id: 'smoothness', weight: 1, gate: true, gate_below: 0.15 })
    expect(rows.find((r) => r.id === 'integrity')).toMatchObject({
      gate: true,
      gate_below: 0.5,
      gate_flags: ['VIDEO_MISSING', 'NAN_VALUES', 'LENGTH_MISMATCH', 'EMPTY'],
    })
  })

  it('round-trips through YAML', () => {
    const form = presetSpec('sorting')
    const again = fromYaml(toYaml(form, 'sorting'))
    expect(again).toEqual(form)
  })

  it('words the default indicators for the target object and zone', () => {
    const rows = defaultIndicators([
      { name: 'blue bottle', role: 'target_object', description: '' },
      { name: 'crate', role: 'target_zone', description: '' },
    ])
    expect(rows).toHaveLength(5)
    expect(rows[2]!.description).toContain('blue bottle rests inside/on crate')
    expect(rows[2]!.gate).toBe(true)
    expect(defaultIndicators([])[0]!.description).toContain('the target object')
  })

  it('has a valid spec behind every preset', () => {
    for (const id of PRESET_IDS) {
      const form = presetSpec(id)
      expect(validateSpec(form), id).toEqual(id === 'blank' ? ['instruction'] : [])
      if (id !== 'blank')
        expect(
          form.soft.indicators.some((i) => i.gate),
          id,
        ).toBe(true)
    }
    expect(presetSpec('repeated').task.expectedCycles).toBe(3)
    expect(presetSpec('repeated').hardCritics.find((c) => c.id === 'duration')!.params.per_cycle).toBe(true)
    expect(presetSpec('bimanual').robot.activeArms).toEqual(['left', 'right'])
    expect(presetSpec('evaluation').hardCritics.find((c) => c.id === 'smoothness')!.weight).toBe(0)
    // the critics judge the episodes as rollouts: the purpose travels with the spec
    expect(presetSpec('evaluation').rest.purpose).toBe('evaluation')
    expect(toSpec(presetSpec('evaluation'), 'ev').purpose).toBe('evaluation')
    expect(presetSpec('pick_place').rest.purpose).toBeUndefined()
  })

  it('names what keeps a spec from being saved', () => {
    const form = emptySpec()
    expect(validateSpec(form)).toEqual(['instruction'])
    form.task.instruction = 'x'
    form.task.objects.push({ name: ' ', role: 'other', description: '' })
    form.soft.indicators.push({ id: 'a', description: 'one', weight: -1, gate: false, gateBelow: 0.3, rubric: '' })
    form.soft.indicators.push({ id: 'a', description: 'two', weight: 1, gate: false, gateBelow: 0.3, rubric: '' })
    form.scoring.reviewThreshold = 0.9
    expect(validateSpec(form)).toEqual(['objectName', 'weight', 'indicatorId', 'thresholdOrder'])
    form.scoring.acceptThreshold = 1.5
    expect(validateSpec(form)).toContain('threshold')
  })

  it('derives ids from the wording', () => {
    expect(slugOf('The cup stands on the tray!')).toBe('the_cup_stands_on_the_tray')
    expect(slugOf('Größe passt')).toBe('gro_e_passt')
    expect(uniqueId('done', ['done', 'done_2'])).toBe('done_3')
    expect(uniqueId('', [])).toBe('indicator')
  })
})
