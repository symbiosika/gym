/**
 * Episodes picked the way pages are picked for printing: "0-9", "1-3,6,8".
 * The spec wizard takes its sample, its test runs and the episodes a person
 * adds in this form. Episode indexes are 0-based, as in the dataset.
 */
import { InvalidInputError } from "./errors";

/** More than this in one pick is a typo ("0-99999"), not a sample. */
export const MAX_PICKED_EPISODES = 500;

/** The episodes a pick names, ascending and each once. An empty pick is none. */
export function parseEpisodeSelection(text: string, max = MAX_PICKED_EPISODES): number[] {
  const picked = new Set<number>();
  for (const raw of text.split(/[,;\s]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const range = /^(\d{1,7})(?:-(\d{1,7}))?$/.exec(part);
    if (!range) throw new InvalidInputError(`"${part}" is not an episode or a range like 1-3`);
    const from = Number(range[1]);
    const to = range[2] != null ? Number(range[2]) : from;
    if (to < from) throw new InvalidInputError(`"${part}" runs backwards`);
    if (to - from + 1 + picked.size > max) throw new InvalidInputError(`At most ${max} episodes at once`);
    for (let i = from; i <= to; i++) picked.add(i);
  }
  return [...picked].sort((a, b) => a - b);
}

/** The shortest pick for a list of episodes: [1, 2, 3, 6, 8] is "1-3,6,8". */
export function formatEpisodeSelection(episodes: number[]): string {
  const sorted = [...new Set(episodes)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return parts.join(",");
}
