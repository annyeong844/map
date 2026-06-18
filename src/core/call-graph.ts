import type { CallSite, ImportEdge } from './extract-symbols.ts';
import { resolveRelative } from './fan-in.ts';
import { locate } from './locate.ts';
import type { MapEntry, MapIndex } from './types.ts';

/**
 * Resolve call sites into caller→callee edges between indexed symbols — Lumin's
 * Level 1 (structural), reproduced without the type checker. A direct call
 * `foo()` resolves to a same-file top-level `foo`, else to an imported `foo`'s
 * definition. Member calls (`obj.m()`) are NOT resolved: picking the right `m`
 * needs type info (Lumin's Level 2 uses tsc), deliberately out of scope here, so
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

  const edges = new Set<string>(); // "fromId\ttoId"
  for (const [file, calls] of callsByFile) {
    const local = defByFileName.get(file);
    if (!local) continue;
    const imports = importsByFile.get(file) ?? [];
    for (const call of calls) {
      if (call.member) continue; // method dispatch — needs type info; omitted
      const fromId = local.get(call.caller);
      if (!fromId) continue; // call from module-init or an unindexed scope
      let toId = local.get(call.callee); // same-file definition
      if (!toId) {
        const imp = imports.find((e) => e.name === call.callee && !e.reexport);
        if (imp) {
          const target = resolveRelative(file, imp.source, fileSet);
          if (target) toId = defByFileName.get(target)?.get(call.callee);
        }
      }
      if (!toId || toId === fromId) continue; // unresolved (external/builtin) or self
      edges.add(`${fromId}\t${toId}`);
    }
  }
  return [...edges].map((e) => e.split('\t') as [string, string]);
}

export interface GraphResult {
  symbol: string | null;
  direction: 'callers' | 'callees';
  nodes: { id: string; file: string; line: number; kind: string; depth: number }[];
  /** Present for `callers`: the blast-radius lower bound — method-dispatch callers
   * are NOT in the graph, so this is never "clear". */
  floor?: string;
}

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
  if (dir === 'callers') {
    const name = byId.get(targetId)!.name;
    const members = possibleMemberCallers(index, name);
    floor = `>= ${nodes.length} caller(s) (direct calls only). ${members.length} possible caller(s) reach "${name}" via obj.${name}() and are NOT counted — LOWER BOUND, never "clear".`;
  }
  return { symbol: targetId, direction: dir, nodes, floor };
}

/** `obj.method()` call sites whose property name matches — POSSIBLE callers the
 * graph can't confirm (method dispatch isn't type-resolved): the blast-radius floor. */
function possibleMemberCallers(index: MapIndex, name: string): { file: string; caller: string }[] {
  const out: { file: string; caller: string }[] = [];
  for (const [file, calls] of Object.entries(index.fileCalls ?? {})) {
    for (const c of calls) if (c.member && c.callee === name) out.push({ file, caller: c.caller });
  }
  return out;
}
