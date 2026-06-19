import { computeHistory, computeSymbolHistory } from './git-history.ts';
import { rankByRisk } from './risk-rank.ts';
import type { MapIndex } from './types.ts';

/** A candidate impact point with the EVIDENCE behind it — never a verdict. The
 * tool points "look here, and here's why"; the LLM reads the raw and judges
 * whether there's actually a bug. (An evidence-advisory pattern — surface the
 * evidence, never the verdict; the map stays coordinates + evidence, meaning is
 * the LLM's.) */
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
    commits: number; // churn — Nagappan-Ball / Moser (process)
    fixes: number; // bug-fix recurrence — FixCache (process; the validated signal)
    lastTouchedDays: number | null; // recency (process)
    fixNeighbors: number; // call-graph neighbours in fix-touched files — FixCache spatial locality
    /** `file` = churn/fixes are the whole file's (cheap); `symbol` = this symbol's
     * own line range via `git blame` (precise mode). */
    scope: 'file' | 'symbol';
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
 * Gather defect-prediction EVIDENCE per candidate (churn, bug-fix recurrence, recency,
 * call-graph spatial locality, static coupling/size). This is the coordinate core's
 * job: surface verifiable signals, decide nothing. The ORDER comes from `rankByRisk`
 * (risk-rank.ts) — a separate, opinionated layer whose weights you can override or
 * ignore; the `score` it attaches is a convenience ordering over the evidence, never a
 * fact about the code. Degrades to static-only evidence when there's no git history.
 *
 * `precise` lowers process evidence from file → symbol (`git blame` per symbol): since
 * a symbol's churn ≤ its file's, the cheap file-level pass is an upper bound, so only a
 * bounded shortlist of the top-ranked candidates is refined (one git query each —
 * EXPENSIVE; opt-in), then re-ranked.
 */
export function hotspots(index: MapIndex, opts: { limit?: number; nowMs: number; file?: string; precise?: boolean }): HotspotReport {
  const limit = opts.limit ?? 25;
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
    const commits = h?.commits ?? 0;
    const fixes = h?.fixes ?? 0;
    const lastTouchedDays = h ? Math.round(h.lastTouchedDays) : null;
    const sizeChars = (e.charEnd ?? 0) - (e.charStart ?? 0);
    const fanIn = e.fanIn ?? 0;

    let fixNeighbors = 0;
    for (const nId of neighbours.get(e.id) ?? []) {
      const ne = byId.get(nId);
      if (ne && (history.get(ne.file)?.fixes ?? 0) > 0) fixNeighbors++;
    }

    out.push({
      id: e.id,
      name: e.name,
      kind: e.kind,
      file: e.file,
      line: e.line,
      score: 0, // ordering is the separate risk-rank layer's job, not the core's
      evidence: { fanIn, sizeChars, commits, fixes, lastTouchedDays, fixNeighbors, scope: 'file' },
    });
  }
  const ranked = rankByRisk(out);

  // Precise mode: refine the top shortlist's EVIDENCE with per-symbol git history, then
  // re-rank (the ranking layer recomputes the score from the refined evidence).
  if (opts.precise && historyAvailable) {
    const k = Math.min(limit * 3, 50);
    const shortlist = ranked.slice(0, k);
    let refined = 0;
    for (const hs of shortlist) {
      const e = byId.get(hs.id);
      const sh = e ? computeSymbolHistory(index.meta.root, hs.file, hs.line, e.endLine ?? hs.line, opts.nowMs) : null;
      if (!sh) continue;
      hs.evidence.commits = sh.commits;
      hs.evidence.fixes = sh.fixes;
      hs.evidence.lastTouchedDays = Number.isFinite(sh.lastTouchedDays) ? Math.round(sh.lastTouchedDays) : null;
      hs.evidence.scope = 'symbol';
      refined++;
    }
    return {
      hotspots: rankByRisk(shortlist).slice(0, limit),
      historyAvailable,
      note: `Precise (symbol-level): refined ${refined} of the top ${shortlist.length} candidates with per-symbol git history (churn/fixes now scope:"symbol"). EVIDENCE, not a verdict — the order is the separate risk heuristic's; read the raw and judge.`,
    };
  }

  const note = historyAvailable
    ? 'EVIDENCE per candidate (bug-fix recurrence + churn + call-graph spatial locality + static coupling/size); the ORDER is a separate, opinionated risk heuristic (risk-rank.ts) you can ignore — read the raw and judge. Process evidence is FILE-level (scope:"file"): every symbol in a file inherits that file\'s churn, so a high rank reads as "this FILE is hot", NOT "this exact symbol" — in a monolith one hot file makes all its symbols look scary. Pass precise for per-symbol git blame (costlier).'
    : 'No git history at this root — STATIC evidence only (fan-in, size). Weaker per the literature; a coarse screen, not a verdict.';

  return { hotspots: ranked.slice(0, limit), historyAvailable, note };
}
