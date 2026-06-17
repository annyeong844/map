import { posix as pp } from 'node:path';
import type { ImportEdge } from './extract-symbols.ts';

const EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Resolve a relative import specifier against the known file set — no filesystem
 * access, just path math + membership. Bare/aliased specifiers (packages,
 * tsconfig paths) are external and return null; resolving those fully is a whole
 * module resolver's job, deliberately out of scope here.
 */
function resolveRelative(fromFile: string, source: string, fileSet: Set<string>): string | null {
  if (!source.startsWith('./') && !source.startsWith('../')) return null;
  const base = pp.join(pp.dirname(fromFile), source);
  for (const e of EXTS) if (fileSet.has(base + e)) return base + e;
  for (const e of EXTS.slice(1)) if (fileSet.has(`${base}/index${e}`)) return `${base}/index${e}`;
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
