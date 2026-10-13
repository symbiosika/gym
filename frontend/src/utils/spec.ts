/**
 * The critics spec as the form editor holds it.
 *
 * The critics read a spec as YAML (lerobot_critics.spec.models.CriticSpec).
 * The editor shows the same spec as fields: the task, its objects, the
 * success indicators, the technical checks and the scoring. `fromSpec` turns
 * the stored object into the form model, `toSpec` turns the form back into the
 * object the critics take. Anything the form has no field for (the VLM
 * settings, gripper details, extra questions) is carried along untouched in
 * `rest`, so a spec written by hand survives a round trip through the form.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export const OBJECT_ROLES = ['target_object', 'target_zone', 'distractor', 'tool', 'other'] as const
export type ObjectRole = (typeof OBJECT_ROLES)[number]
export const PER_EPISODE = ['auto', 'always', 'never'] as const
export type PerEpisode = (typeof PER_EPISODE)[number]

export interface SpecObject {
  name: string
  role: ObjectRole
  description: string
}

/** One success indicator the vision-language model scores from 0 to 1. */
export interface SpecIndicator {
  id: string
  description: string
  weight: number
  gate: boolean
  gateBelow: number
  rubric: string
}

/** One technical check with its weight, gate and parameter overrides. */
export interface SpecHardCritic {
  id: string
  enabled: boolean
  weight: number
  gate: boolean
  gateBelow: number
  gateFlags: string[]
  params: Record<string, unknown>
}

export interface SpecForm {
  task: {
    instruction: string
    scene: string
    notes: string
    expectedCycles: number | null
    perEpisode: PerEpisode
    objects: SpecObject[]
  }
  robot: {
    type: string
    activeArms: string[]
    primaryCamera: string
  }
  soft: {
    enabled: boolean
    weight: number
    indicators: SpecIndicator[]
  }
  hardCritics: SpecHardCritic[]
  scoring: {
    acceptThreshold: number
    reviewThreshold: number
    hardWeight: number
    softWeight: number
    ignoreFlags: string[]
  }
  /** the keys the form has no field for, kept as they were */
  rest: Record<string, unknown>
}

/** The parts of the spec form; the spec wizard shows one per step. */
export type SpecFormSection = 'task' | 'soft' | 'hard' | 'scoring' | 'robot'

/**
 * The technical checks the critics run when a spec names none, with their
 * weights and gates (lerobot_critics.spec.defaults.default_hard_critics).
 * The form shows these rows for a spec without a `hard_critics` block.
 */
export const DEFAULT_HARD_CRITICS: SpecHardCritic[] = [
  hard('integrity', {
    weight: 1,
    gate: true,
    gateBelow: 0.5,
    gateFlags: ['VIDEO_MISSING', 'NAN_VALUES', 'LENGTH_MISMATCH', 'EMPTY'],
  }),
  hard('duration', { gateFlags: ['TOO_SHORT', 'TOO_LONG'] }),
  hard('smoothness'),
  hard('tracking_error', { weight: 1.5, gate: true, gateBelow: 0.1, gateFlags: ['TRACKERR'] }),
  hard('duplication', { gate: true, gateBelow: 0.1, gateFlags: ['LAGGY', 'CAMSTALL'] }),
  hard('image_quality'),
  hard('sensor_limits'),
  hard('grasp_cycles', { gateFlags: ['NOGRASP'] }),
  hard('tremor', { weight: 0.5 }),
  hard('normalization'),
  hard('diversity', { weight: 0 }),
]

/** The ids of the checks, in the order the form lists them. */
export const HARD_CRITIC_IDS = DEFAULT_HARD_CRITICS.map((c) => c.id)

function hard(id: string, over: Partial<SpecHardCritic> = {}): SpecHardCritic {
  return { id, enabled: true, weight: 1, gate: false, gateBelow: 0.2, gateFlags: [], params: {}, ...over }
}

export function indicator(id: string, description: string, over: Partial<SpecIndicator> = {}): SpecIndicator {
  return { id, description, weight: 1, gate: false, gateBelow: 0.3, rubric: '', ...over }
}

const DEFAULT_SCORING = { acceptThreshold: 0.75, reviewThreshold: 0.55, hardWeight: 1, softWeight: 1 }

