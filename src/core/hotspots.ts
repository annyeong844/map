import { computeHistory, computeSymbolHistory } from './git-history.ts';
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
     * own line range via `git log -L` (precise mode). */
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

function scoreOf(commits: number, fixes: number, fixNeighbors: number, fanIn: number, sizeChars: number, lastTouchedDays: number | null): number {
  const recencyBoost = lastTouchedDays != null && lastTouchedDays < 90 ? 1 : 0;
  return (
    3 * fixes + // validated process signal leads
    1.5 * fixNeighbors + // spatial locality
    Math.log(commits + 1) + // churn
    recencyBoost +
    0.4 * Math.log(fanIn + 1) + // static coupling (fallback)
    0.25 * Math.min(sizeChars / 1000, 20) // static size (fallback)
  );
}

/**
 * Rank impact points by defect-prediction evidence. Process signals (churn, bug-fix
 * recurrence, recency) lead when git history is present — the literature found them
 * stronger than static metrics — with call-graph spatial locality and static
 * coupling/size folded in. Degrades to static-only when there's no history.
 *
 * `precise` lowers process evidence from file → symbol (`git log -L` per symbol):
 * since a symbol's churn ≤ its file's, the cheap file-level pass is an upper bound,
 * so we only refine a bounded shortlist of the top candidates (one git query each —
 * EXPENSIVE; opt-in). The `score` is a convenience order; the `evidence` is the truth,
 * and the tool decides nothing.
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
      score: scoreOf(commits, fixes, fixNeighbors, fanIn, sizeChars, lastTouchedDays),
      evidence: { fanIn, sizeChars, commits, fixes, lastTouchedDays, fixNeighbors, scope: 'file' },
    });
  }
  out.sort((a, b) => b.score - a.score || b.evidence.fanIn - a.evidence.fanIn || a.file.localeCompare(b.file) || a.line - b.line);

  // Precise mode: refine the top shortlist with per-symbol git history, then re-rank.
  if (opts.precise && historyAvailable) {
    const k = Math.min(limit * 3, 50);
    const shortlist = out.slice(0, k);
    let refined = 0;
    for (const hs of shortlist) {
      const e = byId.get(hs.id);
      const sh = e ? computeSymbolHistory(index.meta.root, hs.file, hs.line, e.endLine ?? hs.line, opts.nowMs) : null;
      if (!sh) continue;
      hs.evidence.commits = sh.commits;
      hs.evidence.fixes = sh.fixes;
      hs.evidence.lastTouchedDays = Number.isFinite(sh.lastTouchedDays) ? Math.round(sh.lastTouchedDays) : null;
      hs.evidence.scope = 'symbol';
      hs.score = scoreOf(sh.commits, sh.fixes, hs.evidence.fixNeighbors, hs.evidence.fanIn, hs.evidence.sizeChars, sh.lastTouchedDays);
      refined++;
    }
    shortlist.sort((a, b) => b.score - a.score || b.evidence.fanIn - a.evidence.fanIn || a.file.localeCompare(b.file) || a.line - b.line);
    return {
      hotspots: shortlist.slice(0, limit),
      historyAvailable,
      note: `Precise (symbol-level): refined ${refined} of the top ${shortlist.length} candidates with per-symbol git history (churn/fixes now scope:"symbol"). EVIDENCE, not a verdict — read the raw and judge.`,
    };
  }

  const note = historyAvailable
    ? 'Ranked by bug-fix recurrence + churn + call-graph spatial locality + static coupling/size. EVIDENCE, not a verdict — read the raw and judge. Process evidence is FILE-level (scope:"file") — pass precise for symbol-level.'
    : 'No git history at this root — STATIC evidence only (fan-in, size). Weaker per the literature; a coarse screen, not a verdict.';

  return { hotspots: out.slice(0, limit), historyAvailable, note };
}
