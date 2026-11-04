import type { ComponentStatus, Robot, RobotStatus } from '@/types/gym'

/** The tones of Pill for the robot's status and a component's status. */
export const ROBOT_STATUS_TONE: Record<RobotStatus, 'ok' | 'warn' | 'neutral'> = {
  in_service: 'ok',
  maintenance: 'warn',
  retired: 'neutral',
}

export const COMPONENT_STATUS_TONE: Record<ComponentStatus, 'ok' | 'warn' | 'bad' | 'neutral'> = {
  ok: 'ok',
  degraded: 'warn',
  faulty: 'bad',
  unknown: 'neutral',
}

/** The name people use first, the technical one when there is none. */
export const robotLabel = (r: Pick<Robot, 'personalName' | 'technicalName'>) => r.personalName || r.technicalName

/** "Mia (MAiRA 001)", or the technical name alone. */
export const robotFullLabel = (r: Pick<Robot, 'personalName' | 'technicalName'>) =>
  r.personalName ? `${r.personalName} (${r.technicalName})` : r.technicalName

/** The statuses worth a look, worst first, with how many components have them. */
export function healthIssues(health: Robot['health']): { status: Exclude<ComponentStatus, 'ok'>; n: number }[] {
  return (['faulty', 'degraded', 'unknown'] as const).filter((s) => health[s] > 0).map((s) => ({ status: s, n: health[s] }))
}

export const componentCount = (health: Robot['health']) => health.ok + health.degraded + health.faulty + health.unknown

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
