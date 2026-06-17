import { join } from 'node:path';
import { grep } from './grep.ts';
import { locate } from './locate.ts';
import type { MapEntry, MapIndex, ReadResult } from './types.ts';
import { indexOfAll, lineAt, offsetOfLine, token, tryReadFile } from './util.ts';

/** Lines of trailing context for line-only symbols with no known sibling boundary. */
const LINE_ONLY_WINDOW = 80;

/**
 * Hand back the raw bytes at a routed location — the evidence the LLM judges.
 *
 * Flow, in the order the design demands:
 *   1. coordinates valid (file token matches)  -> exact char-offset slice
 *   2. file changed                            -> re-anchor via searchText
 *   3. anchor ambiguous                        -> return the candidate sites
 *   4. anchor gone                             -> grep the name, return matches
 * Nothing here interprets the code. It only decides *where* to cut.
 */
export function read(index: MapIndex, ref: string): ReadResult {
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

  const text = tryReadFile(join(index.meta.root, entry.file));
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

  // 3 — anchor gone: honest grep on the name.
  const matches = grep(index.meta.root, entry.name, { file: entry.file, fixed: true, limit: 20 });
  return {
    status: 'grep-fallback',
    id: entry.id,
    file: entry.file,
    line: entry.line,
    raw: null,
    note: `File changed and the anchor was lost. Showing grep matches for "${entry.name}".`,
    candidates: matches.map((m) => ({ line: m.line, preview: m.text.trim() })),
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
