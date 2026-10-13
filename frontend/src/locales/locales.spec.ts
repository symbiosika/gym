import { describe, expect, it } from 'vitest'
import de from './de.json'
import en from './en.json'

/**
 * German is written first and English is the translation, so the two files
 * drift apart the moment a key is added to one of them. A missing key does not
 * fail the build, it shows the raw key to an operator at the cell, so it is
 * checked here instead.
 */
function keysOf(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k))
}

/** The `{n}`-style placeholders a string uses, sorted. */
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()

const valueAt = (source: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], source)

describe('locales', () => {
  const deKeys = keysOf(de)
  const enKeys = keysOf(en)

  it('has the same keys in both languages', () => {
    expect(deKeys.filter((k) => !enKeys.includes(k))).toEqual([])
    expect(enKeys.filter((k) => !deKeys.includes(k))).toEqual([])
  })

  it('has no empty text', () => {
    for (const key of deKeys) expect(String(valueAt(de, key)).trim(), key).not.toBe('')
    for (const key of enKeys) expect(String(valueAt(en, key)).trim(), key).not.toBe('')
  })

  it('uses the same placeholders in both languages', () => {
    for (const key of deKeys) {
      const a = valueAt(de, key)
      const b = valueAt(en, key)
      if (typeof a !== 'string' || typeof b !== 'string') continue
      expect(placeholders(b), key).toEqual(placeholders(a))
    }
  })

  it('keeps dashes out of the UI text (design.md: use · or a new sentence)', () => {
    for (const [lang, source] of [
      ['de', de],
      ['en', en],
    ] as const) {
      for (const key of keysOf(source)) {
        const text = String(valueAt(source, key))
        expect(text.includes('—') || text.includes('–'), `${lang}.${key}: ${text}`).toBe(false)
      }
    }
  })
})
