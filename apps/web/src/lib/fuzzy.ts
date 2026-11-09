/**
 * Subsequence fuzzy matcher for the command palette.
 *
 * Deliberately not a dependency: the scoring rules here are ~40 lines, fully
 * deterministic, and unit tested. A library would add a bundle for behaviour
 * that is easy to specify exactly.
 *
 * Scoring favours, in order:
 *   1. a contiguous match
 *   2. a match at a word boundary
 *   3. an early match
 *   4. a short target (so "note" beats "notification settings")
 */
export interface FuzzyMatch {
  score: number;
  /** Indices in the target that matched, for highlighting. */
  indices: number[];
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const needle = query.trim().toLowerCase();
  const haystack = target.toLowerCase();
  if (needle.length === 0) return { score: 0, indices: [] };
  if (needle.length > haystack.length) return null;

  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let previousIndex = -1;

  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return null;

    indices.push(found);
    // Contiguous run.
    if (previousIndex !== -1 && found === previousIndex + 1) score += 8;
    // Word boundary: start of string or after a space/dash/underscore.
    if (found === 0 || /[\s\-_/]/.test(haystack[found - 1] ?? "")) score += 6;
    // Earlier matches are better.
    score += Math.max(0, 4 - found * 0.05);

    previousIndex = found;
    cursor = found + 1;
  }

  // Prefer shorter targets when the match quality is otherwise equal.
  score -= haystack.length * 0.02;
  // Whole-string prefix match is the strongest signal.
  if (haystack.startsWith(needle)) score += 12;

  return { score, indices };
}

export interface RankedItem<T> {
  item: T;
  score: number;
  indices: number[];
}

/** Rank items by fuzzy score against a label, dropping non-matches. */
export function rankByFuzzy<T>(
  query: string,
  items: readonly T[],
  labelOf: (item: T) => string,
  limit = 40,
): RankedItem<T>[] {
  const ranked: RankedItem<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, labelOf(item));
    if (!match) continue;
    ranked.push({ item, score: match.score, indices: match.indices });
  }
  ranked.sort((left, right) => right.score - left.score);
  return ranked.slice(0, limit);
}
