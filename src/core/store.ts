import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { ORDERED_ENTRIES_VERSION, type MapEntry, type MapIndex } from './types.ts';

export const DEFAULT_INDEX_PATH = '.map-index.json';

export type NameBucket = MapEntry | MapEntry[];

export interface LookupTables {
  byId: Map<string, MapEntry>;
  byName: Map<string, NameBucket>;
}

export interface FileEntryRange {
  /** Inclusive entry offset. */
  start: number;
  /** Exclusive entry offset. */
  end: number;
}

interface SiblingTables {
  orderedById: Map<string, number | undefined>;
  byFile: Map<string, Map<string, number>>;
}

const lookupTables = new WeakMap<MapIndex, LookupTables>();
const siblingTables = new WeakMap<MapIndex, SiblingTables>();

/** Build exact id/name lookup tables for a long-lived index. This is deliberately
 * opt-in: a one-shot CLI command should not pay O(entries) allocation merely to
 * inspect stats or resolve one ref. The MCP server warms it after loading. */
export function prepareLookup(index: MapIndex): LookupTables {
  const cached = lookupTables.get(index);
  if (cached) return cached;
  const byId = new Map<string, MapEntry>();
  const byName = new Map<string, NameBucket>();
  for (const entry of index.entries) {
    byId.set(entry.id, entry);
    const named = byName.get(entry.name);
    if (!named) byName.set(entry.name, entry);
    else if (Array.isArray(named)) named.push(entry);
    else byName.set(entry.name, [named, entry]);
  }
  const tables = { byId, byName };
  lookupTables.set(index, tables);
  return tables;
}

/** Return lookup tables only when a long-lived caller prepared them already. */
export function getPreparedLookup(index: MapIndex): LookupTables | undefined {
  return lookupTables.get(index);
}

/** Locate one exact file's contiguous entry range without persisting a
 * file->range table. Format v13's global file order makes this O(log entries)
 * with zero index bytes and zero warm-cache retention. A missing/legacy range
 * returns undefined so callers can preserve their broader fallback semantics. */
export function exactFileEntryRange(index: MapIndex, file: string): FileEntryRange | undefined {
  if (!file || index.meta.version < ORDERED_ENTRIES_VERSION) return undefined;
  const entries = index.entries;
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].file < file) lo = mid + 1;
    else hi = mid;
  }
  if (entries[lo]?.file !== file) return undefined;
  const start = lo;
  hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].file <= file) lo = mid + 1;
    else hi = mid;
  }
  return { start, end: lo };
}

/** Find the next distinct symbol line in the same file. Current indexes are
 * globally file/line ordered: first access is O(log entries), then only that
 * requested id is memoized for O(1) repeats. Older indexes did not guarantee
 * order; only their requested file is scanned/cached, avoiding the old eager
 * O(entries) boundary map in memory. */
export function nextSiblingLine(index: MapIndex, entry: MapEntry): number | undefined {
  let cached = siblingTables.get(index);
  if (!cached) {
    cached = { orderedById: new Map(), byFile: new Map() };
    siblingTables.set(index, cached);
  }
  if (index.meta.version >= ORDERED_ENTRIES_VERSION) {
    if (cached.orderedById.has(entry.id)) return cached.orderedById.get(entry.id);
    let lo = 0;
    let hi = index.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const candidate = index.entries[mid];
      if (candidate.file < entry.file || (candidate.file === entry.file && candidate.line <= entry.line)) lo = mid + 1;
      else hi = mid;
    }
    const next = index.entries[lo];
    const nextLine = next?.file === entry.file ? next.line : undefined;
    cached.orderedById.set(entry.id, nextLine);
    return nextLine;
  }

  const known = cached.byFile.get(entry.file);
  if (known) return known.get(entry.id);

  const siblings: MapEntry[] = [];
  for (const candidate of index.entries) if (candidate.file === entry.file) siblings.push(candidate);
  const nextLineById = new Map<string, number>();
  siblings.sort((a, b) => a.line - b.line);
  for (let i = 0; i < siblings.length;) {
    let next = i + 1;
    while (next < siblings.length && siblings[next].line === siblings[i].line) next++;
    if (next < siblings.length) {
      const nextLine = siblings[next].line;
      for (let j = i; j < next; j++) nextLineById.set(siblings[j].id, nextLine);
    }
    i = next;
  }
  cached.byFile.set(entry.file, nextLineById);
  return nextLineById.get(entry.id);
}

/** Write atomically: a temp file in the same dir, then rename (atomic on POSIX),
 * so an interrupted write never leaves a truncated index on disk. If the rename
 * fails, the temp file is removed (the `*.tmp` name is also gitignored, covering
 * a hard kill before cleanup). */
export function saveIndex(index: MapIndex, path = DEFAULT_INDEX_PATH): void {
  const indexPath = resolve(path);
  const rootRelativeToIndex = relative(dirname(indexPath), resolve(index.meta.root)).replaceAll('\\', '/') || '.';
  const persisted: MapIndex = { ...index, meta: { ...index.meta, rootRelativeToIndex } };
  const tmp = `${indexPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(persisted, null, 0));
  try {
    renameSync(tmp, indexPath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw e;
  }
}

export function loadIndex(path = DEFAULT_INDEX_PATH): MapIndex {
  const indexPath = resolve(path);
  const idx = JSON.parse(readFileSync(indexPath, 'utf8')) as MapIndex;
  if (idx?.meta?.tool !== 'code-map') {
    throw new Error(`${path} is not a code-map index.`);
  }
  const relativeRoot = idx.meta.rootRelativeToIndex;
  if (typeof relativeRoot === 'string') {
    const candidate = resolve(dirname(indexPath), relativeRoot);
    if (existsSync(candidate)) idx.meta.root = candidate;
  } else if (!existsSync(idx.meta.root) && basename(indexPath) === DEFAULT_INDEX_PATH) {
    // Legacy indexes stored only an absolute root. At the conventional location,
    // the index file's containing directory is the source root.
    idx.meta.root = dirname(indexPath);
  }
  return idx;
}
