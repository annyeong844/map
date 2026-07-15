import { posix as pp } from 'node:path';
import type { ImportEdge } from './extract-symbols.ts';

// Extensions tried for an extensionless specifier, in order.
const APPEND_EXTS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];
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
function resolveRelative(
  fromFile: string,
  source: string,
  fileSet: Set<string>,
): string | null {
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
  for (const e of APPEND_EXTS) {
    if (fileSet.has(`${base}/index${e}`)) return `${base}/index${e}`;
  }
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
export function computeFanIn(
  files: string[],
  importsByFile: Map<string, ImportEdge[]>,
): Map<string, number> {
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

  interface Route {
    target: string | null;
    order: number;
  }
  interface Routes {
    exact: Map<string, Route>;
    wildcard?: Route;
    unconditional: boolean;
  }

  // Compile each barrel into O(1) named/wildcard route lookup while preserving
  // source order (the first matching re-export remains authoritative).
  const routesByFile = new Map<string, Routes>();
  const dominantExactNames = new Set<string>();
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
          if (exact.order < routes.wildcard.order) {
            routes.unconditional = false;
            break;
          }
        }
      }
      for (const [name, exact] of routes.exact) {
        if (!routes.wildcard || exact.order < routes.wildcard.order) {
          dominantExactNames.add(name);
        }
      }
      routesByFile.set(f, routes);
    }
  }

  const pickRoute = (file: string, name: string): Route | null => {
    const routes = routesByFile.get(file);
    if (!routes) return null;
    const exact = routes.exact.get(name);
    if (exact && (!routes.wildcard || exact.order < routes.wildcard.order)) {
      return exact;
    }
    return routes.wildcard ?? null;
  };

  interface SkipResult {
    file: string;
    cyclic: boolean;
  }
  const collapseWildcardPath = (
    start: string,
    stops: Map<string, SkipResult>,
    ignoreDominantExact: boolean,
  ): SkipResult => {
    const cachedStart = stops.get(start);
    if (cachedStart) return cachedStart;
    const path: string[] = [];
    const seenAt = new Map<string, number>();
    let file = start;
    let result: SkipResult;
    for (;;) {
      const cached = stops.get(file);
      if (cached) {
        result = cached;
        break;
      }
      const cycleAt = seenAt.get(file);
      if (cycleAt !== undefined) {
        const cycle = path.slice(cycleAt);
        const canonical = cycle.reduce((best, candidate) =>
          candidate < best ? candidate : best,
        );
        result = { file: canonical, cyclic: true };
        for (const cycleFile of cycle) stops.set(cycleFile, result);
        break;
      }
      seenAt.set(file, path.length);
      path.push(file);
      const routes = routesByFile.get(file);
      let target: string | null;
      if (ignoreDominantExact) {
        target = routes?.wildcard?.target ?? null;
      } else if (routes?.unconditional) {
        target = routes.wildcard?.target ?? null;
      } else {
        target = null;
      }
      if (!target) {
        result = { file, cyclic: false };
        break;
      }
      file = target;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      if (!stops.has(path[i])) stops.set(path[i], result);
    }
    return result;
  };

  const unconditionalStops = new Map<string, SkipResult>();
  /** Collapse pure `export *` chains once for every name. */
  const skipUnconditional = (start: string): SkipResult =>
    collapseWildcardPath(start, unconditionalStops, false);

  // A name that is never intercepted by an earlier named re-export follows only
  // wildcard routes. Collapse that path once globally instead of once per name.
  const wildcardStops = new Map<string, SkipResult>();
  const skipWildcard = (start: string): SkipResult =>
    collapseWildcardPath(start, wildcardStops, true);

  /** Walk `export { name } from …` / `export * from …` chains to the file that
   * actually defines `name`, so importers through a barrel count toward the real
   * definition rather than the barrel. */
  const resolvedDefs = new Map<string, string>();
  const resolveDef = (start: string, name: string): string => {
    const startKey = `${start}\0${name}`;
    const cachedStart = resolvedDefs.get(startKey);
    if (cachedStart !== undefined) return cachedStart;
    if (!dominantExactNames.has(name)) {
      const terminal = skipWildcard(start).file;
      resolvedDefs.set(startKey, terminal);
      return terminal;
    }

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
        terminal = cycle.reduce((best, candidate) =>
          candidate < best ? candidate : best,
        );
        for (const cycleFile of cycle) {
          resolvedDefs.set(`${cycleFile}\0${name}`, terminal);
        }
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

  /** Resolve many names entering the same barrel as one flowing group. At a
   * mixed named/wildcard file we inspect its sparse exact routes, peel only the
   * matching names, and move the remaining Set down the wildcard edge. This
   * turns a shared L-file/M-name path from O(L·M) into O(L + M + route edges),
   * plus only the work on exact routes that genuinely diverge. */
  const resolveDefs = (
    start: string,
    names: Iterable<string>,
  ): Map<string, string> => {
    const results = new Map<string, string>();
    const active = new Set<string>();
    let wildcardTerminal: string | undefined;
    for (const name of names) {
      const key = `${start}\0${name}`;
      const cached = resolvedDefs.get(key);
      if (cached !== undefined) {
        results.set(name, cached);
      } else if (!dominantExactNames.has(name)) {
        wildcardTerminal ??= skipWildcard(start).file;
        resolvedDefs.set(key, wildcardTerminal);
        results.set(name, wildcardTerminal);
      } else {
        active.add(name);
      }
    }
    if (active.size === 1) {
      const name = active.values().next().value!;
      results.set(name, resolveDef(start, name));
      return results;
    }
    if (active.size === 0) return results;

    const finish = (terminal: string): void => {
      for (const name of active) {
        resolvedDefs.set(`${start}\0${name}`, terminal);
        results.set(name, terminal);
      }
      active.clear();
    };
    const path: string[] = [];
    const seenAt = new Map<string, number>();
    let file = start;
    while (active.size) {
      const skipped = skipUnconditional(file);
      file = skipped.file;
      if (skipped.cyclic) {
        finish(file);
        break;
      }
      const cycleAt = seenAt.get(file);
      if (cycleAt !== undefined) {
        finish(
          path
            .slice(cycleAt)
            .reduce((best, candidate) => (candidate < best ? candidate : best)),
        );
        break;
      }
      seenAt.set(file, path.length);
      path.push(file);

      const routes = routesByFile.get(file);
      const wildcard = routes?.wildcard;
      if (routes) {
        for (const [name, exact] of routes.exact) {
          if (
            !active.has(name) ||
            (wildcard && exact.order >= wildcard.order)
          ) {
            continue;
          }
          active.delete(name);
          const terminal = exact.target ? resolveDef(exact.target, name) : file;
          resolvedDefs.set(`${start}\0${name}`, terminal);
          results.set(name, terminal);
        }
      }
      if (active.size === 0) break;
      if (!wildcard?.target) {
        finish(file);
        break;
      }
      file = wildcard.target;
    }
    return results;
  };

  // Batch consumers by the barrel they enter. Repeated imports of the same name
  // share both module resolution and definition traversal.
  const requests = new Map<string, Map<string, Set<string>>>();
  for (const [fromFile, edges] of importsByFile) {
    for (const edge of edges) {
      if (!edge.name || edge.name === '*' || edge.reexport) continue; // re-exports forward, they don't consume
      const target = targetFor(fromFile, edge.source);
      if (!target) continue;
      let byName = requests.get(target);
      if (!byName) requests.set(target, (byName = new Map()));
      let consumers = byName.get(edge.name);
      if (!consumers) byName.set(edge.name, (consumers = new Set()));
      consumers.add(fromFile);
    }
  }

  const importers = new Map<string, Set<string>>(); // "defFile::name" -> set of importing files
  for (const [target, byName] of requests) {
    const defs = resolveDefs(target, byName.keys());
    for (const [name, consumers] of byName) {
      const key = `${defs.get(name) ?? target}::${name}`;
      const set = importers.get(key);
      if (!set) importers.set(key, consumers);
      else for (const fromFile of consumers) set.add(fromFile);
    }
  }
  const fanIn = new Map<string, number>();
  for (const [key, set] of importers) fanIn.set(key, set.size);
  return fanIn;
}
