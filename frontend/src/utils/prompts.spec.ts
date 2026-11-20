import { describe, expect, it } from 'vitest'
import { distribution, variantLines } from './prompts'

describe('paraphrases', () => {
  it('reads one variant per line, without empty lines or repeats', () => {
    expect(variantLines(' a \n\nb\na\n')).toEqual(['a', 'b'])
  })

  it('spreads the episodes evenly, the prompt itself first when it is kept', () => {
    expect(distribution(7, ['x', 'y'], true)).toEqual([
      { prompt: null, n: 3 },
      { prompt: 'x', n: 2 },
      { prompt: 'y', n: 2 },
    ])
    expect(distribution(4, ['x', 'y'], false)).toEqual([
      { prompt: 'x', n: 2 },
      { prompt: 'y', n: 2 },
    ])
    expect(distribution(4, [], true)).toEqual([])
  })
})
