import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isParseable } from './extract-symbols.ts';
import { posix } from './util.ts';

/** Generated/vendored dirs skipped by the walker — and by the JS grep fallback,
 * so both grep backends see roughly the same corpus (ripgrep adds .gitignore). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.audit', '.cache']);

/**
 * Enumerate the source files to index, POSIX-relative to root.
 *
 * In a git repo we ask git: tracked + untracked-but-not-ignored files. That
 * respects `.gitignore` for free, so generated/vendored trees (corpora, build
 * output) stay out — the map reflects the actual codebase, not its fixtures.
 * Outside git, we walk and skip the usual generated directories.
 */
export function listSourceFiles(root: string): string[] {
  return (gitFiles(root) ?? walkFiles(root)).filter(isParseable).sort();
}

function gitFiles(root: string): string[] | null {
  const res = spawnSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) return null;
  return (res.stdout || '').split('\0').filter(Boolean).map(posix);
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(join(dir, ent.name), childRel);
      } else if (ent.isFile()) {
        out.push(childRel);
      }
    }
  };
  walk(root, '');
  return out;
}