/** A spec with nothing but the defaults: the form for "start from scratch". */
export function emptySpec(): SpecForm {
  return {
    task: { instruction: '', scene: '', notes: '', expectedCycles: null, perEpisode: 'auto', objects: [] },
    robot: { type: '', activeArms: [], primaryCamera: '' },
    soft: { enabled: true, weight: 1, indicators: [] },
    hardCritics: DEFAULT_HARD_CRITICS.map((c) => ({ ...c, gateFlags: [...c.gateFlags], params: {} })),
    scoring: { ...DEFAULT_SCORING, ignoreFlags: [] },
    rest: {},
  }
}

/**
 * The success indicators the critics use when a spec names none
 * (lerobot_critics.spec.defaults.default_indicators), worded for the spec's
 * target object and zone. "Insert the defaults" in the form.
 */
export function defaultIndicators(objects: SpecObject[]): SpecIndicator[] {
  const obj = objects.find((o) => o.role === 'target_object')?.name || 'the target object'
  const zone = objects.find((o) => o.role === 'target_zone')?.name || 'the target zone'
  return [
    indicator('correct_object', `The robot identifies and manipulates the correct object (${obj}), not a distractor.`),
    indicator('grasp_centered', `${obj} is grasped stably and centred in the hand/gripper; no slipping, tilting or re-grasp.`),
    indicator('object_in_target', `At the end of each attempt ${obj} rests inside/on ${zone} in a stable, upright pose.`, {
      weight: 2,
      gate: true,
      gateBelow: 0.3,
    }),
    indicator(
      'visibility',
      `${obj} and ${zone} stay visible in the cameras during the manipulation (not out of frame or hidden).`,
      {
        weight: 0.5,
      },
    ),
    indicator(
      'no_disturbance',
      "No collisions, drops, dangerous motions, or people/hands other than the robot's in the workspace while the robot acts.",
    ),
  ]
}

/** An indicator id from its wording: `The cup stands on the tray.` becomes `the_cup_stands_on_the_tray`. */
export const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)

/** An id for a new indicator that no other indicator of the list carries. */
export function uniqueId(base: string, taken: string[]): string {
  const root = base || 'indicator'
  if (!taken.includes(root)) return root
  let n = 2
  while (taken.includes(`${root}_${n}`)) n++
  return `${root}_${n}`
}

// ---------------------------------------------------------------------------
// stored object <-> form
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v))
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : [])
const omit = (source: Obj, keys: string[]): Obj => Object.fromEntries(Object.entries(source).filter(([k]) => !keys.includes(k)))

/** The form model of a stored spec (the object the critics hold, read from its YAML). */
export function fromSpec(source: unknown): SpecForm {
  const spec = obj(source)
  const task = obj(spec.task)
  const robot = obj(spec.robot)
  const soft = obj(spec.soft_critics)
  const scoring = obj(spec.scoring)
  const perEpisodeRaw = task.per_episode
  const perEpisode: PerEpisode =
    perEpisodeRaw === true
      ? 'always'
      : perEpisodeRaw === false
        ? 'never'
        : PER_EPISODE.includes(perEpisodeRaw as PerEpisode)
          ? (perEpisodeRaw as PerEpisode)
          : 'auto'

  const objects: SpecObject[] = Array.isArray(task.objects)
    ? task.objects.map((o) => {
        const row = obj(o)
        return {
          name: str(row.name),
          role: OBJECT_ROLES.includes(row.role as ObjectRole) ? (row.role as ObjectRole) : 'other',
          description: str(row.description),
        }
      })
    : []

  const indicators: SpecIndicator[] = Array.isArray(soft.indicators)
    ? soft.indicators.map((i) => {
        const row = obj(i)
        return indicator(str(row.id), str(row.description), {
          weight: num(row.weight, 1),
          gate: bool(row.gate, false),
          gateBelow: num(row.gate_below, 0.3),
          rubric: str(row.rubric),
        })
      })
    : []

  // an empty list means "all checks with their defaults"; a list means "these and only these"
  const listed = Array.isArray(spec.hard_critics) ? spec.hard_critics.map(obj) : []
  const hardCritics: SpecHardCritic[] = listed.length
    ? [
        ...HARD_CRITIC_IDS.map((id) => {
          const row = listed.find((r) => r.id === id)
          const fallback = DEFAULT_HARD_CRITICS.find((c) => c.id === id)!
          if (!row) return { ...fallback, enabled: false, gateFlags: [...fallback.gateFlags], params: {} }
          return hardFrom(row)
        }),
        // checks GYM does not know by name (a newer service) stay as they are
        ...listed.filter((r) => !HARD_CRITIC_IDS.includes(str(r.id))).map(hardFrom),
      ]
    : emptySpec().hardCritics

  const rest: Obj = omit(spec, ['name', 'task', 'robot', 'soft_critics', 'hard_critics', 'scoring'])
  const taskRest = omit(task, ['instruction', 'scene', 'notes', 'expected_cycles', 'per_episode', 'objects'])
  const robotRest = omit(robot, ['type', 'active_arms', 'primary_camera'])
  const softRest = omit(soft, ['enabled', 'weight', 'indicators'])
  const scoringRest = omit(scoring, ['accept_threshold', 'review_threshold', 'hard_weight', 'soft_weight', 'ignore_flags'])
  if (Object.keys(taskRest).length) rest.task = taskRest
  if (Object.keys(robotRest).length) rest.robot = robotRest
  if (Object.keys(softRest).length) rest.soft_critics = softRest
  if (Object.keys(scoringRest).length) rest.scoring = scoringRest

  return {
    task: {
      instruction: str(task.instruction),
      scene: str(task.scene),
      notes: str(task.notes),
      expectedCycles: typeof task.expected_cycles === 'number' ? task.expected_cycles : null,
      perEpisode,
      objects,
    },
    robot: { type: str(robot.type), activeArms: strList(robot.active_arms), primaryCamera: str(robot.primary_camera) },
    soft: { enabled: bool(soft.enabled, true), weight: num(soft.weight, 1), indicators },
    hardCritics,
    scoring: {
      acceptThreshold: num(scoring.accept_threshold, DEFAULT_SCORING.acceptThreshold),
      reviewThreshold: num(scoring.review_threshold, DEFAULT_SCORING.reviewThreshold),
      hardWeight: num(scoring.hard_weight, 1),
      softWeight: num(scoring.soft_weight, 1),
      ignoreFlags: strList(scoring.ignore_flags),
    },
    rest,
  }
}

