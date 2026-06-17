import type { LocateHit, MapEntry, MapIndex } from './types.ts';

interface Scored {
  entry: MapEntry;
  tier: number;
  match: string;
  lenPen: number;
  fanIn: number;
}

export interface LocateOptions {
  /** Filter by AST kind (substring, case-insensitive). e.g. "function", "method", "class". */
  kind?: string;
  /** Filter by file path (substring, case-insensitive). */
  file?: string;
  /** Max hits returned. */
  limit?: number;
}

/**
 * Route a query to candidate coordinates. This is the one thing the map must do
 * well — every other primitive is trivial. Matching is tiered so an exact name
 * beats a fuzzy one, and the caller gets a ranked shortlist, not a guess.
 *
 * A query may be a bare name ("buildIndex"), a path-scoped name
 * ("alias-map#buildAliasMap"), or a path fragment alone ("alias-map#").
 */
export function locate(index: MapIndex, query: string, opts: LocateOptions = {}): LocateHit[] {
  const limit = opts.limit ?? 20;
  let namePart = query.trim();
  let filePart = opts.file ?? '';

  const hash = namePart.lastIndexOf('#');
  if (hash !== -1) {
    filePart = (namePart.slice(0, hash) || filePart).trim();
    namePart = namePart.slice(hash + 1).trim();
  }

  const fileNeedle = filePart.toLowerCase();
  const kindNeedle = (opts.kind ?? '').toLowerCase();
  const q = namePart;
  const ql = q.toLowerCase();

  const scored: Scored[] = [];
  for (const e of index.entries) {
    if (fileNeedle && !e.file.toLowerCase().includes(fileNeedle)) continue;
    if (kindNeedle && !e.kind.toLowerCase().includes(kindNeedle)) continue;

    const s = q ? scoreName(e.name, q, ql) : { score: 1, match: 'any' };
    if (!s) continue;

    scored.push({ entry: e, tier: s.score, match: s.match, lenPen: lengthPenalty(e.name, q), fanIn: e.fanIn ?? 0 });
  }

  // Hierarchical ranking: a better match tier ALWAYS wins (exact beats fuzzy, even
  // if the fuzzy match is more referenced). Fan-in only breaks ties *within* a tier
  // — that is where it disambiguates a canonical definition from a vendored copy.
  scored.sort(
    (a, b) =>
      b.tier - a.tier ||
      b.fanIn - a.fanIn ||
      a.lenPen - b.lenPen ||
      a.entry.file.localeCompare(b.entry.file) ||
      a.entry.line - b.entry.line,
  );

  return scored.slice(0, limit).map((s) => ({
    id: s.entry.id,
    name: s.entry.name,
    kind: s.entry.kind,
    file: s.entry.file,
    line: s.entry.line,
    endLine: s.entry.endLine,
    signature: s.entry.searchText,
    match: s.match,
    score: s.tier,
    fanIn: s.fanIn,
  }));
}

function scoreName(name: string, q: string, ql: string): { score: number; match: string } | null {
  if (name === q) return { score: 100, match: 'exact' };
  const nl = name.toLowerCase();
  if (nl === ql) return { score: 90, match: 'ci-exact' };
  if (nl.startsWith(ql)) return { score: 70, match: 'prefix' };
  if (nl.includes(ql)) return { score: 50, match: 'substring' };
  if (q.length >= 2 && isSubsequence(ql, nl)) return { score: 30, match: 'fuzzy' };
  return null;
}

/** Prefer the closest-length name among same-tier matches (buildIndex > buildIndexFromCacheLazily). */
function lengthPenalty(name: string, q: string): number {
  return Math.min(20, Math.max(0, name.length - q.length) * 0.5);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}
