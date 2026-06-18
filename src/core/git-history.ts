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

const NOT_COMMITTED = '0'.repeat(40);

/**
 * Symbol-level churn/fix history via `git blame -L<start>,<end>` — the COMMITS that
 * actually authored the symbol's CURRENT lines, so it answers "which ROOM churns",
 * not just the file. Blame-based (not `git log -L`) on purpose: `git log -L` follows
 * a line range backward and, when a commit both edits a neighbour and adds the range
 * (e.g. extract-function), bleeds the neighbour's history into freshly-added code —
 * over-counting churn on exactly the new symbols. Blame attributes only commits that
 * touched the lines that exist now, so it cannot bleed. The trade: it sees each line's
 * LAST touch, not the full edit history (some depth is lost for correctness). One git
 * query per symbol, EXPENSIVE — callers must restrict it to a shortlist. Null when
 * unavailable (no range / not a git repo / error).
 */
export function computeSymbolHistory(root: string, file: string, startLine: number, endLine: number, nowMs: number): FileHistory | null {
  if (!startLine || !endLine || endLine < startLine) return null;
  let out: string;
  try {
    out = execFileSync('git', ['-C', root, 'blame', `-L${startLine},${endLine}`, '--line-porcelain', '--', file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  } catch {
    return null;
  }
  // Porcelain: each line emits a `<sha> <orig> <final> [n]` header, then fields
  // (committer-time, summary, …). Dedup by sha → distinct commits behind the range.
  const byCommit = new Map<string, { ts: number; fix: boolean }>();
  let sha = '';
  for (const line of out.split('\n')) {
    if (/^[0-9a-f]{40} /.test(line)) {
      sha = line.slice(0, 40);
      if (sha !== NOT_COMMITTED && !byCommit.has(sha)) byCommit.set(sha, { ts: 0, fix: false });
    } else if (line.startsWith('committer-time ')) {
      const c = byCommit.get(sha);
      if (c) c.ts = Number(line.slice(15)) * 1000;
    } else if (line.startsWith('summary ')) {
      const c = byCommit.get(sha);
      if (c) c.fix = FIX_RE.test(line.slice(8));
    }
  }
  if (byCommit.size === 0) return null;
  let commits = 0;
  let fixes = 0;
  let lastTouchedDays = Infinity;
  for (const { ts, fix } of byCommit.values()) {
    commits++;
    if (fix) fixes++;
    const ageDays = (nowMs - ts) / 86_400_000;
    if (ageDays < lastTouchedDays) lastTouchedDays = ageDays;
  }
  return { commits, fixes, lastTouchedDays };
}