function hardFrom(row: Obj): SpecHardCritic {
  const id = str(row.id)
  const fallback = DEFAULT_HARD_CRITICS.find((c) => c.id === id)
  return {
    id,
    enabled: bool(row.enabled, true),
    weight: num(row.weight, fallback?.weight ?? 1),
    gate: bool(row.gate, false),
    gateBelow: num(row.gate_below, 0.2),
    gateFlags: strList(row.gate_flags),
    params: obj(row.params),
  }
}

/**
 * The object the critics take, from the form. Fields at their default are
 * left out so the YAML stays as short as a hand-written one; the technical
 * checks are always written in full, so what the table shows is what runs.
 */
export function toSpec(form: SpecForm, name: string): Obj {
  const task: Obj = { ...obj(form.rest.task), instruction: form.task.instruction.trim() }
  if (form.task.perEpisode !== 'auto') task.per_episode = form.task.perEpisode
  if (form.task.scene.trim()) task.scene = form.task.scene.trim()
  if (form.task.objects.length) {
    task.objects = form.task.objects
      .filter((o) => o.name.trim())
      .map((o) => ({ name: o.name.trim(), ...(o.description.trim() ? { description: o.description.trim() } : {}), role: o.role }))
  }
  if (form.task.expectedCycles != null) task.expected_cycles = form.task.expectedCycles
  if (form.task.notes.trim()) task.notes = form.task.notes.trim()

  const robot: Obj = { ...obj(form.rest.robot) }
  if (form.robot.type.trim()) robot.type = form.robot.type.trim()
  if (form.robot.activeArms.length) robot.active_arms = form.robot.activeArms
  if (form.robot.primaryCamera.trim()) robot.primary_camera = form.robot.primaryCamera.trim()

  const soft: Obj = { ...obj(form.rest.soft_critics) }
  if (!form.soft.enabled) soft.enabled = false
  if (form.soft.weight !== 1) soft.weight = form.soft.weight
  if (form.soft.indicators.length) {
    soft.indicators = form.soft.indicators
      .filter((i) => i.description.trim())
      .map((i) => ({
        id: i.id,
        description: i.description.trim(),
        weight: i.weight,
        ...(i.gate ? { gate: true, gate_below: i.gateBelow } : {}),
        ...(i.rubric.trim() ? { rubric: i.rubric.trim() } : {}),
      }))
  }

  const hardCritics = form.hardCritics.map((c) => ({
    id: c.id,
    weight: c.weight,
    ...(c.enabled ? {} : { enabled: false }),
    ...(c.gate ? { gate: true, gate_below: c.gateBelow } : {}),
    ...(c.gateFlags.length ? { gate_flags: c.gateFlags } : {}),
    ...(Object.keys(c.params).length ? { params: c.params } : {}),
  }))

  const scoring: Obj = { ...obj(form.rest.scoring) }
  if (form.scoring.acceptThreshold !== DEFAULT_SCORING.acceptThreshold) scoring.accept_threshold = form.scoring.acceptThreshold
  if (form.scoring.reviewThreshold !== DEFAULT_SCORING.reviewThreshold) scoring.review_threshold = form.scoring.reviewThreshold
  if (form.scoring.hardWeight !== 1) scoring.hard_weight = form.scoring.hardWeight
  if (form.scoring.softWeight !== 1) scoring.soft_weight = form.scoring.softWeight
  if (form.scoring.ignoreFlags.length) scoring.ignore_flags = form.scoring.ignoreFlags

  const out: Obj = { name, ...omit(form.rest, ['task', 'robot', 'soft_critics', 'scoring']), task }
  if (Object.keys(robot).length) out.robot = robot
  if (Object.keys(soft).length) out.soft_critics = soft
  out.hard_critics = hardCritics
  if (Object.keys(scoring).length) out.scoring = scoring
  return out
}

