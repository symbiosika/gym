/** Formatting helpers for dates, durations and figures. */

export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "4 h 05 min", "35 min" or "–" */
export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return '–'
  const h = Math.floor(minutes / 60)
  const r = Math.round(minutes % 60)
  return h ? `${h} h ${String(r).padStart(2, '0')} min` : `${r} min`
}

export function fmtPercent(v: number | null | undefined, digits = 0): string {
  return v == null ? '–' : `${v.toFixed(digits)} %`
}

export function fmtDate(iso: string | null | undefined, lang: string): string {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return lang === 'en' ? `${y}-${m}-${d}` : `${d}.${m}.${y}`
}

export function fmtDateLong(iso: string | null | undefined, lang: string): string {
  if (!iso) return ''
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`)
  return d.toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/** "09:41" of an ISO timestamp in the browser's time zone. */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '–'
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function fmtDateTime(iso: string | null | undefined, lang: string): string {
  if (!iso) return '–'
  return `${fmtDate(iso, lang)} ${fmtTime(iso)}`
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

export function fmtInt(v: number | null | undefined, lang = 'de'): string {
  if (v == null) return '–'
  return v.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE')
}

/** Seconds as "42 s" below two minutes, else as minutes and hours. */
export function fmtSecs(seconds: number | null | undefined): string {
  if (seconds == null) return '–'
  if (seconds < 120) return `${Math.round(seconds)} s`
  return fmtMinutes(Math.round(seconds / 60))
}
