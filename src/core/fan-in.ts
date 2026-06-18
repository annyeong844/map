import { posix as pp } from 'node:path';
import type { ImportEdge } from './extract-symbols.ts';

// Extensions tried for an extensionless specifier, in order.
const APPEND_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
// TS ESM / NodeNext writes a JS-family extension on the specifier, but the file
// on disk is its TS counterpart (`import './x.js'` resolves to `x.ts`). Map back.
const JS_TO_TS: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * Resolve a relative import specifier against the known file set — no filesystem
 * access, just path math + membership. Bare/aliased specifiers (packages,
 * tsconfig paths) are external and return null; resolving those fully is a whole
 * module resolver's job, deliberately out of scope here.
 */
export function resolveRelative(fromFile: string, source: string, fileSet: Set<string>): string | null {
  // The Python backend emits an already-resolved repo-relative path ('pkg/mod.py');
  // a source that is itself an indexed file needs no further resolution. (TS bare
  // specifiers like 'react' never match a file path, so this is a no-op for TS.)
  if (fileSet.has(source)) return source;
  if (!source.startsWith('./') && !source.startsWith('../')) return null;
  const base = pp.join(pp.dirname(fromFile), source);

  // 1. The specifier as written points at a real file (e.g. a genuine .js).
  if (fileSet.has(base)) return base;

  // 2. A JS-family extension that, by the TS ESM convention, names a .ts file.
  for (const [js, tsList] of Object.entries(JS_TO_TS)) {
    if (base.endsWith(js)) {
      const stem = base.slice(0, -js.length);
      for (const ts of tsList) if (fileSet.has(stem + ts)) return stem + ts;
      return null; // had an explicit extension — don't fall through to appends
    }
  }

  // 3. Extensionless specifier → append an extension, then try a directory index.
  for (const e of APPEND_EXTS) if (fileSet.has(base + e)) return base + e;
  for (const e of APPEND_EXTS) if (fileSet.has(`${base}/index${e}`)) return `${base}/index${e}`;
  return null;
}

/**
 * Native fan-in: for every named import / re-export edge that resolves to an
 * indexed file, count the *distinct importing files* per `target::name`. This is
 * the map's own cross-module reference count — what disambiguates a canonical
 * definition (many importers) from a vendored copy (few), with no external graph.
 *
 * Honest scope: counts named + default edges via *relative* specifiers only.
 * Namespace/`export *` edges and package/alias specifiers are not attributed.
 */
export function computeFanIn(files: string[], importsByFile: Map<string, ImportEdge[]>): Map<string, number> {
  const fileSet = new Set(files);
  const importers = new Map<string, Set<string>>(); // "target::name" -> set of importing files
  for (const [fromFile, edges] of importsByFile) {
    for (const edge of edges) {
      if (!edge.name || edge.name === '*') continue;
      const target = resolveRelative(fromFile, edge.source, fileSet);
      if (!target) continue;
      const key = `${target}::${edge.name}`;
      let set = importers.get(key);
      if (!set) importers.set(key, (set = new Set()));
      set.add(fromFile);
    }
  }
  const fanIn = new Map<string, number>();
  for (const [key, set] of importers) fanIn.set(key, set.size);
  return fanIn;
}
