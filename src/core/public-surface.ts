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

/** Parse JSON tolerating JSONC (tsconfig comments + trailing commas); null on failure. */
function readJsonLoose(path: string): any {
  try {
    const s = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"])\/\/.*$/gm, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(s);
  } catch {
    return null;
  }
}
