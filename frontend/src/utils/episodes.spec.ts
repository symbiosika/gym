import { describe, expect, it } from 'vitest'
import { formatEpisodes, parseEpisodes, specFingerprint } from './episodes'

describe('episode picks', () => {
  it('reads a pick like a print range', () => {
    expect(parseEpisodes('1-3,6,8')).toEqual({ ok: true, episodes: [1, 2, 3, 6, 8] })
    expect(parseEpisodes(' 8; 6 1-3 3 ')).toEqual({ ok: true, episodes: [1, 2, 3, 6, 8] })
    expect(parseEpisodes('')).toEqual({ ok: true, episodes: [] })
  })

  it('says why a pick names nothing', () => {
    expect(parseEpisodes('1-x')).toMatchObject({ ok: false, error: 'syntax', part: '1-x' })
    expect(parseEpisodes('5-2')).toMatchObject({ ok: false, error: 'backwards' })
    expect(parseEpisodes('0-999')).toMatchObject({ ok: false, error: 'tooMany' })
  })

  it('writes episodes back as the shortest pick', () => {
    expect(formatEpisodes([8, 1, 2, 3, 6, 2])).toBe('1-3,6,8')
    expect(formatEpisodes([])).toBe('')
  })

  it('fingerprints a spec regardless of the order of its keys', () => {
    // the value the backend computes for the same spec (spec-drafts.test.ts)
    expect(specFingerprint({ task: { instruction: 'put the cup on the tray' }, scoring: { accept: 0.7 } })).toBe('7a3c055a')
    expect(specFingerprint({ b: 1, a: { d: [1, 'x'], c: null } })).toBe(specFingerprint({ a: { c: null, d: [1, 'x'] }, b: 1 }))
    expect(specFingerprint({ a: 1 })).not.toBe(specFingerprint({ a: 2 }))
    expect(specFingerprint({ a: 1 })).toMatch(/^[0-9a-f]{8}$/)
  })
})
