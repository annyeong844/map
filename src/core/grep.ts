import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SKIP_DIRS } from './files.ts';
import type { GrepMatch } from './types.ts';
import { posix } from './util.ts';

export interface GrepOptions {
  /** Treat the pattern as a literal string rather than a regex. */
  fixed?: boolean;
  /** Restrict to files whose path contains this substring (ripgrep glob). */
  file?: string;
  /** Max matches returned. */
  limit?: number;
  caseInsensitive?: boolean;
}

/**
 * The fallback primitive. When coordinates fail and the anchor is lost, the map
 * has nothing left to offer but honest search — so it offers exactly that.
 * Uses ripgrep when present; degrades to a plain JS scan otherwise.
 */
export function grep(root: string, pattern: string, opts: GrepOptions = {}): GrepMatch[] {
  const limit = opts.limit ?? 100;
  const rg = runRipgrep(root, pattern, opts, limit);
  if (rg) return rg;
  return jsGrep(root, pattern, opts, limit);
}

function runRipgrep(root: string, pattern: string, opts: GrepOptions, limit: number): GrepMatch[] | null {
  // Search relative to root (cwd: root, path '.'): ripgrep emits relative paths and
  // path globs like `*foo*` work, whereas an absolute search path breaks `*` globs
  // (a single `*` will not span the `/` separators of an absolute prefix).
  const args = ['--line-number', '--no-heading', '--color=never', '--max-count', String(limit)];
  if (opts.fixed) args.push('--fixed-strings');
  if (opts.caseInsensitive) args.push('--ignore-case');
  if (opts.file) args.push('--glob', `*${opts.file}*`);
  args.push('--', pattern, '.');

  const res = spawnSync('rg', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: root });
  if (res.error) return null; // rg not installed → caller falls back
  if (res.status !== 0 && res.status !== 1) return null; // 1 = no matches (fine); other = real error

  const out: GrepMatch[] = [];
  // Split on \r?\n: CRLF files leave a trailing \r that would defeat the `$` anchor below.
  for (const raw of (res.stdout || '').split(/\r?\n/)) {
    if (!raw) continue;
    const m = /^(.*?):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    out.push({ file: relativize(root, m[1]), line: Number(m[2]), text: m[3] });
    if (out.length >= limit) break;
  }
  return out;
}

function jsGrep(root: string, pattern: string, opts: GrepOptions, limit: number): GrepMatch[] {
  const rx = opts.fixed
    ? new RegExp(escapeRe(pattern), opts.caseInsensitive ? 'i' : '')
    : new RegExp(pattern, opts.caseInsensitive ? 'i' : '');
  const fileNeedle = (opts.file ?? '').toLowerCase();
  const out: GrepMatch[] = [];
  const skip = SKIP_DIRS;

  const walk = (dir: string): void => {
    if (out.length >= limit) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (out.length >= limit) return;
      if (ent.isDirectory()) {
        if (!skip.has(ent.name)) walk(join(dir, ent.name));
        continue;
      }
      const full = join(dir, ent.name);
      const rel = relativize(root, full);
      if (fileNeedle && !rel.toLowerCase().includes(fileNeedle)) continue;
      try {
        if (statSync(full).size > 4 * 1024 * 1024) continue;
        const lines = readFileSync(full, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (rx.test(lines[i])) {
            out.push({ file: rel, line: i + 1, text: lines[i] });
            if (out.length >= limit) return;
          }
        }
      } catch {
        /* binary / unreadable */
      }
    }
  };
  walk(root);
  return out;
}

function relativize(root: string, file: string): string {
  const r = posix(root).replace(/\/+$/, '');
  let f = posix(file);
  if (f.startsWith('./')) f = f.slice(2);
  return f.startsWith(r + '/') ? f.slice(r.length + 1) : f;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
