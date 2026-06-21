import { realpathSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { locate } from './locate.ts';
import type { MapEntry, MapIndex, ReadResult } from './types.ts';
import { indexOfAll, lineAt, offsetOfLine, token, tryReadFile } from './util.ts';

/**
 * Resolve `relFile` under `root`, refusing anything that escapes it — a `..`
 * traversal or a symlink pointing outside. An index is untrusted input (it can be
 * committed in a downloaded repo), so a malicious `entry.file` must not make the
 * server read outside the project root. Returns the absolute path, or null to refuse.
 */
function fileWithinRoot(root: string, relFile: string): string | null {
  const rootAbs = resolvePath(root);
  const target = resolvePath(rootAbs, relFile);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null; // lexical containment
  try {
    const real = realpathSync(target);
    const realRoot = realpathSync(rootAbs);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null; // symlink escape
  } catch {
    /* not yet on disk — the lexical check already held */
  }
  return target;
}

/** Lines of trailing context for line-only symbols with no known sibling boundary. */
const LINE_ONLY_WINDOW = 80;

/**
 * Hand back the raw bytes at a routed location — the evidence the LLM judges.
 * With `opts.snippet`, also act as a sub-symbol designator: resolve the quoted
 * snippet to exact char range(s) INSIDE the symbol (extending the drift logic —
 * searchText/indexOfAll — to an arbitrary span), so a fix lands on the bug line,
 * not the whole function. Folded into `read` rather than a separate tool: the
 * snippet is just a finer coordinate on the same "give me the bytes here" call.
 */
export function read(index: MapIndex, ref: string, opts: { snippet?: string } = {}): ReadResult {
  const result = readCore(index, ref);
  if (opts.snippet) {
    const entry = resolve(index, ref);
    if (entry) result.aim = computeAim(index, entry, opts.snippet);
  }
  return result;
}

/**
 * Resolve a snippet to its char range(s) WITHIN the symbol's own bytes — never the
 * whole file. If the file changed, re-anchor on the signature line and confine the
 * search to the relocated range; if the symbol can't be re-confined, return
 * `unanchored` (a whole-file search could match an identical snippet in a *different*
 * symbol and falsely report `hit`). `ambiguous` when the snippet occurs >1× inside.
 */
function computeAim(index: MapIndex, entry: MapEntry, snippet: string): ReadResult['aim'] {
  const path = fileWithinRoot(index.meta.root, entry.file);
  const text = path == null ? null : tryReadFile(path);
  if (text == null) return { status: 'unanchored', matches: [] };

  // Establish the symbol's byte range [lo, hi) — and refuse to guess past it.
  let lo: number;
  let hi: number;
  const fresh = token(text) === index.fileTokens[entry.file];
  if (fresh && entry.charStart != null && entry.charEnd != null) {
    lo = entry.charStart;
    hi = entry.charEnd;
  } else if (entry.charStart != null && entry.charEnd != null) {
    // File changed: re-anchor on the signature line; confine to the relocated span.
    const hits = indexOfAll(text, entry.searchText);
    if (hits.length !== 1) return { status: 'unanchored', matches: [] };
    lo = hits[0];
    hi = hits[0] + (entry.charEnd - entry.charStart);
  } else {
    // Line-only symbol (no char range): bound by the next indexed sibling.
    const next = index.entries
      .filter((e) => e.file === entry.file && e.line > entry.line)
      .map((e) => e.line)
      .sort((a, b) => a - b)[0];
    lo = offsetOfLine(text, entry.line);
    hi = next ? offsetOfLine(text, next) : Math.min(text.length, offsetOfLine(text, entry.line + LINE_ONLY_WINDOW));
  }

  const local = indexOfAll(text.slice(lo, hi), snippet);
  if (!local.length) return { status: 'not-in-symbol', matches: [] };
  // `local` offsets are ascending, so walk a single cursor forward instead of
  // re-scanning from offset 0 per match — O(span + M) rather than O(M · offset)
  // (matters only when a snippet matches many times inside a deep-in-file symbol).
  let cursor = lo;
  let line = lineAt(text, lo); // seed the symbol's start line once
  const matches = local.map((o) => {
    const at = lo + o;
    for (; cursor < at; cursor++) if (text.charCodeAt(cursor) === 10 /* \n */) line++;
    return { line, charStart: at, charEnd: at + snippet.length };
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
export function changed(index: MapIndex, refs: string[]): { unchanged: string[]; changed: ReadResult[]; filesChecked: number; filesChanged: number } {
  const unchanged: string[] = [];
  const changedOut: ReadResult[] = [];
  const fileFresh = new Map<string, boolean>(); // token check cached per file
  for (const ref of refs) {
    const entry = resolve(index, ref);
    if (!entry) {
      changedOut.push(readCore(index, ref)); // unresolved/renamed → surface it as a delta
      continue;
    }
    if (!fileFresh.has(entry.file)) {
      const path = fileWithinRoot(index.meta.root, entry.file);
      const text = path == null ? null : tryReadFile(path);
      fileFresh.set(entry.file, text != null && token(text) === index.fileTokens[entry.file]);
    }
    if (fileFresh.get(entry.file)) unchanged.push(entry.id);
    else changedOut.push(readCore(index, ref)); // file moved → re-anchor + current slice
  }
  const filesChanged = [...fileFresh.values()].filter((f) => !f).length;
  return { unchanged, changed: changedOut, filesChecked: fileFresh.size, filesChanged };
}

function readCore(index: MapIndex, ref: string): ReadResult {
  const entry = resolve(index, ref);
  if (!entry) {
    const hits = locate(index, ref, { limit: 8 });
    return {
      status: hits.length ? 'ambiguous' : 'not-found',
      id: ref,
      file: '',
      line: 0,
      raw: null,
      note: hits.length
        ? `"${ref}" did not resolve to one symbol. Pick an id from the candidates.`
        : `No symbol matches "${ref}".`,
      candidates: hits.map((h) => ({ line: h.line, preview: `${h.id}  ·  ${h.signature}` })),
    };
  }

  const path = fileWithinRoot(index.meta.root, entry.file);
  if (path == null) {
    return { status: 'not-found', id: entry.id, file: entry.file, line: entry.line, raw: null, note: `Refused: "${entry.file}" resolves outside the index root.` };
  }
  const text = tryReadFile(path);
  if (text == null) {
    return { status: 'not-found', id: entry.id, file: entry.file, line: entry.line, raw: null, note: `File not readable: ${entry.file}` };
  }

  const fresh = token(text) === index.fileTokens[entry.file];

  // 1 — coordinates still trustworthy.
  if (fresh) {
    if (entry.charStart != null && entry.charEnd != null) {
      const raw = text.slice(entry.charStart, entry.charEnd);
      return { status: 'exact', id: entry.id, file: entry.file, line: entry.line, endLine: entry.endLine ?? lineAt(text, entry.charEnd), raw };
    }
    return sliceLineWindow(index, entry, text, 'exact');
  }

  // 2 — file changed: re-anchor on the signature line.
  const hits = indexOfAll(text, entry.searchText);
  if (hits.length === 1) {
    const start = hits[0];
    const startLine = lineAt(text, start);
    if (entry.charStart != null && entry.charEnd != null) {
      const len = entry.charEnd - entry.charStart;
      const raw = text.slice(start, start + len);
      return {
        status: 'relocated',
        id: entry.id,
        file: entry.file,
        line: startLine,
        endLine: lineAt(text, start + len),
        raw,
        note: 'File changed since indexing. Re-anchored on the signature line; the end boundary is best-effort — verify it covers the whole symbol.',
      };
    }
    return sliceLineWindow(index, { ...entry, line: startLine }, text, 'relocated', 'File changed since indexing; re-anchored by signature line.');
  }

  if (hits.length > 1) {
    return {
      status: 'ambiguous',
      id: entry.id,
      file: entry.file,
      line: entry.line,
      raw: null,
      note: `File changed; the anchor "${entry.searchText.slice(0, 60)}" now matches ${hits.length} sites. Inspect candidates.`,
      candidates: hits.slice(0, 12).map((off) => ({ line: lineAt(text, off), preview: previewAt(text, off) })),
    };
  }

  // 3 — anchor gone: the symbol moved or was renamed beyond recovery.
  return {
    status: 'anchor-lost',
    id: entry.id,
    file: entry.file,
    line: entry.line,
    raw: null,
    note: `File changed and the signature anchor "${entry.searchText.slice(0, 60)}" is no longer present — the symbol was renamed or removed. Re-run \`map index\` to refresh coordinates.`,
  };
}

/** Resolve a ref to one entry: exact id, else an unambiguous locate top hit. */
function resolve(index: MapIndex, ref: string): MapEntry | null {
  const exact = index.entries.find((e) => e.id === ref);
  if (exact) return exact;
  const hits = locate(index, ref, { limit: 2 });
  if (hits.length === 1) return index.entries.find((e) => e.id === hits[0].id) ?? null;
  if (hits.length >= 2 && hits[0].score > hits[1].score) {
    return index.entries.find((e) => e.id === hits[0].id) ?? null;
  }
  return null;
}

/** Bound a line-only symbol by its next indexed sibling in the same file. */
function sliceLineWindow(index: MapIndex, entry: MapEntry, text: string, status: 'exact' | 'relocated', note?: string): ReadResult {
  const siblingLines = index.entries
    .filter((e) => e.file === entry.file && e.line > entry.line)
    .map((e) => e.line)
    .sort((a, b) => a - b);
  const totalLines = text.split('\n').length;
  const next = siblingLines.length ? siblingLines[0] - 1 : Math.min(entry.line + LINE_ONLY_WINDOW, totalLines);
  const endLine = Math.max(entry.line, next);
  const from = offsetOfLine(text, entry.line);
  const to = offsetOfLine(text, endLine + 1);
  return {
    status,
    id: entry.id,
    file: entry.file,
    line: entry.line,
    endLine,
    raw: text.slice(from, to),
    note: note ?? (entry.charStart == null ? 'Line-only symbol (no char range); bounded by next sibling — may include trailing lines.' : undefined),
  };
}

function previewAt(text: string, off: number): string {
  const start = offsetOfLine(text, lineAt(text, off));
  let end = text.indexOf('\n', start);
  if (end === -1) end = text.length;
  return text.slice(start, end).trim().slice(0, 120);
}
