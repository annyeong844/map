import type { LocateHit, MapEntry, MapIndex } from './types.ts';
import { exactFileEntryRange, getPreparedLookup } from './store.ts';

interface Scored {
  entry: MapEntry;
  tier: number;
  match: string;
  matched: number;
  kindPrior: number;
  lenPen: number;
  fanIn: number;
}

interface SearchEntry {
  nameLow?: string;
  fileLow?: string;
  kindLow?: string;
  /** Subword-boundary bitset for short identifiers. `null` means streaming. */
  wordMask?: number | null;
}

interface SearchTable {
  entries: (SearchEntry | undefined)[];
}

const searchTables = new WeakMap<MapIndex, SearchTable>();
const resultCaches = new WeakMap<MapIndex, Map<string, Scored[]>>();
const RESULT_CACHE_SIZE = 32;
const RESULT_CACHE_MAX_HITS = 64;

export interface LocateOptions {
  /** Filter by AST kind (substring, case-insensitive). e.g. "function", "method", "class". */
  kind?: string;
  /** Filter by file path (substring, case-insensitive). */
  file?: string;
  /** Max hits returned. */
  limit?: number;
}

export interface LocatedResult {
  hits: LocateHit[];
  /** Exact entry objects behind `hits`, in the same order. */
  entries: MapEntry[];
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

const isUpperCode = (code: number): boolean => code >= 65 && code <= 90;
const isLowerCode = (code: number): boolean => code >= 97 && code <= 122;
const isDigitCode = (code: number): boolean => code >= 48 && code <= 57;
const isWordCode = (code: number): boolean => isUpperCode(code) || isLowerCode(code) || isDigitCode(code);

/** Reference implementation path for the rare case where Unicode lowercasing
 * changes string length. It compares one query term while walking identifier
 * segments, allocating neither substrings nor a Set. */
function hasSubwordStreaming(name: string, low: string): boolean {
  let start = -1;
  for (let i = 0; i <= name.length; i++) {
    const code = i < name.length ? name.charCodeAt(i) : -1;
    if (!isWordCode(code)) {
      if (start !== -1 && sameLowerAscii(name, start, i, low)) return true;
      start = -1;
      continue;
    }
    if (start === -1) {
      start = i;
      continue;
    }
    const prev = name.charCodeAt(i - 1);
    const next = i + 1 < name.length ? name.charCodeAt(i + 1) : -1;
    const boundary = isUpperCode(code) && (isLowerCode(prev) || isDigitCode(prev) || (isUpperCode(prev) && isLowerCode(next)));
    if (boundary) {
      if (sameLowerAscii(name, start, i, low)) return true;
      start = i;
    }
  }
  return false;
}

function sameLowerAscii(name: string, start: number, end: number, low: string): boolean {
  if (end - start !== low.length) return false;
  for (let i = 0; i < low.length; i++) {
    let code = name.charCodeAt(start + i);
    if (isUpperCode(code)) code += 32;
    if (code !== low.charCodeAt(i)) return false;
  }
  return true;
}

/** Pack a normal short identifier's segment boundaries into one 31-bit scalar.
 * Later terms test it in O(1), retaining no arrays/Sets. Long names stream. */
function subwordBoundaryMask(name: string): number | null {
  if (name.length > 30) return null;
  let mask = 0;
  let start = -1;
  for (let i = 0; i <= name.length; i++) {
    const code = i < name.length ? name.charCodeAt(i) : -1;
    if (!isWordCode(code)) {
      if (start !== -1) {
        mask |= 1 << i;
      }
      start = -1;
      continue;
    }
    if (start === -1) {
      start = i;
      mask |= 1 << i;
      continue;
    }
    const prev = name.charCodeAt(i - 1);
    const next = i + 1 < name.length ? name.charCodeAt(i + 1) : -1;
    if (isUpperCode(code) && (isLowerCode(prev) || isDigitCode(prev) || (isUpperCode(prev) && isLowerCode(next)))) {
      mask |= 1 << i;
      start = i;
    }
  }
  return mask;
}

function isMaskedSubword(mask: number, start: number, end: number): boolean {
  if ((mask & (1 << start)) === 0 || (mask & (1 << end)) === 0) return false;
  if (end <= start + 1) return true;
  const belowEnd = (1 << end) - 1;
  const throughStart = (1 << (start + 1)) - 1;
  return (mask & belowEnd & ~throughStart) === 0;
}

/** Test one lowercased query term against camel/snake/kebab segments. Built-in
 * `indexOf` narrows the work to actual occurrences; boundary checks preserve the
 * old splitter's acronym and camel-case rules without retaining a Set per entry. */
function hasSubword(name: string, nameLow: string, low: string, firstAt: number, normalized: SearchEntry): boolean {
  if (name.length !== nameLow.length) return hasSubwordStreaming(name, low);
  const mask = normalized.wordMask === undefined ? (normalized.wordMask = subwordBoundaryMask(name)) : normalized.wordMask;
  if (mask === null) return hasSubwordStreaming(name, low);
  for (let at = firstAt; at !== -1; at = nameLow.indexOf(low, at + 1)) {
    if (isMaskedSubword(mask, at, at + low.length)) return true;
  }
  return false;
}

/** Normalize immutable entry text lazily during the first scan, then reuse it. */
function searchTable(index: MapIndex): SearchTable {
  let table = searchTables.get(index);
  if (!table) {
    const entries: (SearchEntry | undefined)[] = [];
    entries.length = index.entries.length;
    table = { entries };
    searchTables.set(index, table);
  }
  return table;
}

/** Same total order used by the old full-array sort: negative means `a` wins. */
function compareScored(a: Scored, b: Scored): number {
  return (
    b.tier - a.tier ||
    b.matched - a.matched ||
    b.kindPrior - a.kindPrior ||
    b.fanIn - a.fanIn ||
    a.lenPen - b.lenPen ||
    a.entry.file.localeCompare(b.entry.file) ||
    a.entry.line - b.entry.line
  );
}

function toHits(scored: Scored[]): LocateHit[] {
  return scored.map((s) => ({
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

function resultCacheKey(query: string, opts: LocateOptions, limit: number): string {
  const kind = opts.kind ?? '';
  const file = opts.file ?? '';
  return `${limit}:${kind.length}:${kind}:${file.length}:${file}:${query}`;
}

function cachedResult(index: MapIndex, key: string): Scored[] | undefined {
  const cache = resultCaches.get(index);
  const found = cache?.get(key);
  if (!cache || !found) return undefined;
  cache.delete(key);
  cache.set(key, found);
  return found;
}

function rememberResult(index: MapIndex, key: string, scored: Scored[]): void {
  let cache = resultCaches.get(index);
  if (!cache) resultCaches.set(index, (cache = new Map()));
  cache.set(key, scored);
  if (cache.size > RESULT_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Keep only the best K candidates in a worst-at-root heap. For the normal
 * K=20 route this is O(entries), instead of sorting every match O(N log N). */
function offerTop(heap: Scored[], value: Scored, limit: number): void {
  if (heap.length < limit) {
    heap.push(value);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (compareScored(heap[i], heap[parent]) <= 0) break;
      const swap = heap[i];
      heap[i] = heap[parent];
      heap[parent] = swap;
      i = parent;
    }
    return;
  }
  if (compareScored(value, heap[0]) >= 0) return;
  heap[0] = value;
  let i = 0;
  for (;;) {
    const left = i * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worse = left;
    if (right < heap.length && compareScored(heap[right], heap[left]) > 0) worse = right;
    if (compareScored(heap[worse], heap[i]) <= 0) return;
    const swap = heap[i];
    heap[i] = heap[worse];
    heap[worse] = swap;
    i = worse;
  }
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
function locateScored(index: MapIndex, query: string, opts: LocateOptions = {}): Scored[] {
  const requestedLimit = opts.limit ?? 20;
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.trunc(requestedLimit)) : index.entries.length;
  if (limit === 0) return [];
  const cacheKey = limit <= RESULT_CACHE_MAX_HITS ? resultCacheKey(query, opts, limit) : '';
  if (cacheKey) {
    const cached = cachedResult(index, cacheKey);
    if (cached) return cached;
  }
  let namePart = query.trim();
  let filePart = opts.file ?? '';
  let pathScope = '';

  const hash = namePart.lastIndexOf('#');
  if (hash !== -1) {
    pathScope = namePart.slice(0, hash).trim();
    filePart = pathScope || filePart.trim();
    namePart = namePart.slice(hash + 1).trim();
  }

  // Embedded path#name syntax denotes a scope when it names an exact v13 file.
  // File fragments and the explicit `opts.file` substring filter retain their
  // broader scan semantics.
  const fileRange = pathScope ? exactFileEntryRange(index, pathScope) : undefined;
  const exactFile = fileRange ? pathScope : '';
  const fileNeedle = filePart.toLowerCase();
  const kindNeedle = (opts.kind ?? '').toLowerCase();
  const terms = queryTerms(namePart);
  const verbQuery = terms.some((t) => ACTION.has(t.low));

  const scored: Scored[] = []; // bounded to `limit` by offerTop
  // A prepared long-lived index can answer an authoritative case-sensitive
  // exact-name query without scanning fuzzy candidates. Exact hits outrank every
  // other tier, so returning just that tier is both cheaper and less noisy.
  const exactBucket = getPreparedLookup(index)?.byName.get(namePart);
  if (exactBucket) {
    const exactNamed = Array.isArray(exactBucket) ? exactBucket : [exactBucket];
    for (const entry of exactNamed) {
      if (exactFile ? entry.file !== exactFile : fileNeedle && !entry.file.toLowerCase().includes(fileNeedle)) continue;
      if (kindNeedle && !entry.kind.toLowerCase().includes(kindNeedle)) continue;
      const kindPrior = verbQuery ? (FN_KINDS.has(entry.kind) ? 1 : TYPE_KINDS.has(entry.kind) ? -1 : 0) : 0;
      offerTop(scored, { entry, tier: 100, match: 'exact', matched: terms.length, kindPrior, lenPen: 0, fanIn: entry.fanIn ?? 0 }, limit);
    }
    if (scored.length) {
      scored.sort(compareScored);
      if (cacheKey) rememberResult(index, cacheKey, scored);
      return scored;
    }
  }

  const normalizedEntries = searchTable(index).entries;
  const start = fileRange?.start ?? 0;
  const end = fileRange?.end ?? index.entries.length;
  for (let i = start; i < end; i++) {
    const e = index.entries[i];
    const normalized = normalizedEntries[i] ??= {};
    if (!exactFile && fileNeedle && !(normalized.fileLow ??= e.file.toLowerCase()).includes(fileNeedle)) continue;
    if (kindNeedle && !(normalized.kindLow ??= e.kind.toLowerCase()).includes(kindNeedle)) continue;

    if (terms.length === 0) {
      offerTop(scored, { entry: e, tier: 1, match: 'any', matched: 0, kindPrior: 0, lenPen: 0, fanIn: e.fanIn ?? 0 }, limit);
      continue;
    }

    let best = 0;
    let matched = 0;
    const nameLow = normalized.nameLow ??= e.name.toLowerCase();
    for (const t of terms) {
      const tier = termTier(e.name, nameLow, normalized, t);
      if (tier > 0) matched++;
      if (tier > best) best = tier;
    }
    if (best === 0) continue;

    let kindPrior = 0;
    if (verbQuery) kindPrior = FN_KINDS.has(e.kind) ? 1 : TYPE_KINDS.has(e.kind) ? -1 : 0;

    offerTop(
      scored,
      { entry: e, tier: best, match: tierLabel(best), matched, kindPrior, lenPen: lengthPenalty(e.name, namePart), fanIn: e.fanIn ?? 0 },
      limit,
    );
  }

  scored.sort(compareScored);
  if (cacheKey) rememberResult(index, cacheKey, scored);

  return scored;
}

export function locate(index: MapIndex, query: string, opts: LocateOptions = {}): LocateHit[] {
  return toHits(locateScored(index, query, opts));
}

/** Locate plus the already-scored entry objects. Read resolution uses this to
 * avoid scanning the whole index again merely to turn a winning id back into
 * the entry that produced it. */
export function locateWithEntries(index: MapIndex, query: string, opts: LocateOptions = {}): LocatedResult {
  const scored = locateScored(index, query, opts);
  return { hits: toHits(scored), entries: scored.map((item) => item.entry) };
}

function termTier(name: string, nl: string, normalized: SearchEntry, t: Term): number {
  if (name === t.raw) return 100;
  if (nl === t.low) return 92;
  const at = nl.indexOf(t.low);
  if (at !== -1) {
    if (hasSubword(name, nl, t.low, at, normalized)) return 80; // whole subword: "diff" in computeDiff
    if (at === 0) return 70;
    return 50;
  }
  if (t.low.length >= 3 && isSubsequence(t.low, nl)) return 30;
  return 0;
}

function tierLabel(tier: number): string {
  switch (tier) {
    case 100: return 'exact';
    case 92: return 'ci-exact';
    case 80: return 'word';
    case 70: return 'prefix';
    case 50: return 'substring';
    case 30: return 'fuzzy';
    default: return '';
  }
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
