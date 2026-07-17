import { realpathSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { extractSymbols, isPython, type SymbolRec } from './extract-symbols.ts';
import { type LocatedResult, locateWithEntries } from './locate.ts';
import type { MapEntry, MapIndex, ReadResult } from './types.ts';
import {
  buildLineIndex,
  indexedLineAt,
  indexedOffsetOfLine,
  indexOfAll,
  type LineIndex,
  token,
  tryReadFile,
} from './util.ts';
import {
  exactFileEntryRange,
  type FileEntryRange,
  getPreparedLookup,
  nextSiblingLine,
  qualifiedSymbolRef,
} from './store.ts';

/**
 * Resolve `relFile` under `root`, refusing anything that escapes it — a `..`
 * traversal or a symlink pointing outside. An index is untrusted input (it can be
 * committed in a downloaded repo), so a malicious `entry.file` must not make the
 * server read outside the project root. Returns the absolute path, or null to refuse.
 */
function fileWithinRoot(
  rootAbs: string,
  realRoot: string | null,
  relFile: string,
): string | null {
  const target = resolvePath(rootAbs, relFile);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null; // lexical containment
  try {
    const real = realpathSync(target);
    const currentRealRoot = realRoot ?? realpathSync(rootAbs);
    if (real !== currentRealRoot && !real.startsWith(currentRealRoot + sep)) {
      return null;
    } // symlink escape
  } catch {
    /* not yet on disk — the lexical check already held */
  }
  return target;
}

const ANCHOR_PREVIEW_LENGTH = 60;
const MAX_AMBIGUOUS_CANDIDATES = 12;
const SOURCE_PREVIEW_LENGTH = 120;

interface FileSnapshot {
  text: string | null;
  fresh: boolean;
  refused: boolean;
  lines: LineIndex | null;
  contentToken: string | null;
  currentSymbols?: SymbolRec[] | null;
}

type FileCache = Map<string, FileSnapshot>;

interface RuntimeState {
  linesByFile: Map<string, { token: string; lines: LineIndex }>;
  rootAbs: string;
  realRoot: string | null;
}

interface ReadContext {
  files: FileCache;
  resolvedRefs: Map<string, MapEntry | null>;
  locatedRefs: Map<string, LocatedResult>;
  exactChecked: Set<string>;
}

const runtimeStates = new WeakMap<MapIndex, RuntimeState>();

function exactFileFromRef(ref: string): string | undefined {
  const hash = ref.indexOf('#');
  return hash > 0 ? ref.slice(0, hash) : undefined;
}

function hasIndexedFile(index: MapIndex, file: string): boolean {
  if (Object.hasOwn(index.fileTokens, file)) return true;
  if (exactFileEntryRange(index, file)) return true;
  // Legacy/unordered indexes cannot use the range lookup. Keep strict read
  // semantics without imposing this scan on current indexes.
  return index.entries.some((entry) => entry.file === file);
}

function qualifiedEntryInRange(
  index: MapIndex,
  ref: string,
  range: FileEntryRange,
): MapEntry | null {
  let found: MapEntry | null = null;
  for (let i = range.start; i < range.end; i++) {
    const entry = index.entries[i];
    if (qualifiedSymbolRef(entry) !== ref) continue;
    if (found) return null;
    found = entry;
  }
  return found;
}

function stateFor(index: MapIndex): RuntimeState {
  const cached = runtimeStates.get(index);
  if (cached) return cached;
  const rootAbs = resolvePath(index.meta.root);
  let realRoot: string | null = null;
  try {
    realRoot = realpathSync(rootAbs);
  } catch {
    /* root may appear later */
  }
  const tables = {
    linesByFile: new Map<string, { token: string; lines: LineIndex }>(),
    rootAbs,
    realRoot,
  };
  runtimeStates.set(index, tables);
  return tables;
}

/** Seed exact id/name resolutions for a one-shot batch with one index pass. This
 * keeps CLI batch work O(entries + refs) without allocating a persistent full
 * lookup table. Fuzzy misses still fall through to locate individually. */
function contextFor(index: MapIndex, refs: string[] = []): ReadContext {
  const context: ReadContext = {
    files: new Map(),
    resolvedRefs: new Map(),
    locatedRefs: new Map(),
    exactChecked: new Set(),
  };
  if (refs.length <= 1 || getPreparedLookup(index)) return context;

  const needed = new Set(refs);
  const byExactRef = new Map<string, MapEntry | null>();
  const byName = new Map<string, MapEntry | null>();
  const rangesByFile = new Map<string, FileEntryRange | undefined>();
  const scoped = new Map<
    string,
    { range: FileEntryRange; refs: Set<string> }
  >();
  let requiresFullScan = false;
  for (const ref of needed) {
    const file = exactFileFromRef(ref);
    if (!file) {
      requiresFullScan = true;
      break;
    }
    let range: FileEntryRange | undefined;
    if (rangesByFile.has(file)) {
      range = rangesByFile.get(file);
    } else {
      range = exactFileEntryRange(index, file);
      rangesByFile.set(file, range);
    }
    if (!range) {
      requiresFullScan = true;
      break;
    }
    const group = scoped.get(file);
    if (group) group.refs.add(ref);
    else scoped.set(file, { range, refs: new Set([ref]) });
  }

  const inspect = (entry: MapEntry, wanted: Set<string>): void => {
    const rememberExact = (candidate: string | undefined): void => {
      if (!candidate || !wanted.has(candidate)) return;
      if (byExactRef.has(candidate)) byExactRef.set(candidate, null);
      else byExactRef.set(candidate, entry);
    };
    rememberExact(entry.id);
    rememberExact(qualifiedSymbolRef(entry));
    if (wanted.has(entry.name)) {
      if (byName.has(entry.name)) byName.set(entry.name, null);
      else byName.set(entry.name, entry);
    }
  };
  if (requiresFullScan) {
    for (const entry of index.entries) inspect(entry, needed);
  } else {
    for (const { range, refs: wanted } of scoped.values()) {
      for (let i = range.start; i < range.end; i++) {
        inspect(index.entries[i], wanted);
      }
    }
  }
  for (const ref of needed) {
    context.exactChecked.add(ref);
    if (byExactRef.has(ref)) {
      context.resolvedRefs.set(ref, byExactRef.get(ref) ?? null);
    } else if (byName.has(ref)) {
      context.resolvedRefs.set(ref, byName.get(ref) ?? null);
    }
  }
  return context;
}

function snapshotFor(
  index: MapIndex,
  file: string,
  cache: FileCache,
): FileSnapshot {
  const cached = cache.get(file);
  if (cached) return cached;
  const { rootAbs, realRoot } = stateFor(index);
  const path = fileWithinRoot(rootAbs, realRoot, file);
  const text = path == null ? null : tryReadFile(path);
  const contentToken = text == null ? null : token(text);
  const snapshot = {
    text,
    fresh: contentToken != null && contentToken === index.fileTokens[file],
    refused: path == null,
    lines: null,
    contentToken,
  };
  cache.set(file, snapshot);
  return snapshot;
}

function linesFor(
  index: MapIndex,
  file: string,
  snapshot: FileSnapshot,
): LineIndex {
  if (snapshot.lines) return snapshot.lines;
  const state = stateFor(index);
  if (snapshot.contentToken) {
    const cached = state.linesByFile.get(file);
    if (cached?.token === snapshot.contentToken) {
      snapshot.lines = cached.lines;
      return cached.lines;
    }
  }
  snapshot.lines = buildLineIndex(snapshot.text ?? '');
  if (snapshot.contentToken) {
    state.linesByFile.set(file, {
      token: snapshot.contentToken,
      lines: snapshot.lines,
    });
  }
  return snapshot.lines;
}

/** Recover a dirty TS/JS symbol's current AST boundary. The unchanged path never
 * pays this parse cost, and refs are deliberately skipped because read only needs
 * coordinates. If the current parse cannot identify one target, the caller uses
 * an honest non-truncating fallback instead of pretending its boundary is exact. */
function relocatedSymbolRange(
  entry: MapEntry,
  snapshot: FileSnapshot,
  anchoredStart: number,
): { start: number; end: number } | null {
  const text = snapshot.text;
  if (text == null || isPython(entry.file)) return null;
  if (snapshot.currentSymbols === undefined) {
    try {
      snapshot.currentSymbols = extractSymbols(entry.file, text, {
        includeRefs: false,
      }).symbols;
    } catch {
      snapshot.currentSymbols = null;
    }
  }
  let match: SymbolRec | null = null;
  for (const symbol of snapshot.currentSymbols ?? []) {
    if (
      symbol.charStart !== anchoredStart ||
      symbol.name !== entry.name ||
      symbol.kind !== entry.kind ||
      symbol.className !== entry.className
    ) {
      continue;
    }
    if (match) return null;
    match = symbol;
  }
  return match ? { start: match.charStart, end: match.charEnd } : null;
}

/** When a current AST boundary is unavailable (Python or a half-written JS/TS
 * file), stop at the next declaration that was outside the symbol's old range.
 * Class methods therefore do not truncate their containing class. If every
 * later anchor also drifted, EOF is the only non-truncating honest fallback. */
function fallbackRelocatedEnd(
  index: MapIndex,
  entry: MapEntry,
  text: string,
  anchoredStart: number,
): number {
  const range = exactFileEntryRange(index, entry.file);
  if (range && entry.charEnd != null) {
    for (let offset = range.start; offset < range.end; offset++) {
      const candidate = index.entries[offset];
      if (
        candidate.id === entry.id ||
        candidate.charStart == null ||
        candidate.charStart < entry.charEnd
      ) {
        continue;
      }
      const first = text.indexOf(candidate.searchText, anchoredStart + 1);
      if (first === -1) return text.length;
      const duplicate = text.indexOf(
        candidate.searchText,
        first + candidate.searchText.length,
      );
      return duplicate === -1 ? first : text.length;
    }
  }
  return text.length;
}

/**
 * Hand back the raw bytes at a routed location — the evidence the LLM judges.
 * With `opts.snippet`, also act as a sub-symbol designator: resolve the quoted
 * snippet to exact char range(s) INSIDE the symbol (extending the drift logic —
 * searchText/indexOfAll — to an arbitrary span), so a fix lands on the bug line,
 * not the whole function. Folded into `read` rather than a separate tool: the
 * snippet is just a finer coordinate on the same "give me the bytes here" call.
 */
export function read(
  index: MapIndex,
  ref: string,
  opts: { snippet?: string } = {},
): ReadResult {
  const context = contextFor(index);
  const result = readCore(index, ref, context);
  if (opts.snippet) {
    const entry = resolve(index, ref, context);
    if (entry) {
      result.aim = computeAim(index, entry, opts.snippet, context.files);
    }
  }
  return result;
}

/** Read a batch while sharing file snapshots. Several symbols in one source file
 * now pay for containment, disk I/O, and hashing once rather than once per ref. */
export function readMany(index: MapIndex, refs: string[]): ReadResult[] {
  const context = contextFor(index, refs);
  return refs.map((ref) => readCore(index, ref, context));
}

/**
 * Resolve a snippet to its char range(s) WITHIN the symbol's own bytes — never the
 * whole file. If the file changed, re-anchor on the signature line and confine the
 * search to the relocated range; if the symbol can't be re-confined, return
 * `unanchored` (a whole-file search could match an identical snippet in a *different*
 * symbol and falsely report `hit`). `ambiguous` when the snippet occurs >1× inside.
 */
function computeAim(
  index: MapIndex,
  entry: MapEntry,
  snippet: string,
  cache: FileCache,
): ReadResult['aim'] {
  const snapshot = snapshotFor(index, entry.file, cache);
  const { text, fresh } = snapshot;
  if (text == null) return { status: 'unanchored', matches: [] };

  // Establish the symbol's byte range [lo, hi) — and refuse to guess past it.
  let lo: number;
  let hi: number;
  if (fresh && entry.charStart != null && entry.charEnd != null) {
    lo = entry.charStart;
    hi = entry.charEnd;
  } else if (entry.charStart != null && entry.charEnd != null) {
    // File changed: re-anchor on the signature line, then recover the current AST
    // boundary so a longer body does not get truncated by the indexed length.
    const hits = indexOfAll(text, entry.searchText);
    if (hits.length !== 1) return { status: 'unanchored', matches: [] };
    const current = relocatedSymbolRange(entry, snapshot, hits[0]);
    lo = current?.start ?? hits[0];
    hi = current?.end ?? fallbackRelocatedEnd(index, entry, text, hits[0]);
  } else {
    // Line-only symbol (no char range): bound by the next indexed sibling or EOF.
    const lines = linesFor(index, entry.file, snapshot);
    let startLine = entry.line;
    if (!fresh) {
      const hits = indexOfAll(text, entry.searchText);
      if (hits.length !== 1) return { status: 'unanchored', matches: [] };
      startLine = indexedLineAt(lines, hits[0]);
    }
    const range = lineOnlyRange(index, entry, snapshot, startLine);
    lo = range.from;
    hi = range.to;
  }

  const local = indexOfAll(text, snippet, lo, hi);
  if (!local.length) return { status: 'not-in-symbol', matches: [] };
  const lines = linesFor(index, entry.file, snapshot);
  const matches = local.map((at) => {
    return {
      line: indexedLineAt(lines, at),
      charStart: at,
      charEnd: at + snippet.length,
    };
  });
  return { status: matches.length > 1 ? 'ambiguous' : 'hit', matches };
}

/**
 * Working-set drift delta — "git status for the agent's reads". Given the symbols an agent
 * read earlier (`refs`), report which are UNCHANGED vs which CHANGED since the index, and
 * return the current slice ONLY for the changed ones. Cheap: the per-file content token is
 * checked once per file (not per symbol), so a stable file skips all its symbols with no
 * slice work. Conservative + correct: a symbol is "unchanged" only if its whole file's token
 * still matches (no false negatives — if the symbol moved, its file changed → it's CHANGED).
 * The point: in a long session most of the working set sits in untouched files, so the agent
 * refreshes only the delta instead of re-reading everything.
 */
export function changed(
  index: MapIndex,
  refs: string[],
): {
  unchanged: string[];
  changed: ReadResult[];
  filesChecked: number;
  filesChanged: number;
} {
  const unchanged: string[] = [];
  const changedOut: ReadResult[] = [];
  const context = contextFor(index, refs);
  const filesChecked = new Set<string>();
  for (const ref of refs) {
    const entry = resolve(index, ref, context);
    if (!entry) {
      changedOut.push(readCore(index, ref, context)); // unresolved/renamed → surface it as a delta
      continue;
    }
    filesChecked.add(entry.file);
    if (snapshotFor(index, entry.file, context.files).fresh) {
      unchanged.push(entry.id);
    } else {
      changedOut.push(readCore(index, ref, context));
    } // file moved → re-anchor + current slice
  }
  let filesChanged = 0;
  for (const file of filesChecked) {
    if (!snapshotFor(index, file, context.files).fresh) filesChanged++;
  }
  return {
    unchanged,
    changed: changedOut,
    filesChecked: filesChecked.size,
    filesChanged,
  };
}

function readCore(
  index: MapIndex,
  ref: string,
  context: ReadContext,
): ReadResult {
  const entry = resolve(index, ref, context);
  if (!entry) {
    const { hits } = locatedFor(index, ref, context);
    const candidates = hits.map((hit) => ({
      line: hit.line,
      preview: `${hit.id}${hit.namePath ? ` (alias: ${hit.file}#${hit.namePath})` : ''}  ·  ${hit.signature}`,
    }));
    if (hits.length) {
      return {
        status: 'ambiguous',
        id: ref,
        file: '',
        line: 0,
        raw: null,
        note: `"${ref}" did not resolve to one symbol. Pick an id from the candidates.`,
        candidates,
      };
    }
    return {
      status: 'not-found',
      id: ref,
      file: '',
      line: 0,
      raw: null,
      note: `No symbol matches "${ref}".`,
      candidates: [],
    };
  }

  const snapshot = snapshotFor(index, entry.file, context.files);
  const { text, fresh, refused } = snapshot;
  if (refused) {
    return {
      status: 'not-found',
      id: entry.id,
      file: entry.file,
      line: entry.line,
      raw: null,
      note: `Refused: "${entry.file}" resolves outside the index root.`,
    };
  }
  if (text == null) {
    return {
      status: 'not-found',
      id: entry.id,
      file: entry.file,
      line: entry.line,
      raw: null,
      note: `File not readable: ${entry.file}`,
    };
  }

  // 1 — coordinates still trustworthy.
  if (fresh) {
    if (entry.charStart != null && entry.charEnd != null) {
      const raw = text.slice(entry.charStart, entry.charEnd);
      const endLine =
        entry.endLine ??
        indexedLineAt(linesFor(index, entry.file, snapshot), entry.charEnd);
      return {
        status: 'exact',
        id: entry.id,
        file: entry.file,
        line: entry.line,
        endLine,
        raw,
      };
    }
    return sliceLineWindow(index, entry, snapshot, 'exact');
  }

  // 2 — file changed: re-anchor on the signature line.
  const hits = indexOfAll(text, entry.searchText);
  if (hits.length === 1) {
    const anchoredStart = hits[0];
    const start = Math.max(0, anchoredStart - (entry.anchorOffset ?? 0));
    const lines = linesFor(index, entry.file, snapshot);
    const startLine = indexedLineAt(lines, start);
    if (entry.charStart != null && entry.charEnd != null) {
      const current = relocatedSymbolRange(entry, snapshot, anchoredStart);
      const end =
        current?.end ?? fallbackRelocatedEnd(index, entry, text, anchoredStart);
      const raw = text.slice(start, end);
      return {
        status: 'relocated',
        id: entry.id,
        file: entry.file,
        line: startLine,
        endLine: indexedLineAt(lines, end),
        raw,
        note: current
          ? 'File changed since indexing. Re-anchored on the signature line and refreshed the symbol boundary from the current AST.'
          : 'File changed since indexing. Re-anchored on the signature line; the end boundary is best-effort — verify it covers the whole symbol.',
      };
    }
    return sliceLineWindow(
      index,
      entry,
      snapshot,
      'relocated',
      'File changed since indexing; re-anchored by signature line.',
      startLine,
    );
  }

  if (hits.length > 1) {
    const lines = linesFor(index, entry.file, snapshot);
    return {
      status: 'ambiguous',
      id: entry.id,
      file: entry.file,
      line: entry.line,
      raw: null,
      note: `File changed; the anchor "${entry.searchText.slice(0, ANCHOR_PREVIEW_LENGTH)}" now matches ${hits.length} sites. Inspect candidates.`,
      candidates: hits.slice(0, MAX_AMBIGUOUS_CANDIDATES).map((off) => ({
        line: indexedLineAt(lines, off),
        preview: previewAt(text, off, lines),
      })),
    };
  }

  // 3 — anchor gone: the symbol moved or was renamed beyond recovery.
  return {
    status: 'anchor-lost',
    id: entry.id,
    file: entry.file,
    line: entry.line,
    raw: null,
    note: `File changed and the signature anchor "${entry.searchText.slice(0, ANCHOR_PREVIEW_LENGTH)}" is no longer present — the symbol was renamed or removed. Re-run \`map index\` to refresh coordinates.`,
  };
}

/** Resolve a ref to one entry: exact id, else an unambiguous locate top hit. */
function resolve(
  index: MapIndex,
  ref: string,
  context: ReadContext,
): MapEntry | null {
  if (context.resolvedRefs.has(ref)) {
    return context.resolvedRefs.get(ref) ?? null;
  }

  const lookup = getPreparedLookup(index);
  if (lookup) {
    const exact = lookup.byId.get(ref);
    if (exact) {
      context.resolvedRefs.set(ref, exact);
      return exact;
    }
    const file = exactFileFromRef(ref);
    const range = file ? exactFileEntryRange(index, file) : undefined;
    if (range) {
      const qualified = qualifiedEntryInRange(index, ref, range);
      context.resolvedRefs.set(ref, qualified);
      return qualified;
    }
    if (file && hasIndexedFile(index, file)) {
      context.resolvedRefs.set(ref, null);
      return null;
    }
    const named = lookup.byName.get(ref);
    if (named) {
      if (Array.isArray(named)) {
        context.resolvedRefs.set(ref, null);
        return null;
      }
      context.resolvedRefs.set(ref, named);
      return named;
    }
  } else if (!context.exactChecked.has(ref)) {
    let named: MapEntry | null = null;
    let nameAmbiguous = false;
    let qualified: MapEntry | null = null;
    let qualifiedAmbiguous = false;
    const file = exactFileFromRef(ref);
    const range = file ? exactFileEntryRange(index, file) : undefined;
    const start = range?.start ?? 0;
    const end = range?.end ?? index.entries.length;
    for (let i = start; i < end; i++) {
      const entry = index.entries[i];
      if (entry.id === ref) {
        context.resolvedRefs.set(ref, entry);
        return entry;
      }
      if (qualifiedSymbolRef(entry) === ref) {
        if (qualified) qualifiedAmbiguous = true;
        else qualified = entry;
      }
      if (entry.name === ref) {
        if (named) nameAmbiguous = true;
        else named = entry;
      }
    }
    if (qualifiedAmbiguous) {
      context.resolvedRefs.set(ref, null);
      return null;
    }
    if (qualified) {
      context.resolvedRefs.set(ref, qualified);
      return qualified;
    }
    if (nameAmbiguous) {
      context.resolvedRefs.set(ref, null);
      return null;
    }
    if (named) {
      context.resolvedRefs.set(ref, named);
      return named;
    }
  }

  // A repository-relative `path#name` is an exact read contract when `path`
  // names an indexed file. Fuzzy discovery remains available through locate(),
  // but read() must never promote a different leaf to an exact source slice.
  const explicitFile = exactFileFromRef(ref);
  if (explicitFile && hasIndexedFile(index, explicitFile)) {
    context.resolvedRefs.set(ref, null);
    return null;
  }

  const located = locatedFor(index, ref, context);
  const { hits } = located;
  let resolved: MapEntry | null = null;
  if (hits.length === 1) resolved = located.entries[0] ?? null;
  if (hits.length >= 2 && hits[0].score > hits[1].score) {
    resolved = located.entries[0] ?? null;
  }
  context.resolvedRefs.set(ref, resolved);
  return resolved;
}

function lineOnlyRange(
  index: MapIndex,
  entry: MapEntry,
  snapshot: FileSnapshot,
  startLine: number,
): { from: number; to: number; endLine: number } {
  const lines = linesFor(index, entry.file, snapshot);
  const next = nextSiblingLine(index, entry);
  const endLine = next
    ? Math.max(
        startLine,
        Math.min(
          startLine + Math.max(0, next - entry.line - 1),
          lines.starts.length,
        ),
      )
    : Math.max(startLine, lines.starts.length);
  return {
    from: indexedOffsetOfLine(lines, startLine),
    to: next ? indexedOffsetOfLine(lines, endLine + 1) : lines.textLength,
    endLine,
  };
}

/** Bound a line-only symbol by its next indexed sibling in the same file, or EOF. */
function sliceLineWindow(
  index: MapIndex,
  entry: MapEntry,
  snapshot: FileSnapshot,
  status: 'exact',
  note?: string,
  startLine?: number,
): Extract<ReadResult, { status: 'exact' }>;
function sliceLineWindow(
  index: MapIndex,
  entry: MapEntry,
  snapshot: FileSnapshot,
  status: 'relocated',
  note: string,
  startLine?: number,
): Extract<ReadResult, { status: 'relocated' }>;
function sliceLineWindow(
  index: MapIndex,
  entry: MapEntry,
  snapshot: FileSnapshot,
  status: 'exact' | 'relocated',
  note?: string,
  startLine = entry.line,
): ReadResult {
  const text = snapshot.text ?? '';
  const { from, to, endLine } = lineOnlyRange(
    index,
    entry,
    snapshot,
    startLine,
  );
  const raw = text.slice(from, to);
  if (status === 'relocated') {
    if (note === undefined) {
      throw new Error(
        'A relocated read must explain its best-effort boundary.',
      );
    }
    return {
      status,
      id: entry.id,
      file: entry.file,
      line: startLine,
      endLine,
      raw,
      note,
    };
  }
  return {
    status,
    id: entry.id,
    file: entry.file,
    line: startLine,
    endLine,
    raw,
    note:
      note ??
      (entry.charStart == null
        ? 'Line-only symbol (no char range); bounded by next sibling or EOF — may include trailing lines.'
        : undefined),
  };
}

function locatedFor(
  index: MapIndex,
  ref: string,
  context: ReadContext,
): LocatedResult {
  let located = context.locatedRefs.get(ref);
  if (!located) {
    located = locateWithEntries(index, ref, { limit: 8 });
    context.locatedRefs.set(ref, located);
  }
  return located;
}

function previewAt(text: string, off: number, lines: LineIndex): string {
  const start = indexedOffsetOfLine(lines, indexedLineAt(lines, off));
  let end = text.indexOf('\n', start);
  if (end === -1) end = text.length;
  return text.slice(start, end).trim().slice(0, SOURCE_PREVIEW_LENGTH);
}
