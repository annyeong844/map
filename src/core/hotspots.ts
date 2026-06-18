import { computeHistory } from './git-history.ts';
import type { MapIndex } from './types.ts';

/** A candidate impact point with the EVIDENCE behind it — never a verdict. The
 * tool points "look here, and here's why"; the LLM reads the raw and judges
 * whether there's actually a bug. (Lumin's evidence-advisory pattern; code-map's
 * thesis — coordinates + evidence, meaning stays the LLM's.) */
export interface Hotspot {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  score: number;
  evidence: {
    fanIn: number; // coupling / blast radius (static)
    sizeChars: number; // size as a complexity proxy (static)
    fileCommits: number; // churn — Nagappan-Ball / Moser (process)
    fileFixes: number; // bug-fix recurrence — FixCache (process; the validated signal)
    lastTouchedDays: number | null; // recency (process)
    fixNeighbors: number; // call-graph neighbours in fix-touched files — FixCache spatial locality
  };
}

export interface HotspotReport {
  hotspots: Hotspot[];
  historyAvailable: boolean;
  note: string;
}

/** Type-only declarations — runtime bugs rarely live here, so they're excluded. */
const NON_CODE = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration', 'ExportSpecifier']);

/**
 * Rank impact points by defect-prediction evidence. Process signals (churn, bug-fix
 * recurrence, recency) lead when git history is present — the literature found them
 * stronger than static metrics — with call-graph spatial locality (a neighbour of a
 * fix-touched symbol) and static coupling/size folded in. Degrades to static-only
 * (a coarse screen) when there's no history. The `score` is just a convenience order;
 * the `evidence` columns are the truth, and the tool decides nothing.
 */
export function hotspots(index: MapIndex, opts: { limit?: number; nowMs: number; file?: string }): HotspotReport {
  const history = computeHistory(index.meta.root, opts.nowMs);
  const historyAvailable = history.size > 0;

  const byId = new Map(index.entries.map((e) => [e.id, e]));
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let s = neighbours.get(a);
    if (!s) neighbours.set(a, (s = new Set()));
    s.add(b);
  };
  for (const [from, to] of index.callEdges ?? []) {
    link(from, to);
    link(to, from);
  }

  const fileNeedle = (opts.file ?? '').toLowerCase();
  const out: Hotspot[] = [];
  for (const e of index.entries) {
    if (NON_CODE.has(e.kind)) continue;
    if (fileNeedle && !e.file.toLowerCase().includes(fileNeedle)) continue;

    const h = history.get(e.file);
    const fileCommits = h?.commits ?? 0;
    const fileFixes = h?.fixes ?? 0;
    const lastTouchedDays = h ? Math.round(h.lastTouchedDays) : null;
    const sizeChars = (e.charEnd ?? 0) - (e.charStart ?? 0);
    const fanIn = e.fanIn ?? 0;

    let fixNeighbors = 0;
    for (const nId of neighbours.get(e.id) ?? []) {
      const ne = byId.get(nId);
      if (ne && (history.get(ne.file)?.fixes ?? 0) > 0) fixNeighbors++;
    }

    const recencyBoost = lastTouchedDays != null && lastTouchedDays < 90 ? 1 : 0;
    const score =
      3 * fileFixes + // validated process signal leads
      1.5 * fixNeighbors + // spatial locality
      Math.log(fileCommits + 1) + // churn
      recencyBoost +
      0.4 * Math.log(fanIn + 1) + // static coupling (fallback)
      0.25 * Math.min(sizeChars / 1000, 20); // static size (fallback)

    out.push({ id: e.id, name: e.name, kind: e.kind, file: e.file, line: e.line, score, evidence: { fanIn, sizeChars, fileCommits, fileFixes, lastTouchedDays, fixNeighbors } });
  }

  out.sort((a, b) => b.score - a.score || b.evidence.fanIn - a.evidence.fanIn || a.file.localeCompare(b.file) || a.line - b.line);

  const note = historyAvailable
    ? 'Ranked by bug-fix recurrence + churn + call-graph spatial locality + static coupling/size. EVIDENCE, not a verdict — read the raw and judge. Process evidence is file-level (a hot file lifts all its symbols; static + spatial discriminate within it).'
    : 'No git history at this root — STATIC evidence only (fan-in, size). Weaker per the literature; a coarse screen, not a verdict.';

  return { hotspots: out.slice(0, opts.limit ?? 30), historyAvailable, note };
}
