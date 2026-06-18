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

/** Transitive callers (reverse-BFS over callEdges, depth-bounded) — the real blast
 * radius: every symbol that transitively reaches the target. Excludes the target. */
export function impactSet(index: MapIndex, startId: string, maxDepth = 6): { id: string; depth: number }[] {
  const rev = new Map<string, string[]>(); // callee → its direct callers
  for (const [from, to] of index.callEdges ?? []) {
    const arr = rev.get(to);
    if (arr) arr.push(from);
    else rev.set(to, [from]);
  }
  const seen = new Map<string, number>();
  let frontier = [startId];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const caller of rev.get(id) ?? []) {
        if (caller !== startId && !seen.has(caller)) {
          seen.set(caller, depth);
          next.push(caller);
        }
      }
    }
    frontier = next;
  }
  return [...seen].map(([id, depth]) => ({ id, depth })).sort((a, b) => a.depth - b.depth);
}

/** `obj.method()` call sites whose property name matches — POSSIBLE callers the
 * graph can't confirm (method dispatch isn't type-resolved). The blast-radius
 * floor: these are why an impact set is a lower bound, never "clear". */
export function possibleMemberCallers(index: MapIndex, name: string): { file: string; caller: string }[] {
  const out: { file: string; caller: string }[] = [];
  for (const [file, calls] of Object.entries(index.fileCalls ?? {})) {
    for (const c of calls) if (c.member && c.callee === name) out.push({ file, caller: c.caller });
  }
  return out;
}

/** Other definitions sharing the target's name — vendored copies / overloads.
 * The tool never picks which is "the" one; it surfaces them for the LLM to judge. */
export function sameNameSiblings(index: MapIndex, id: string): MapEntry[] {
  const self = index.entries.find((e) => e.id === id);
  if (!self) return [];
  return index.entries.filter((e) => e.name === self.name && e.file !== self.file);
}
