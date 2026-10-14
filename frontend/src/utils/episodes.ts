/**
 * Episodes picked the way pages are picked for printing: "0-9", "1-3,6,8".
 * The same rules as the backend (backend/src/lib/gym/episode-selection.ts),
 * so a field can say what it will pick before it is saved.
 */

/** More than this in one pick is a typo ("0-99999"), not a sample. */
export const MAX_PICKED_EPISODES = 500

export type EpisodePick =
  | { ok: true; episodes: number[] }
  | { ok: false; error: 'syntax' | 'backwards' | 'tooMany'; part: string }

/** The episodes a pick names, ascending and each once, or why it names none. */
export function parseEpisodes(text: string, max = MAX_PICKED_EPISODES): EpisodePick {
  const picked = new Set<number>()
  for (const raw of text.split(/[,;\s]+/)) {
    const part = raw.trim()
    if (!part) continue
    const range = /^(\d{1,7})(?:-(\d{1,7}))?$/.exec(part)
    if (!range) return { ok: false, error: 'syntax', part }
    const from = Number(range[1])
    const to = range[2] != null ? Number(range[2]) : from
    if (to < from) return { ok: false, error: 'backwards', part }
    if (to - from + 1 + picked.size > max) return { ok: false, error: 'tooMany', part }
    for (let i = from; i <= to; i++) picked.add(i)
  }
  return { ok: true, episodes: [...picked].sort((a, b) => a - b) }
}

/** The shortest pick for a list of episodes: [1, 2, 3, 6, 8] is "1-3,6,8". */
export function formatEpisodes(episodes: number[]): string {
  const sorted = [...new Set(episodes)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]))
    i = j + 1
  }
  return parts.join(',')
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    entries.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The fingerprint of a spec, as the backend stores it with a test run
 * (specFingerprint in lib/gym/spec-drafts.ts): FNV-1a over its JSON with the
 * keys sorted. Equal to a run's means the run tested the spec on screen.
 */
export function specFingerprint(spec: Record<string, unknown>): string {
  const text = canonicalJson(spec)
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
