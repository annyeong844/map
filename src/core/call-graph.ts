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

/**
 * Direct callers/callees of a symbol. Resolves `ref` to one symbol (exact id, else
 * locate's top hit) and walks `callEdges`. Shared by the CLI and the MCP server so
 * both expose the same graph.
 */
export function callNeighbors(index: MapIndex, ref: string, dir: 'callers' | 'callees'): { symbol: string | null; entries: MapEntry[] } {
  const targetId = index.entries.find((e) => e.id === ref)?.id ?? locate(index, ref, { limit: 1 })[0]?.id ?? null;
  if (!targetId) return { symbol: null, entries: [] };
  const byId = new Map(index.entries.map((e) => [e.id, e]));
  const edges = index.callEdges ?? [];
  const ids = dir === 'callers' ? edges.filter(([, to]) => to === targetId).map(([from]) => from) : edges.filter(([from]) => from === targetId).map(([, to]) => to);
  const entries = [...new Set(ids)].map((id) => byId.get(id)).filter((e): e is MapEntry => !!e);
  return { symbol: targetId, entries };
}