export const toYaml = (form: SpecForm, name: string): string => stringifyYaml(toSpec(form, name))

/** The form of a YAML text; throws with the parser's message when it is not a spec. */
export function fromYaml(text: string): SpecForm {
  const parsed: unknown = parseYaml(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The spec must be one object')
  return fromSpec(parsed)
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

/** What keeps a spec from being saved, as locale keys under `spec.error`. */
export function validateSpec(form: SpecForm): string[] {
  const errors: string[] = []
  if (!form.task.instruction.trim()) errors.push('instruction')
  if (form.task.objects.some((o) => !o.name.trim())) errors.push('objectName')
  if (form.soft.indicators.some((i) => !i.description.trim())) errors.push('indicatorText')
  if (form.soft.indicators.some((i) => i.weight < 0) || form.hardCritics.some((c) => c.weight < 0)) errors.push('weight')
  const ids = form.soft.indicators.map((i) => i.id)
  if (new Set(ids).size !== ids.length) errors.push('indicatorId')
  const { acceptThreshold: a, reviewThreshold: r } = form.scoring
  if (a < 0 || a > 1 || r < 0 || r > 1) errors.push('threshold')
  else if (r > a) errors.push('thresholdOrder')
  return errors
}

// ---------------------------------------------------------------------------
// presets: the patterns a new spec starts from
// ---------------------------------------------------------------------------

export const PRESET_IDS = ['pick_place', 'repeated', 'sorting', 'insertion', 'bimanual', 'evaluation', 'blank'] as const
export type PresetId = (typeof PRESET_IDS)[number]

const objects = (...rows: [string, ObjectRole, string?][]): SpecObject[] =>
  rows.map(([name, role, description = '']) => ({ name, role, description }))

/**
 * A spec for one of the recurring task shapes, filled in for a typical
 * scene. The operator renames the objects and the wording follows on the
 * next "insert the defaults"; the checks and gates are already set the way
 * that task shape needs them.
 */
export function presetSpec(id: PresetId): SpecForm {
  const form = emptySpec()
  switch (id) {
    case 'pick_place': {
      form.task.instruction = 'put the red cup on the tray'
      form.task.scene = 'A table with a red cup and an empty tray in front of the robot.'
      form.task.objects = objects(['red cup', 'target_object'], ['tray', 'target_zone'])
      form.soft.indicators = defaultIndicators(form.task.objects)
      break
    }
    case 'repeated': {
      form.task.instruction = 'move the three cubes from the left box into the right box, one at a time'
      form.task.scene = 'Two open boxes on a table; the left one holds three cubes at the start.'
      form.task.objects = objects(
        ['cube', 'target_object', 'three identical cubes'],
        ['right box', 'target_zone'],
        ['left box', 'other', 'where the cubes start'],
      )
      form.task.expectedCycles = 3
      form.soft.indicators = [
        indicator('all_cycles_completed', 'All three cubes lie in the right box at the end of the episode.', {
          weight: 2,
          gate: true,
          gateBelow: 0.3,
        }),
        indicator('one_at_a_time', 'Exactly one cube is carried per grasp; no cube is dropped outside the boxes.'),
        indicator('grasp_stable', 'Each cube is grasped stably without re-grasping.'),
        indicator(
          'no_disturbance',
          "No collisions, no dangerous motions, no people or hands other than the robot's in the workspace.",
        ),
      ]
      const duration = form.hardCritics.find((c) => c.id === 'duration')!
      duration.params = { per_cycle: true, min_s: 3, max_s: 40 }
      break
    }
    case 'sorting': {
      form.task.instruction = 'sort the objects: fruit into the green bowl, tools into the grey box'
      form.task.scene = 'A table with mixed objects in the middle, a green bowl on the left and a grey box on the right.'
      form.task.objects = objects(
        ['fruit', 'target_object', 'apples and bananas'],
        ['tools', 'target_object', 'screwdriver and wrench'],
        ['green bowl', 'target_zone', 'for the fruit'],
        ['grey box', 'target_zone', 'for the tools'],
        ['blue cup', 'distractor', 'must not be moved'],
      )
      form.soft.indicators = [
        indicator('all_sorted', 'At the end every fruit lies in the green bowl and every tool in the grey box.', {
          weight: 2,
          gate: true,
          gateBelow: 0.3,
        }),
        indicator('no_wrong_zone', 'No object is placed into the wrong zone, not even for a moment.', { weight: 1.5 }),
        indicator('distractor_untouched', 'The distractor stays where it was and is never grasped.'),
        indicator('no_disturbance', "No collisions, drops or people/hands other than the robot's in the workspace."),
      ]
      break
    }
    case 'insertion': {
      form.task.instruction = 'insert the peg into the hole of the fixture'
      form.task.scene = 'A fixture with one round hole is clamped to the table; the peg lies loose next to it.'
      form.task.objects = objects(
        ['peg', 'target_object'],
        ['hole', 'target_zone', 'the round hole of the fixture'],
        ['fixture', 'other'],
      )
      form.soft.indicators = [
        indicator('fully_inserted', 'The peg is fully inserted in the hole at the end and stays there when released.', {
          weight: 2,
          gate: true,
          gateBelow: 0.3,
        }),
        indicator(
          'aligned_before_insert',
          'The peg is aligned above the hole before it is pushed down; no scraping across the fixture.',
          { weight: 1.5 },
        ),
        indicator('no_force', 'No jamming, wedging or visible forcing; the insertion is one smooth motion.'),
        indicator(
          'no_disturbance',
          "No collisions with the fixture, no drops, no people or hands other than the robot's in the workspace.",
        ),
      ]
      form.hardCritics.find((c) => c.id === 'smoothness')!.weight = 1.5
      form.hardCritics.find((c) => c.id === 'tremor')!.weight = 1
      break
    }
    case 'bimanual': {
      form.task.instruction = 'pick up the bottle with the right arm, hand it over to the left arm and place it in the crate'
      form.task.scene =
        'A bottle stands on the right side of the table; the crate stands on the left side, within reach of the left arm only.'
      form.task.objects = objects(['bottle', 'target_object'], ['crate', 'target_zone'])
      form.soft.indicators = [
        indicator('bottle_in_crate', 'The bottle stands upright in the crate at the end of the episode.', {
          weight: 2,
          gate: true,
          gateBelow: 0.3,
        }),
        indicator('handover_clean', 'The bottle is passed from the right hand to the left hand without dropping or tilting.', {
          weight: 1.5,
        }),
        indicator(
          'both_arms_used',
          'The right arm grasps first, the left arm places; neither arm is idle for the whole episode.',
        ),
        indicator(
          'no_disturbance',
          "No collisions between the arms, no drops, no people or hands other than the robot's in the workspace.",
        ),
      ]
      form.robot.activeArms = ['left', 'right']
      break
    }
    case 'evaluation': {
      // the critics judge these episodes as rollouts of a policy: the outcome decides, the
      // technical checks only report (see critics/README.md, "Recording or evaluation")
      form.rest.purpose = 'evaluation'
      form.task.instruction = 'put the red cup on the tray'
      form.task.scene = 'A table with a red cup and an empty tray in front of the robot. The policy runs on its own.'
      form.task.notes = 'Judge the outcome only. Hesitation and slow motion are not failures; a wrong or dropped object is.'
      form.task.objects = objects(['red cup', 'target_object'], ['tray', 'target_zone'])
      form.soft.indicators = [
        indicator('task_completed', 'The red cup stands on the tray at the end of the episode.', {
          weight: 3,
          gate: true,
          gateBelow: 0.5,
        }),
        indicator('correct_object', 'The robot manipulates the red cup and nothing else.', { weight: 1.5 }),
        indicator('no_disturbance', "No collisions, no drops, no people or hands other than the robot's intervene."),
      ]
      form.scoring.softWeight = 2
      for (const c of form.hardCritics) if (['smoothness', 'tremor', 'diversity'].includes(c.id)) c.weight = 0
      break
    }
    case 'blank':
      break
  }
  return form
}
