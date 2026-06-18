import type { LocateHit, MapEntry, MapIndex } from './types.ts';

interface Scored {
  entry: MapEntry;
  tier: number;
  match: string;
  matched: number;
  kindPrior: number;
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

// Drop these from a multi-word query — they carry no routing signal.
const STOP = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'and', 'or', 'is', 'are', 'how', 'where', 'what', 'that', 'this', 'with', 'between', 'two', 'into', 'from', 'on', 'it', 'its',
  'by', 'as', 'at', 'be', 'do', 'does', 'when', 'which', 'we', 'i', 'you',
]);

// An action verb in the query implies the impact point is code that *does* it
// (a function/method), not a type that merely names it.
const ACTION = new Set([
  'compute', 'build', 'parse', 'run', 'handle', 'resolve', 'load', 'save', 'create', 'make', 'get', 'set', 'find', 'detect', 'scan', 'render', 'format', 'validate', 'check',
  'update', 'add', 'remove', 'delete', 'diff', 'sort', 'filter', 'walk', 'emit', 'read', 'write', 'fetch', 'send', 'start', 'stop', 'init', 'process', 'analyze', 'extract',
  'generate', 'apply', 'merge', 'split', 'count', 'compare', 'verify',
]);
const FN_KINDS = new Set(['FunctionDeclaration', 'ClassMethod', 'default']);
const TYPE_KINDS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration']);

interface Term {
  raw: string;
  low: string;
}

function queryTerms(q: string): Term[] {
  const out: Term[] = [];
  for (const raw of q.split(/[^A-Za-z0-9_$]+/)) {
    if (!raw) continue;
    const low = raw.toLowerCase();
    if (low.length < 2 || STOP.has(low)) continue;
    out.push({ raw, low });
  }
  return out;
}

/** Split an identifier into lowercased subwords (camelCase / snake / kebab / digits), plus the whole name. */
function subwords(name: string): Set<string> {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const set = new Set(parts);
  set.add(name.toLowerCase());
  return set;
}

/**
 * Route a query to candidate coordinates — the one thing the map must do well.
 *
 * Ranking, in priority order: best per-term match tier (an exact name still
 * wins), then how many query terms the name covers (so "compute diff" lands on
 * `computeDiff`, not `DiffResult`), then a verb→function prior (an action query
 * prefers code that does it over a type that names it), then fan-in, then name
 * closeness. All lexical/structural — no stored meaning, no embeddings.
 *
 * A query may be a bare name ("buildIndex"), a multi-word concept ("compute the
 * diff"), a path-scoped name ("alias-map#buildAliasMap"), or a path fragment.
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
  const terms = queryTerms(namePart);
  const verbQuery = terms.some((t) => ACTION.has(t.low));

  const scored: Scored[] = [];
  for (const e of index.entries) {
    if (fileNeedle && !e.file.toLowerCase().includes(fileNeedle)) continue;
    if (kindNeedle && !e.kind.toLowerCase().includes(kindNeedle)) continue;

    if (terms.length === 0) {
      scored.push({ entry: e, tier: 1, match: 'any', matched: 0, kindPrior: 0, lenPen: 0, fanIn: e.fanIn ?? 0 });
      continue;
    }

    const sub = subwords(e.name);
    const nl = e.name.toLowerCase();
    let best = 0;
    let bestLabel = '';
    let matched = 0;
    for (const t of terms) {
      const s = termTier(e.name, nl, sub, t);
      if (s.tier > 0) matched++;
      if (s.tier > best) {
        best = s.tier;
        bestLabel = s.label;
      }
    }
    if (best === 0) continue;

    let kindPrior = 0;
    if (verbQuery) kindPrior = FN_KINDS.has(e.kind) ? 1 : TYPE_KINDS.has(e.kind) ? -1 : 0;

    scored.push({ entry: e, tier: best, match: bestLabel, matched, kindPrior, lenPen: lengthPenalty(e.name, namePart), fanIn: e.fanIn ?? 0 });
  }

  scored.sort(
    (a, b) =>
      b.tier - a.tier || // exact name still wins outright
      b.matched - a.matched || // cover more of the query
      b.kindPrior - a.kindPrior || // action query → the code that does it
      b.fanIn - a.fanIn || // then importance
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

function termTier(name: string, nl: string, sub: Set<string>, t: Term): { tier: number; label: string } {
  if (name === t.raw) return { tier: 100, label: 'exact' };
  if (nl === t.low) return { tier: 92, label: 'ci-exact' };
  if (sub.has(t.low)) return { tier: 80, label: 'word' }; // whole subword: "diff" in computeDiff
  if (nl.startsWith(t.low)) return { tier: 70, label: 'prefix' };
  if (nl.includes(t.low)) return { tier: 50, label: 'substring' };
  if (t.low.length >= 3 && isSubsequence(t.low, nl)) return { tier: 30, label: 'fuzzy' };
  return { tier: 0, label: '' };
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
