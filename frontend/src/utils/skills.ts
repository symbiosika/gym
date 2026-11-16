import type { SkillListItem, SkillStatus } from '@/types/gym'

/**
 * The skills list narrowed by what the reader typed and by a status: the text
 * is looked for in the name and in the name of the collection, whatever the
 * case. No text and no status leave the list as it is.
 */
export function filterSkills(list: SkillListItem[], text: string, status: SkillStatus | null): SkillListItem[] {
  const needle = text.trim().toLowerCase()
  return list.filter(
    (s) =>
      (!status || s.status === status) &&
      (!needle || s.name.toLowerCase().includes(needle) || (s.collectionName ?? '').toLowerCase().includes(needle)),
  )
}
