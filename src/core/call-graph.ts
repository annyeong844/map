import type { CallSite, ImportEdge } from './extract-symbols.ts';
import { resolveRelative } from './fan-in.ts';
import { locate } from './locate.ts';
import type { MapEntry, MapIndex } from './types.ts';

/**
 * Resolve call sites into caller→callee edges between indexed symbols — the
 * structural level (name + import resolution), without a type checker. A direct
 * call `foo()` resolves to a same-file top-level `foo`, else to an imported `foo`'s
 * definition. Member calls (`obj.m()`) are NOT resolved: picking the right `m`
 * needs type info (a type checker), deliberately out of scope here, so
 * they are omitted rather than guessed. Returns deduped `[fromId, toId]` pairs.
 */
export function computeCallEdges(
  entries: MapEntry[],
  importsByFile: Map<string, ImportEdge[]>,
  callsByFile: Map<string, CallSite[]>,
  files: string[],
): [string, string][] {
  const fileSet = new Set(files);
  // (file, name) → entry id. First definition wins on same-name collisions.
  const defByFileName = new Map<string, Map<string, string>>();
  for (const e of entries) {
    let m = defByFileName.get(e.file);
    if (!m) defByFileName.set(e.file, (m = new Map()));
    if (!m.has(e.name)) m.set(e.name, e.id);
  }

  // (file, class, method) → id, and class → superclass, for resolving this/super.
  const methodsByClass = new Map<string, Map<string, Map<string, string>>>();
  const classExtends = new Map<string, Map<string, string>>();
  for (const e of entries) {
    if (e.kind === 'ClassMethod' && e.className) {
      let byCls = methodsByClass.get(e.file);
      if (!byCls) methodsByClass.set(e.file, (byCls = new Map()));
      let byName = byCls.get(e.className);
      if (!byName) byCls.set(e.className, (byName = new Map()));
      if (!byName.has(e.name)) byName.set(e.name, e.id);
    } else if (e.kind === 'ClassDeclaration' && e.extends) {
      let m = classExtends.get(e.file);
      if (!m) classExtends.set(e.file, (m = new Map()));
      if (!m.has(e.name)) m.set(e.name, e.extends);
    }
  }

  const edges = new Set<string>(); // "fromId\ttoId"
  for (const [file, calls] of callsByFile) {
    const local = defByFileName.get(file);
    if (!local) continue;
    const imports = importsByFile.get(file) ?? [];
    for (const call of calls) {
      // Caller id: exact via its class when known (a method), else by name.
      const fromId = (call.callerClass && methodsByClass.get(file)?.get(call.callerClass)?.get(call.caller)) || local.get(call.caller);
      if (!fromId) continue; // call from module-init or an unindexed scope

      let toId: string | undefined;
      if (call.member) {
        // `this.m()` / `super.m()` resolve to the enclosing class's method (walking
        // the same-file extends chain) — deterministic, no type checker. `obj.m()`
        // (recv 'other') still needs types, so it's left to the possibleCallers floor.
        if (call.recv === 'this' && call.callerClass) {
          toId = resolveMethodInClass(file, call.callerClass, call.callee, methodsByClass, classExtends);
        } else if (call.recv === 'super' && call.callerClass) {
          const sup = classExtends.get(file)?.get(call.callerClass);
          if (sup) toId = resolveMethodInClass(file, sup, call.callee, methodsByClass, classExtends);
        }
      } else {
        toId = local.get(call.callee); // same-file definition
        if (!toId) {
          const imp = imports.find((e) => e.name === call.callee && !e.reexport);
          if (imp) {
            const target = resolveRelative(file, imp.source, fileSet);
            // Follow re-export chains (caller → barrel → … → def), not just one hop.
            if (target) toId = resolveExportedDef(call.callee, target, importsByFile, defByFileName, fileSet, new Set([target]));
          }
        }
      }
      if (!toId || toId === fromId) continue; // unresolved (external/builtin) or self
      edges.add(`${fromId}\t${toId}`);
    }
  }
  return [...edges].map((e) => e.split('\t') as [string, string]);
}

/** Resolve `method` on `className`, walking the same-file extends chain (cycle-guarded).
 * Lets `this.m()` reach an inherited method without a type checker. */
function resolveMethodInClass(
  file: string,
  className: string,
  method: string,
  methodsByClass: Map<string, Map<string, Map<string, string>>>,
  classExtends: Map<string, Map<string, string>>,
): string | undefined {
  const seen = new Set<string>();
  let cls: string | undefined = className;
  while (cls && !seen.has(cls)) {
    seen.add(cls);
    const id = methodsByClass.get(file)?.get(cls)?.get(method);
    if (id) return id;
    cls = classExtends.get(file)?.get(cls);
  }
  return undefined;
}

