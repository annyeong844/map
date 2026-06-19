import type { Hotspot } from './hotspots.ts';

/**
 * The OPINIONATED layer — deliberately NOT in the coordinate core.
 *
 * `hotspots` gathers verifiable *evidence* (churn, bug-fix recurrence, fan-in, size,
 * recency, fix-neighbours). Turning that into a single ranked order needs WEIGHTS, and
 * weights are a judgment — exactly the kind of "meaning" the map refuses to bake in. So
 * the scoring + sort live here, apart, and are easy to override or ignore: the score is
 * a convenience ordering OVER the evidence, never a fact ABOUT the code. The weights are
 * literature-informed (FixCache: bug-fix recurrence + spatial locality lead; churn next;
 * static coupling/size as fallbacks) but still a choice.
 */
export function riskScore(ev: Hotspot['evidence']): number {
  const recencyBoost = ev.lastTouchedDays != null && ev.lastTouchedDays < 90 ? 1 : 0;
  return (
    3 * ev.fixes + // validated process signal leads
    1.5 * ev.fixNeighbors + // spatial locality
    Math.log(ev.commits + 1) + // churn
    recencyBoost +
    0.4 * Math.log(ev.fanIn + 1) + // static coupling (fallback)
    0.25 * Math.min(ev.sizeChars / 1000, 20) // static size (fallback)
  );
}

/** Order candidates by the risk heuristic (ties: fan-in, then file/line). Returns new
 * objects with `score` filled from current evidence — call again after refining. */
export function rankByRisk(hotspots: Hotspot[]): Hotspot[] {
  return hotspots
    .map((h) => ({ ...h, score: riskScore(h.evidence) }))
    .sort((a, b) => b.score - a.score || b.evidence.fanIn - a.evidence.fanIn || a.file.localeCompare(b.file) || a.line - b.line);
}
