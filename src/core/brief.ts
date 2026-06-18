import { callNeighbors, impactSet, possibleMemberCallers, sameNameSiblings } from './call-graph.ts';
import { locate } from './locate.ts';
import { read } from './read.ts';
import type { MapEntry, MapIndex } from './types.ts';

/**
 * A pre-change "blast-radius brief" for one symbol — read-only synthesis the LLM
 * consults before acting. It never decides anything; it lays out the evidence:
 * the exact raw, what the symbol calls and who calls it, OTHER definitions of the
 * same name (vendored copies / overloads — "buildings that look alike"), and a
 * transitive impact set. Crucially the `floor` line confesses incompleteness:
 * method-dispatch callers aren't in the graph, so the impact is a LOWER BOUND —
 * never reported as "clear". Pretending otherwise is how you hit the wrong target.
 */
export interface Brief {
  target: { id: string; file: string; line: number; endLine?: number; kind: string; raw: string | null } | null;
  siblings: MapEntry[];
  callees: MapEntry[];
  callers: MapEntry[];
  impact: { id: string; file: string; line: number; kind: string; depth: number }[];
  possibleMemberCallers: { file: string; caller: string }[];
  floor: string;
}

export function blastRadiusBrief(index: MapIndex, ref: string, opts: { depth?: number } = {}): Brief {
  const empty: Brief = { target: null, siblings: [], callees: [], callers: [], impact: [], possibleMemberCallers: [], floor: `no symbol matches "${ref}"` };
  const id = index.entries.find((e) => e.id === ref)?.id ?? locate(index, ref, { limit: 1 })[0]?.id;
  if (!id) return empty;
  const entry = index.entries.find((e) => e.id === id)!;
  const byId = new Map(index.entries.map((e) => [e.id, e]));

  const r = read(index, id);
  const callees = callNeighbors(index, id, 'callees').entries;
  const callers = callNeighbors(index, id, 'callers').entries;
  const impact = impactSet(index, id, opts.depth ?? 6).map(({ id: i, depth }) => {
    const e = byId.get(i)!;
    return { id: i, file: e.file, line: e.line, kind: e.kind, depth };
  });
  const siblings = sameNameSiblings(index, id);
  const members = possibleMemberCallers(index, entry.name);

  const floor =
    `≥ ${impact.length} symbol(s) transitively affected (direct calls only). ` +
    `${members.length} possible caller(s) reach "${entry.name}" via method dispatch (obj.${entry.name}()) and are NOT counted — LOWER BOUND, never "clear". ` +
    `${siblings.length} other definition(s) named "${entry.name}" exist — confirm from the raw which one this is.`;

  return {
    target: { id, file: entry.file, line: entry.line, endLine: entry.endLine, kind: entry.kind, raw: r.raw },
    siblings,
    callees,
    callers,
    impact,
    possibleMemberCallers: members,
    floor,
  };
}
