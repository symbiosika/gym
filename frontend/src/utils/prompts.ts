/**
 * The paraphrases of a prompt as the prompt tool edits them: one variant per
 * line, and how a merged export spreads the episodes over them (the backend
 * hands them out in turn, lib/gym/prompts.ts `assignVariants`).
 */

/** The variants written one per line: trimmed, no empty line, no repeat. */
export function variantLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ]
}

/**
 * How `n` episodes fall on the variants when they are handed out in turn: the
 * prompt itself first when it is kept. Empty without a variant.
 */
export function distribution(n: number, variants: string[], keepOriginal: boolean): { prompt: string | null; n: number }[] {
  const list: (string | null)[] = [...(keepOriginal ? [null] : []), ...variants]
  if (!variants.length) return []
  return list.map((prompt, i) => ({ prompt, n: Math.floor(n / list.length) + (i < n % list.length ? 1 : 0) }))
}
