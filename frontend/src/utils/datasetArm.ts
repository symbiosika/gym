import type { ArmChoice, SpecOverrides } from '@/types/gym'

/**
 * The arm a session folder or zip name says it recorded with: "left-arm",
 * "left_arm", "leftarm", "-left-", "_left_" and the same for right, in any case.
 * Null when it names both or neither, so the critics detect it from the motion.
 */
export function armFromFileName(name: string): 'left' | 'right' | null {
  const says = (arm: 'left' | 'right') => new RegExp(`${arm}[-_]?arm|(^|[-_])${arm}([-_.]|$)`, 'i').test(name)
  const left = says('left')
  const right = says('right')
  return left === right ? null : left ? 'left' : 'right'
}

/** What the critics are told for a choice: `auto` tells them nothing, they take the spec's arms or detect them. */
export function armOverrides(choice: ArmChoice): SpecOverrides | null {
  if (choice === 'auto') return null
  return { robot: { active_arms: choice === 'both' ? ['left', 'right'] : [choice] } }
}

/**
 * The arm choice plus the optional task variant of one dataset: an instruction
 * and the objects as one name per line (the first is the target, the rest are
 * distractors). Null when there is nothing to tell the critics.
 */
export function instructionOverrides(base: SpecOverrides | null, instruction: string, objects: string): SpecOverrides | null {
  const out: SpecOverrides = { ...(base ?? {}) }
  const task: NonNullable<SpecOverrides['task']> = {}
  if (instruction.trim()) task.instruction = instruction.trim()
  const names = objects
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (names.length) task.objects = names.map((name, i) => ({ name, role: i === 0 ? 'target_object' : 'distractor' }))
  if (Object.keys(task).length) out.task = task
  return Object.keys(out).length ? out : null
}

/**
 * Whether the arm, the instruction and the objects of a queued zip may still be
 * changed: only while it waits and its upload has not begun. Once the upload has
 * an id the overrides are kept on the upload row and a resume uses those, so a
 * change here would no longer reach the critics.
 */
export function overridesEditable(state: string, uploadId: string | undefined): boolean {
  return state === 'waiting' && !uploadId
}
