import { describe, expect, it } from 'vitest'
import { readableError } from './errors'

const t = (key: string) => `<${key}>`

describe('readableError', () => {
  it('says a known message of the API in the words of the UI', () => {
    expect(readableError('The block has no plan', t)).toBe('<errors.noPlan>')
    expect(readableError('  The block is closed ', t)).toBe('<errors.blockClosed>')
  })
  it('knows the messages with a variable part', () => {
    expect(readableError('The upload lost chunk 3; upload it again', t)).toBe('<errors.uploadBroken>')
    expect(readableError('A cell named "Cell 13" already exists', t)).toBe('<errors.nameTaken>')
    expect(readableError('Failed to fetch', t)).toBe('<errors.network>')
    expect(readableError('Skill not found', t)).toBe('<errors.notFound>')
  })
  it('shows a message it does not know as it came', () => {
    expect(readableError('Something new went wrong', t)).toBe('Something new went wrong')
  })
})
