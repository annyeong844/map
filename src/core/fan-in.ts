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
const JS_TO_TS_ENTRIES = Object.entries(JS_TO_TS);

/**
 * Resolve a relative import specifier against the known file set — no filesystem
 * access, just path math + membership. Bare/aliased specifiers (packages,
 * tsconfig paths) are external and return null; resolving those fully is a whole
 * module resolver's job, deliberately out of scope here.
 */
function resolveRelative(fromFile: string, source: string, fileSet: Set<string>): string | null {
  // The Python backend emits an already-resolved repo-relative path ('pkg/mod.py');
  // a source that is itself an indexed file needs no further resolution. (TS bare
  // specifiers like 'react' never match a file path, so this is a no-op for TS.)
  if (fileSet.has(source)) return source;
  if (!source.startsWith('./') && !source.startsWith('../')) return null;
  const base = pp.join(pp.dirname(fromFile), source);

  // 1. The specifier as written points at a real file (e.g. a genuine .js).
  if (fileSet.has(base)) return base;

  // 2. A JS-family extension that, by the TS ESM convention, names a .ts file.
  for (const [js, tsList] of JS_TO_TS_ENTRIES) {
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

  // Resolve each module specifier once. Imports and re-export traversal often
  // ask about the same `(from file, source)` pair many times.
  const targetCache = new Map<string, Map<string, string | null>>();
  const targetFor = (fromFile: string, source: string): string | null => {
    let bySource = targetCache.get(fromFile);
    if (!bySource) targetCache.set(fromFile, (bySource = new Map()));
    if (bySource.has(source)) return bySource.get(source) ?? null;
    const target = resolveRelative(fromFile, source, fileSet);
    bySource.set(source, target);
    return target;
  };

  interface Route { target: string | null; order: number }
  interface Routes { exact: Map<string, Route>; wildcard?: Route; unconditional: boolean }

  // Compile each barrel into O(1) named/wildcard route lookup while preserving
  // source order (the first matching re-export remains authoritative).
  const routesByFile = new Map<string, Routes>();
  for (const [f, edges] of importsByFile) {
    let routes: Routes | null = null;
    for (let order = 0; order < edges.length; order++) {
      const edge = edges[order];
      if (!edge.reexport) continue;
      routes ??= { exact: new Map(), unconditional: false };
      const route = { target: targetFor(f, edge.source), order };
      if (edge.name === '*') routes.wildcard ??= route;
      else if (!routes.exact.has(edge.name)) routes.exact.set(edge.name, route);
    }
    if (routes) {
      // A wildcard appearing before every named edge wins for every possible
      // symbol name. Such chains can be collapsed once independent of `name`.
      routes.unconditional = !!routes.wildcard;
      if (routes.wildcard) {
        for (const exact of routes.exact.values()) {
          if (exact.order < routes.wildcard.order) { routes.unconditional = false; break; }
        }
      }
      routesByFile.set(f, routes);
    }
  }

  const pickRoute = (file: string, name: string): Route | null => {
    const routes = routesByFile.get(file);
    if (!routes) return null;
    const exact = routes.exact.get(name);
    if (exact && (!routes.wildcard || exact.order < routes.wildcard.order)) return exact;
    return routes.wildcard ?? null;
  };

  interface SkipResult { file: string; cyclic: boolean }
  const unconditionalStops = new Map<string, SkipResult>();
  /** Collapse pure `export *` chains once for all names. Without this, M unique
   * imported names through an L-file barrel chain cost O(M·L). */
  const skipUnconditional = (start: string): SkipResult => {
    const cachedStart = unconditionalStops.get(start);
    if (cachedStart) return cachedStart;
    const path: string[] = [];
    const seenAt = new Map<string, number>();
    let file = start;
    let result: SkipResult;
    for (;;) {
      const cached = unconditionalStops.get(file);
      if (cached) { result = cached; break; }
      const cycleAt = seenAt.get(file);
      if (cycleAt !== undefined) {
        const cycle = path.slice(cycleAt);
        const canonical = cycle.reduce((best, candidate) => candidate < best ? candidate : best);
        result = { file: canonical, cyclic: true };
        for (const cycleFile of cycle) unconditionalStops.set(cycleFile, result);
        break;
      }
      seenAt.set(file, path.length);
      path.push(file);
      const routes = routesByFile.get(file);
      if (!routes?.unconditional || !routes.wildcard?.target) {
        result = { file, cyclic: false };
        break;
      }
      file = routes.wildcard.target;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      if (!unconditionalStops.has(path[i])) unconditionalStops.set(path[i], result);
    }
    return result;
  };

  /** Walk `export { name } from …` / `export * from …` chains to the file that
   * actually defines `name`, so importers through a barrel count toward the real
   * definition rather than the barrel. */
  const resolvedDefs = new Map<string, string>();
  const resolveDef = (start: string, name: string): string => {
    const path: string[] = [];
    const seenAt = new Map<string, number>();
    let file = start;
    let terminal: string;
    for (;;) {
      const skipped = skipUnconditional(file);
      file = skipped.file;
      if (skipped.cyclic) {
        terminal = file;
        break;
      }
      const key = `${file}\0${name}`;
      const cached = resolvedDefs.get(key);
      if (cached !== undefined) {
        terminal = cached;
        break;
      }
      const cycleAt = seenAt.get(file);
      if (cycleAt !== undefined) {
        const cycle = path.slice(cycleAt);
        terminal = cycle.reduce((best, candidate) => candidate < best ? candidate : best);
        for (const cycleFile of cycle) resolvedDefs.set(`${cycleFile}\0${name}`, terminal);
        break;
      }
      seenAt.set(file, path.length);
      path.push(file);
      const route = pickRoute(file, name);
      if (!route || !route.target) {
        terminal = file;
        break;
      }
      file = route.target;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const key = `${path[i]}\0${name}`;
      if (!resolvedDefs.has(key)) resolvedDefs.set(key, terminal);
    }
    return terminal;
  };

  const importers = new Map<string, Set<string>>(); // "defFile::name" -> set of importing files
  for (const [fromFile, edges] of importsByFile) {
    for (const edge of edges) {
      if (!edge.name || edge.name === '*' || edge.reexport) continue; // re-exports forward, they don't consume
      const target = targetFor(fromFile, edge.source);
      if (!target) continue;
      const def = resolveDef(target, edge.name);
      const key = `${def}::${edge.name}`;
      let set = importers.get(key);
      if (!set) importers.set(key, (set = new Set()));
      set.add(fromFile);
    }
  }
  const fanIn = new Map<string, number>();
  for (const [key, set] of importers) fanIn.set(key, set.size);
  return fanIn;
}
