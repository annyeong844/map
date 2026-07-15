import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const LINE_FEED_CODE = 10;
const CARRIAGE_RETURN_CODE = 13;
const CONTENT_TOKEN_HEX_LENGTH = 16;
const MAX_ANCHOR_MATCHES = 50;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Newline offsets for one immutable source snapshot. Building this is O(text),
 * then offset -> line is O(log lines) and line -> offset is O(1). Keep one per
 * file operation instead of repeatedly scanning from byte zero. */
export interface LineIndex {
  starts: number[];
  textLength: number;
}

export function buildLineIndex(text: string): LineIndex {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === LINE_FEED_CODE) starts.push(i + 1);
  }
  return { starts, textLength: text.length };
}

/** 1-based line number containing UTF-16 offset `off`. */
export function indexedLineAt(index: LineIndex, off: number): number {
  const target = Math.max(0, Math.min(off, index.textLength));
  const starts = index.starts;
  let lo = 0;
  let hi = starts.length;
  // upper_bound(target): number of line starts <= the offset.
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}

/** UTF-16 offset of the start of 1-based `line`. */
export function indexedOffsetOfLine(index: LineIndex, line: number): number {
  if (line <= 1) return 0;
  return index.starts[line - 1] ?? index.textLength;
}

/** Short, stable content token for a file's text. */
export function token(text: string): string {
  return createHash('sha256')
    .update(text, 'utf8')
    .digest('hex')
    .slice(0, CONTENT_TOKEN_HEX_LENGTH);
}

/** POSIX-normalize a path so index keys are stable across OSes. */
export function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** All UTF-16 offsets where `needle` occurs in `hay[from:to]` (non-overlapping).
 * Bounds avoid allocating a substring when designating a snippet in a symbol. */
export function indexOfAll(
  hay: string,
  needle: string,
  from = 0,
  to = hay.length,
): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let cursor = Math.max(0, from);
  const end = Math.max(cursor, Math.min(to, hay.length));
  for (;;) {
    const i = hay.indexOf(needle, cursor);
    if (i === -1 || i + needle.length > end) break;
    out.push(i);
    cursor = i + needle.length;
    if (out.length > MAX_ANCHOR_MATCHES) break; // anchor is too generic to be useful past this
  }
  return out;
}

/** 1-based line number containing char offset `off`. Pass a prebuilt LineIndex
 * when the same text will be queried repeatedly. */
export function lineAt(text: string, off: number, index?: LineIndex): number {
  if (index) return indexedLineAt(index, off);
  let line = 1;
  for (let i = 0; i < Math.min(Math.max(0, off), text.length); i++) {
    if (text.charCodeAt(i) === LINE_FEED_CODE) line++;
  }
  return line;
}

/** Char offset of the start of 1-based `line`. Pass a prebuilt LineIndex when
 * the same text will be queried repeatedly. */
export function offsetOfLine(
  text: string,
  line: number,
  index?: LineIndex,
): number {
  if (index) return indexedOffsetOfLine(index, line);
  if (line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === LINE_FEED_CODE) {
      seen++;
      if (seen === line) return i + 1;
    }
  }
  return text.length;
}

/** The first source line at/after `start`, trimmed and length-capped — the drift anchor. */
export function firstLine(text: string, start: number, cap = 200): string {
  const from = Math.max(0, Math.min(start, text.length));
  let end = Math.min(text.length, from + Math.max(0, cap));
  // Do not call indexOf without an end bound: one generated megabyte-long line
  // per declaration used to make anchor extraction quadratic.
  for (let i = from; i < end; i++) {
    if (text.charCodeAt(i) === LINE_FEED_CODE) {
      end = i;
      break;
    }
  }
  if (text.charCodeAt(end - 1) === CARRIAGE_RETURN_CODE) end--;
  return text.slice(from, end).trim();
}

export function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
