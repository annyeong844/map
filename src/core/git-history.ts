import { execFileSync } from 'node:child_process';

/** Process evidence for one file, derived from git history — the signals the
 * defect-prediction literature found to beat static metrics (churn: Nagappan &
 * Ball / Moser; fault recurrence: FixCache, Kim et al.). Read live at query time,
 * NOT stored in the index — the map keeps only stable coordinates. */
export interface FileHistory {
  /** Commits that touched this file (churn). */
  commits: number;
  /** Of those, commits whose message looks like a bug fix (FixCache fault locality). */
  fixes: number;
  /** Days since the file was last touched (recency — lower = hotter). */
  lastTouchedDays: number;
}

/** A commit is a "fix" by message heuristic — the same signal FixCache uses to
 * mark fault occurrences (keyword, not a bug-tracker link; honest approximation). */
const FIX_RE = /\b(fix(e[sd])?|bug|hotfix|patch|revert|regression|defect|fault|broken|crash|incorrect|FP\d)/i;

/**
 * Per-file churn + fix-commit counts from `git log` (one pass, read-only). Returns
 * an empty map when the root isn't a git repo or has no history — callers then
 * fall back to static evidence. `nowMs` makes recency deterministic for callers.
 */
export function computeHistory(root: string, nowMs: number): Map<string, FileHistory> {
  const out = new Map<string, FileHistory>();
  let log: string;
  try {
    log = execFileSync('git', ['-C', root, 'log', '--no-merges', '--name-only', '--format=__C__%x09%ct%x09%s'], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
  } catch {
    return out; // not a git repo / no history → static-only mode
  }

  let isFix = false;
  let ts = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('__C__')) {
      const tab1 = line.indexOf('\t');
      const tab2 = line.indexOf('\t', tab1 + 1);
      ts = Number(line.slice(tab1 + 1, tab2)) * 1000;
      isFix = FIX_RE.test(line.slice(tab2 + 1));
    } else if (line.trim()) {
      const f = line.trim();
      let h = out.get(f);
      if (!h) out.set(f, (h = { commits: 0, fixes: 0, lastTouchedDays: Infinity }));
      h.commits++;
      if (isFix) h.fixes++;
      const ageDays = (nowMs - ts) / 86_400_000;
      if (ageDays < h.lastTouchedDays) h.lastTouchedDays = ageDays;
    }
  }
  return out;
}

/**
 * Symbol-level churn/fix history via `git log -L<start>,<end>:<file>` — follows the
 * exact line range back through history (handling line drift), so it answers
 * "which ROOM in the building churns", not just the file. One git query per symbol
 * and EXPENSIVE (~hundreds of ms each), so callers must restrict it to a shortlist.
 * Returns null when unavailable (no range / not a git repo / error).
 */
export function computeSymbolHistory(root: string, file: string, startLine: number, endLine: number, nowMs: number): FileHistory | null {
  if (!startLine || !endLine || endLine < startLine) return null;
  let log: string;
  try {
    log = execFileSync('git', ['-C', root, 'log', '-L', `${startLine},${endLine}:${file}`, '-s', '--format=%ct%x09%s'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  } catch {
    return null;
  }
  let commits = 0;
  let fixes = 0;
  let lastTouchedDays = Infinity;
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const ts = Number(line.slice(0, tab)) * 1000;
    if (FIX_RE.test(line.slice(tab + 1))) fixes++;
    commits++;
    const ageDays = (nowMs - ts) / 86_400_000;
    if (ageDays < lastTouchedDays) lastTouchedDays = ageDays;
  }
  return { commits, fixes, lastTouchedDays };
}