/**
 * Resolve `name` to its defining entry id starting at `file`, following re-export
 * edges (`export { name } from …` and `export * from …`) transitively through
 * barrels until a real definition is found. Cycle-guarded via `seen`. This is what
 * lets a call through a multi-hop barrel chain land on the true definition rather
 * than dead-ending at the first barrel (which holds an edge, not a symbol).
 */
function resolveExportedDef(
  name: string,
  file: string,
  importsByFile: Map<string, ImportEdge[]>,
  defByFileName: Map<string, Map<string, string>>,
  fileSet: Set<string>,
  seen: Set<string>,
): string | undefined {
  const here = defByFileName.get(file)?.get(name);
  if (here) return here;
  for (const e of importsByFile.get(file) ?? []) {
    if (!e.reexport || (e.name !== name && e.name !== '*')) continue; // re-export of `name`, or `export *`
    const tgt = resolveRelative(file, e.source, fileSet);
    if (!tgt || seen.has(tgt)) continue;
    seen.add(tgt);
    const r = resolveExportedDef(name, tgt, importsByFile, defByFileName, fileSet, seen);
    if (r) return r;
  }
  return undefined;
}

export interface GraphResult {
  symbol: string | null;
  direction: 'callers' | 'callees';
  nodes: { id: string; file: string; line: number; kind: string; depth: number }[];
  /** Present for `callers`: the blast-radius lower bound — method-dispatch callers
   * are NOT in the graph, so this is never "clear". */
  floor?: string;
  /** Present for `callers`: `obj.<name>()` sites — POSSIBLE callers reached via
   * method dispatch. Name-matched & UNVERIFIED (the resolver can't pick the class
   * without types), so reliable for distinctive names, noisy for generic ones.
   * Capped; `floor` carries the true count. */
  possibleCallers?: { file: string; caller: string }[];
}

const POSSIBLE_CALLERS_CAP = 40;

/**
 * Walk the call graph from a symbol — the one navigation primitive. `callers`
 * (reverse) or `callees` (forward), depth-bounded: depth 1 = direct neighbours,
 * depth>1 = transitive (the blast radius). Resolves `ref` to one symbol (exact id
 * else locate's top hit). For `callers` it attaches a `floor` confessing the
 * method-dispatch callers it cannot see — so the result is never read as "clear".
 */
export function graph(index: MapIndex, ref: string, opts: { direction: 'callers' | 'callees'; depth?: number }): GraphResult {
  const dir = opts.direction;
  const maxDepth = Math.max(1, opts.depth ?? 1);
  const targetId = index.entries.find((e) => e.id === ref)?.id ?? locate(index, ref, { limit: 1 })[0]?.id ?? null;
  if (!targetId) return { symbol: null, direction: dir, nodes: [] };

  const adj = new Map<string, string[]>(); // neighbour in the requested direction
  for (const [from, to] of index.callEdges ?? []) {
    const [k, v] = dir === 'callers' ? [to, from] : [from, to];
    const arr = adj.get(k);
    if (arr) arr.push(v);
    else adj.set(k, [v]);
  }
  const seen = new Map<string, number>();
  let frontier = [targetId];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adj.get(id) ?? []) {
        if (n !== targetId && !seen.has(n)) {
          seen.set(n, depth);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  const byId = new Map(index.entries.map((e) => [e.id, e]));
  const nodes = [...seen]
    .map(([id, depth]) => {
      const e = byId.get(id)!;
      return { id, file: e.file, line: e.line, kind: e.kind, depth };
    })
    .sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));

  let floor: string | undefined;
  let possibleCallers: { file: string; caller: string }[] | undefined;
  if (dir === 'callers') {
    const name = byId.get(targetId)!.name;
    const members = possibleMemberCallers(index, name);
    possibleCallers = members.slice(0, POSSIBLE_CALLERS_CAP);
    floor =
      `>= ${nodes.length} caller(s) (direct calls only). ${members.length} possible caller(s) reach "${name}" via obj.${name}() — name-matched & UNVERIFIED (no types), NOT in the graph. LOWER BOUND, never "clear".` +
      (members.length > possibleCallers.length ? ` (listing first ${possibleCallers.length})` : '') +
      (members.length ? ` To VERIFY these (resolve obj.${name}() by type), run code-oracle's \`callers\` on this symbol — the type oracle promotes name-matches to a checker-confirmed set.` : '');
  }
  return { symbol: targetId, direction: dir, nodes, floor, possibleCallers };
}

/** `obj.method()` call sites whose property name matches — POSSIBLE callers the
 * graph can't confirm (method dispatch isn't type-resolved): the blast-radius floor.
 * Deduped by (file, enclosing symbol). */
function possibleMemberCallers(index: MapIndex, name: string): { file: string; caller: string }[] {
  const seen = new Set<string>();
  const out: { file: string; caller: string }[] = [];
  for (const [file, calls] of Object.entries(index.fileCalls ?? {})) {
    for (const c of calls) {
      if (!c.member || c.callee !== name) continue;
      const key = `${file}\t${c.caller}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, caller: c.caller });
    }
  }
  return out;
}
