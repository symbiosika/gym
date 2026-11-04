import {
  CAPABILITY_SECTIONS,
  type CapabilitySection,
  type ComponentStatus,
  type Robot,
  type RobotStatus,
  type SectionChange,
} from '@/types/gym'

/** The tones of Pill for the robot's status and a component's status. */
export const ROBOT_STATUS_TONE: Record<RobotStatus, 'ok' | 'warn' | 'neutral'> = {
  in_service: 'ok',
  maintenance: 'warn',
  retired: 'neutral',
}

export const COMPONENT_STATUS_TONE: Record<ComponentStatus, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  ok: 'ok',
  degraded: 'warn',
  faulty: 'bad',
  disconnected: 'info',
  unknown: 'neutral',
}

/** The name people use first, the technical one when there is none. */
export const robotLabel = (r: Pick<Robot, 'personalName' | 'technicalName'>) => r.personalName || r.technicalName

/** "Mia (MAiRA 001)", or the technical name alone. */
export const robotFullLabel = (r: Pick<Robot, 'personalName' | 'technicalName'>) =>
  r.personalName ? `${r.personalName} (${r.technicalName})` : r.technicalName

/** The statuses worth a look, worst first, with how many components have them. */
export function healthIssues(health: Robot['health']): { status: Exclude<ComponentStatus, 'ok'>; n: number }[] {
  return (['faulty', 'degraded', 'disconnected', 'unknown'] as const)
    .filter((s) => health[s] > 0)
    .map((s) => ({ status: s, n: health[s] }))
}

export const componentCount = (health: Robot['health']) =>
  health.ok + health.degraded + health.faulty + health.disconnected + health.unknown

const COPY_SUFFIX = / copy \d+$/

/**
 * The name of a copy: "Cam" becomes "Cam copy 1", or the next free number
 * when that one is taken. A copy of a copy counts on from the original name.
 */
export function copyName(name: string, taken: string[]): string {
  const base = name.trim().replace(COPY_SUFFIX, '')
  const names = new Set(taken.map((n) => n.trim()))
  let n = 1
  while (names.has(`${base} copy ${n}`)) n += 1
  return `${base} copy ${n}`
}

/**
 * The lines of the history for the sections one save changed, in section
 * order: "added", "updated" or "removed" when that is all that happened to
 * the section, "updated" over every component it touched when several kinds of
 * change came together.
 */
export function sectionChangeLines(
  sections: Partial<Record<CapabilitySection, SectionChange>> | undefined,
): { section: CapabilitySection; kind: keyof SectionChange; names: string[] }[] {
  if (!sections) return []
  return CAPABILITY_SECTIONS.flatMap((section) => {
    const c = sections[section]
    if (!c) return []
    const kinds = (['added', 'updated', 'removed'] as const).filter((k) => c[k].length)
    if (!kinds.length) return []
    if (kinds.length === 1) return [{ section, kind: kinds[0]!, names: c[kinds[0]!] }]
    return [{ section, kind: 'updated' as const, names: [...c.added, ...c.updated, ...c.removed] }]
  })
}
