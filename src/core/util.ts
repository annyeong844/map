import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Short, stable content token for a file's text. */
export function token(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** POSIX-normalize a path so index keys are stable across OSes. */
export function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Parse the byte/char range out of a symbol-graph definitionId.
 *   "_lib/alias-map.mjs#FunctionDeclaration:1289-2609"  ->  { start: 1289, end: 2609 }
 * Returns null when the id carries no range (older schemas, methods).
 */
export function parseRange(definitionId: string): { start: number; end: number } | null {
  const m = /:(\d+)-(\d+)\s*$/.exec(definitionId);
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]) };
}

/** All UTF-16 offsets where `needle` occurs in `hay` (non-overlapping). */
export function indexOfAll(hay: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    out.push(i);
    from = i + needle.length;
    if (out.length > 50) break; // anchor is too generic to be useful past this
  }
  return out;
}

/** 1-based line number containing char offset `off`. */
export function lineAt(text: string, off: number): number {
  let line = 1;
  const end = Math.min(off, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10 /* \n */) line++;
  return line;
}

/** Char offset of the start of 1-based `line`. */
export function offsetOfLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let seen = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      seen++;
      if (seen === line) return i + 1;
    }
  }
  return text.length;
}

/** The first source line at/after `start`, trimmed and length-capped — the drift anchor. */
export function firstLine(text: string, start: number, cap = 200): string {
  let end = text.indexOf('\n', start);
  if (end === -1) end = text.length;
  if (text.charCodeAt(end - 1) === 13 /* \r */) end--;
  return text.slice(start, Math.min(end, start + cap)).trim();
}

export function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
