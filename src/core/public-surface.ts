import { readFileSync } from 'node:fs';
import { posix as pp } from 'node:path';
import type { ImportEdge } from './extract-symbols.ts';
import { resolveRelative } from './fan-in.ts';

/**
 * The public surface: source files an external consumer (or the CLI runtime)
 * can reach, so their exports aren't dead even with zero internal importers.
 *
 * Roots come from package.json's public-naming fields (mapped from build output
 * back to source via tsconfig outDir/rootDir); the surface then grows along
 * `export … from` re-export edges (a public barrel makes its targets public).
 * This is the mechanical, evidence-backed version of the "it's an entry point /
 * public API" exclusion — no LLM, no stored meaning.
 */
export interface PublicSurface {
  files: Set<string>;
  /** file → why it's public (the package.json field, or which file re-exports it). */
  evidence: Map<string, string>;
}

const STRING_FIELDS = ['main', 'module', 'types', 'typings', 'browser', 'unpkg', 'jsdelivr'];
const NESTED_FIELDS = ['bin', 'exports'];
const EXT_SWAP: Record<string, readonly string[]> = {
  '.d.ts': ['.ts', '.tsx'],
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const APPEND = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export function computePublicSurface(root: string, files: string[], reexportsByFile: Map<string, ImportEdge[]>): PublicSurface {
  const fileSet = new Set(files);
  const evidence = new Map<string, string>();
  const pkg = readJsonLoose(pp.join(root, 'package.json'));
  const ts = readJsonLoose(pp.join(root, 'tsconfig.json'));
  const outDir = norm(ts?.compilerOptions?.outDir);
  const rootDir = norm(ts?.compilerOptions?.rootDir);

  const roots: string[] = [];
  if (pkg) {
    for (const field of [...STRING_FIELDS, ...NESTED_FIELDS]) {
      if (pkg[field] === undefined) continue;
      const targets: string[] = [];
      collectStrings(pkg[field], targets);
      for (const t of targets) {
        const src = mapToSource(t, outDir, rootDir, fileSet);
        if (src && !evidence.has(src)) {
          evidence.set(src, `pkg.${field}`);
          roots.push(src);
        }
      }
    }
  }

  // Grow along re-export edges: a public file's `export … from './x'` → x public.
  const queue = [...roots];
  while (queue.length) {
    const f = queue.shift()!;
    for (const edge of reexportsByFile.get(f) ?? []) {
      const tgt = resolveRelative(f, edge.source, fileSet);
      if (tgt && !evidence.has(tgt)) {
        evidence.set(tgt, `re-export from ${f}`);
        queue.push(tgt);
      }
    }
  }
  return { files: new Set(evidence.keys()), evidence };
}

function norm(p?: string): string {
  return (p ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** package.json output target → indexed source file (via tsconfig dir swap + TS ext). */
function mapToSource(target: string, outDir: string, rootDir: string, fileSet: Set<string>): string | null {
  let t = target.replace(/^\.\//, '');
  if (outDir && rootDir && (t === outDir || t.startsWith(`${outDir}/`))) t = rootDir + t.slice(outDir.length);
  if (fileSet.has(t)) return t;
  for (const [out, tsList] of Object.entries(EXT_SWAP)) {
    if (t.endsWith(out)) {
      const stem = t.slice(0, -out.length);
      for (const ext of tsList) if (fileSet.has(stem + ext)) return stem + ext;
    }
  }
  for (const e of APPEND) {
    if (fileSet.has(t + e)) return t + e;
    if (fileSet.has(`${t}/index${e}`)) return `${t}/index${e}`;
  }
  return null;
}

function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === 'object') for (const k of Object.keys(v as object)) collectStrings((v as Record<string, unknown>)[k], out);
}

/**
 * Strip JSONC comments with a string-aware state machine — a regex can't, since
 * `//` and `/*` inside a string value ("https://…", "a/*b") are not comments.
 * (A string-aware scan — the standard way to strip comments from code; here
 * zero-dep, for config JSON — deliberately not pulling in `typescript` just to
 * read outDir/rootDir.)
 */
export function stripJsonc(s: string): string {
  let out = '';
  let inStr = false;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const d = s[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += d ?? '';
        i++;
      } else if (c === quote) {
        inStr = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Parse JSON tolerating JSONC (comments; trailing commas as a fallback); null on failure. */
function readJsonLoose(path: string): any {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const cleaned = stripJsonc(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      return JSON.parse(cleaned.replace(/,(\s*[}\]])/g, '$1')); // tolerate trailing commas
    } catch {
      return null;
    }
  }
}
