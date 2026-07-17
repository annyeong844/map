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
const DOT_CHAR_CODE = '.'.charCodeAt(0);
const SLASH_CHAR_CODE = '/'.charCodeAt(0);

interface RenamedDefinition {
  file: string;
  name: string;
}
type ResolvedDefinition = string | RenamedDefinition;

function definitionFile(definition: ResolvedDefinition): string {
  return typeof definition === 'string' ? definition : definition.file;
}

function definitionName(
  definition: ResolvedDefinition,
  requestedName: string,
): string {
  return typeof definition === 'string' ? requestedName : definition.name;
}

/** Join the dominant `./name` import shape without paying for general path
 * normalization. Dot segments and repeated separators deliberately fall back. */
function simpleRelativeBase(fromFile: string, source: string): string | null {
  if (
    source.length <= 2 ||
    source.charCodeAt(0) !== DOT_CHAR_CODE ||
    source.charCodeAt(1) !== SLASH_CHAR_CODE ||
    source.charCodeAt(2) === DOT_CHAR_CODE
  ) {
    return null;
  }
  for (let i = 2; i < source.length - 1; i++) {
    if (source.charCodeAt(i) !== SLASH_CHAR_CODE) continue;
    const next = source.charCodeAt(i + 1);
    if (next === DOT_CHAR_CODE || next === SLASH_CHAR_CODE) return null;
  }
  const directoryEnd = fromFile.lastIndexOf('/') + 1;
  return directoryEnd === 0
    ? source.slice(2)
    : fromFile.slice(0, directoryEnd) + source.slice(2);
}

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
  const base =
    simpleRelativeBase(fromFile, source) ??
    pp.join(pp.dirname(fromFile), source);

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

  // Edges are grouped by importer, and repeated imports from one source are
  // adjacent in the dominant workloads. A one-entry cache keeps that fast path
  // without allocating a nested Map for every one-shot importer.
  let cachedFromFile: string | undefined;
  let cachedSource: string | undefined;
  let cachedTarget: string | null = null;
  const targetFor = (fromFile: string, source: string): string | null => {
    if (fromFile === cachedFromFile && source === cachedSource) {
      return cachedTarget;
    }
    const target = resolveRelative(fromFile, source, fileSet);
    cachedFromFile = fromFile;
    cachedSource = source;
    cachedTarget = target;
    return target;
  };

  interface Route {
    target: string | null;
    order: number;
    sourceName?: string;
  }
  interface Routes {
    exact?: Map<string, Route>;
    exactName?: string;
    exactRoute?: Route;
    wildcard?: Route;
    unconditional: boolean;
  }

  // Compile each barrel into O(1) named/wildcard route lookup while preserving
  // source order (the first matching re-export remains authoritative). Collect
  // consumer requests in the same edge pass so flat graphs are not walked twice.
  const routesByFile = new Map<string, Routes>();
  const dominantExactNames = new Set<string>();
  type Consumers = string | Set<string>;
  const requests = new Map<string, Map<string, Consumers>>();
  for (const [f, edges] of importsByFile) {
    let routes: Routes | null = null;
    for (let order = 0; order < edges.length; order++) {
      const edge = edges[order];
      if (!edge.reexport) {
        if (edge.name === '*') continue;
        const target = targetFor(f, edge.source);
        if (!target) continue;
        let byName = requests.get(target);
        if (!byName) {
          byName = new Map<string, Consumers>();
          requests.set(target, byName);
        }
        const consumers = byName.get(edge.name);
        if (consumers === undefined) {
          byName.set(edge.name, f);
        } else if (typeof consumers === 'string') {
          if (consumers !== f) {
            byName.set(edge.name, new Set([consumers, f]));
          }
        } else {
          consumers.add(f);
        }
        continue;
      }
      routes ??= { unconditional: false };
      const route: Route = { target: targetFor(f, edge.source), order };
      if (edge.sourceName !== undefined && edge.sourceName !== edge.name) {
        route.sourceName = edge.sourceName;
      }
      if (edge.name === '*') {
        routes.wildcard ??= route;
      } else if (routes.exact) {
        if (!routes.exact.has(edge.name)) routes.exact.set(edge.name, route);
      } else if (routes.exactName === undefined) {
        routes.exactName = edge.name;
        routes.exactRoute = route;
      } else if (routes.exactName !== edge.name) {
        routes.exact = new Map([
          [routes.exactName, routes.exactRoute!],
          [edge.name, route],
        ]);
        routes.exactName = undefined;
        routes.exactRoute = undefined;
      }
    }
    if (routes) {
      // A wildcard appearing before every named edge wins for every possible
      // symbol name. Such chains can be collapsed once independent of `name`.
      routes.unconditional = !!routes.wildcard;
      if (routes.wildcard) {
        if (routes.exact) {
          for (const exact of routes.exact.values()) {
            if (exact.order < routes.wildcard.order) {
              routes.unconditional = false;
              break;
            }
          }
        } else if (
          routes.exactRoute &&
          routes.exactRoute.order < routes.wildcard.order
        ) {
          routes.unconditional = false;
        }
      }
      if (routes.exact) {
        for (const [name, exact] of routes.exact) {
          if (!routes.wildcard || exact.order < routes.wildcard.order) {
            dominantExactNames.add(name);
          }
        }
      } else if (
        routes.exactName !== undefined &&
        routes.exactRoute &&
        (!routes.wildcard || routes.exactRoute.order < routes.wildcard.order)
      ) {
        dominantExactNames.add(routes.exactName);
      }
      routesByFile.set(f, routes);
    }
  }

  const pickRoute = (file: string, name: string): Route | null => {
    const routes = routesByFile.get(file);
    if (!routes) return null;
    const exact =
      routes.exact?.get(name) ??
      (routes.exactName === name ? routes.exactRoute : undefined);
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

  const rebaseDefinition = (
    definition: ResolvedDefinition,
    requestedName: string,
    exposedName: string,
  ): ResolvedDefinition => {
    const terminalName = definitionName(definition, requestedName);
    if (terminalName === exposedName) return definitionFile(definition);
    return typeof definition === 'string'
      ? { file: definition, name: terminalName }
      : definition;
  };

  /** Walk named/wildcard re-export chains to the real definition identity.
   * The common no-rename result remains a file string; only `x as y` paths
   * allocate a `{ file, name }` pair. */
  const resolvedDefs = new Map<string, ResolvedDefinition>();
  const resolveDef = (
    start: string,
    requestedName: string,
  ): ResolvedDefinition => {
    const startKey = `${start}\0${requestedName}`;
    const cachedStart = resolvedDefs.get(startKey);
    if (cachedStart !== undefined) return cachedStart;
    if (!dominantExactNames.has(requestedName)) {
      const terminal = skipWildcard(start).file;
      resolvedDefs.set(startKey, terminal);
      return terminal;
    }

    const path: { file: string; name: string }[] = [];
    const seenAt = new Map<string, number>();
    let file = start;
    let name = requestedName;
    let terminalFile: string;
    let terminalName: string;
    for (;;) {
      if (!dominantExactNames.has(name)) {
        terminalFile = skipWildcard(file).file;
        terminalName = name;
        break;
      }
      const skipped = skipUnconditional(file);
      file = skipped.file;
      if (skipped.cyclic) {
        terminalFile = file;
        terminalName = name;
        break;
      }
      const key = `${file}\0${name}`;
      const cached = resolvedDefs.get(key);
      if (cached !== undefined) {
        terminalFile = definitionFile(cached);
        terminalName = definitionName(cached, name);
        break;
      }
      const cycleAt = seenAt.get(key);
      if (cycleAt !== undefined) {
        const cycle = path.slice(cycleAt);
        const terminal = cycle.reduce((best, candidate) =>
          `${candidate.file}\0${candidate.name}` < `${best.file}\0${best.name}`
            ? candidate
            : best,
        );
        terminalFile = terminal.file;
        terminalName = terminal.name;
        break;
      }
      seenAt.set(key, path.length);
      path.push({ file, name });
      const route = pickRoute(file, name);
      if (!route || !route.target) {
        terminalFile = file;
        terminalName = name;
        break;
      }
      file = route.target;
      name = route.sourceName ?? name;
    }
    let renamedTerminal: RenamedDefinition | undefined;
    for (let i = path.length - 1; i >= 0; i--) {
      const state = path[i];
      const key = `${state.file}\0${state.name}`;
      if (resolvedDefs.has(key)) continue;
      if (state.name === terminalName) {
        resolvedDefs.set(key, terminalFile);
      } else {
        renamedTerminal ??= { file: terminalFile, name: terminalName };
        resolvedDefs.set(key, renamedTerminal);
      }
    }
    return terminalName === requestedName
      ? terminalFile
      : (renamedTerminal ?? { file: terminalFile, name: terminalName });
  };

  /** Resolve many names entering the same barrel as one flowing group. At a
   * mixed named/wildcard file we inspect its sparse exact routes, peel only the
   * matching names, and move the remaining Set down the wildcard edge. This
   * turns a shared L-file/M-name path from O(L·M) into O(L + M + route edges),
   * plus only the work on exact routes that genuinely diverge. */
  const resolveDefs = (
    start: string,
    names: Iterable<string>,
  ): Map<string, ResolvedDefinition> => {
    const results = new Map<string, ResolvedDefinition>();
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
      if (routes?.exact) {
        for (const [name, exact] of routes.exact) {
          if (
            !active.has(name) ||
            (wildcard && exact.order >= wildcard.order)
          ) {
            continue;
          }
          active.delete(name);
          const sourceName = exact.sourceName ?? name;
          const terminal = exact.target
            ? rebaseDefinition(
                resolveDef(exact.target, sourceName),
                sourceName,
                name,
              )
            : file;
          resolvedDefs.set(`${start}\0${name}`, terminal);
          results.set(name, terminal);
        }
      } else {
        const name = routes?.exactName;
        const exact = routes?.exactRoute;
        if (
          name !== undefined &&
          exact &&
          active.has(name) &&
          (!wildcard || exact.order < wildcard.order)
        ) {
          active.delete(name);
          const sourceName = exact.sourceName ?? name;
          const terminal = exact.target
            ? rebaseDefinition(
                resolveDef(exact.target, sourceName),
                sourceName,
                name,
              )
            : file;
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

  const importers = new Map<string, Consumers>(); // "defFile::name" -> unique importing files
  for (const [target, byName] of requests) {
    const defs = resolveDefs(target, byName.keys());
    for (const [name, consumers] of byName) {
      const definition = defs.get(name) ?? target;
      const key = `${definitionFile(definition)}::${definitionName(definition, name)}`;
      const existing = importers.get(key);
      if (existing === undefined) {
        importers.set(key, consumers);
      } else if (typeof existing === 'string') {
        if (typeof consumers === 'string') {
          if (existing !== consumers) {
            importers.set(key, new Set([existing, consumers]));
          }
        } else {
          consumers.add(existing);
          importers.set(key, consumers);
        }
      } else if (typeof consumers === 'string') {
        existing.add(consumers);
      } else {
        for (const fromFile of consumers) existing.add(fromFile);
      }
    }
  }
  const fanIn = new Map<string, number>();
  for (const [key, consumers] of importers) {
    fanIn.set(key, typeof consumers === 'string' ? 1 : consumers.size);
  }
  return fanIn;
}
