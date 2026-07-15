import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { scheduler } from 'node:timers/promises';
import { listSourceFiles } from './files.ts';
import { type FileStat, INDEX_VERSION, type MapIndex } from './types.ts';

const SCAN_YIELD_INTERVAL = 4096;
// Windows UNC and native Linux can round the same WSL nanosecond timestamp one
// IEEE-754 step apart (observed maximum: 0.000244140625 ms). Stay below 1 µs so
// real ctime changes still protect same-size/restored-mtime edits.
const FILE_TIME_EPSILON_MS = 0.0005;

export interface IndexDriftScan {
  root: string;
  files: string[];
  stats: Map<string, FileStat | null>;
  previous: MapIndex | null;
  compatible: boolean;
  reusableFiles: string[];
  changedFiles: string[];
  added: number;
  modified: number;
  removed: number;
  totalChanged: number;
}

export interface AutoIndexDecision {
  rebuild: boolean;
  reason: 'current' | 'missing-index' | 'incompatible-index' | 'large-change';
  threshold: number;
}

async function statAll(
  root: string,
  files: string[],
  signal?: AbortSignal,
  concurrency = 64,
): Promise<Map<string, FileStat | null>> {
  const out = new Map<string, FileStat | null>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      signal?.throwIfAborted();
      const file = files[cursor++];
      try {
        const current = await stat(join(root, file));
        out.set(file, {
          mtimeMs: current.mtimeMs,
          size: current.size,
          ctimeMs: current.ctimeMs,
          ino: current.ino,
        });
      } catch {
        signal?.throwIfAborted();
        out.set(file, null);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker),
  );
  return out;
}

function sameFile(
  previous: FileStat | undefined,
  current: FileStat | null,
): boolean {
  return (
    !!previous &&
    !!current &&
    Math.abs(previous.mtimeMs - current.mtimeMs) <= FILE_TIME_EPSILON_MS &&
    previous.size === current.size &&
    (previous.ctimeMs === undefined ||
      (current.ctimeMs !== undefined &&
        Math.abs(previous.ctimeMs - current.ctimeMs) <=
          FILE_TIME_EPSILON_MS)) &&
    (previous.ino === undefined || previous.ino === current.ino)
  );
}

/** Read-free source drift scan shared by manual and automatic incremental builds. */
export async function scanIndexDrift(
  rootInput: string,
  previousInput?: MapIndex | null,
  force = false,
  signal?: AbortSignal,
): Promise<IndexDriftScan> {
  const root = resolve(rootInput);
  const listedFiles = await listSourceFiles(root, signal);
  const stats = await statAll(root, listedFiles, signal);
  // `git ls-files --cached` includes tracked paths deleted from the working tree.
  // They are not current source files. Keeping null-stat paths would label them
  // "added" on every subsequent scan and could trigger an endless auto-rebuild.
  const files = listedFiles.filter((file) => stats.get(file) !== null);
  signal?.throwIfAborted();
  const previous = previousInput ?? null;
  const priorStats = previous?.fileStats ?? {};
  const compatible =
    !!previous &&
    !force &&
    previous.meta.version === INDEX_VERSION &&
    !!previous.fileStats &&
    resolve(previous.meta.root) === root;
  const reusableFiles: string[] = [];
  const changedFiles: string[] = [];
  let added = 0;
  let modified = 0;
  let compared = 0;

  for (const file of files) {
    if (++compared % SCAN_YIELD_INTERVAL === 0) await scheduler.yield();
    signal?.throwIfAborted();
    const prior = priorStats[file];
    if (
      compatible &&
      previous!.fileTokens[file] !== undefined &&
      sameFile(prior, stats.get(file) ?? null)
    ) {
      reusableFiles.push(file);
    } else {
      changedFiles.push(file);
      if (prior) modified++;
      else added++;
    }
  }

  let removed = 0;
  // `stats` already is the current-file membership table; null is a tracked path
  // deleted from the working tree and therefore counts as removed, not present.
  for (const file in priorStats) {
    if (++compared % SCAN_YIELD_INTERVAL === 0) await scheduler.yield();
    signal?.throwIfAborted();
    if (Object.hasOwn(priorStats, file) && !stats.get(file)) removed++;
  }

  return {
    root,
    files,
    stats,
    previous,
    compatible,
    reusableFiles,
    changedFiles,
    added,
    modified,
    removed,
    totalChanged: added + modified + removed,
  };
}

/** Adaptive "large change" gate: sqrt(project files), with schema/missing indexes immediate. */
export function autoIndexDecision(scan: IndexDriftScan): AutoIndexDecision {
  let priorCount = scan.previous?.meta.fileCount;
  if (priorCount === undefined) {
    priorCount = 0;
    const priorStats = scan.previous?.fileStats ?? {};
    for (const file in priorStats) {
      if (Object.hasOwn(priorStats, file)) priorCount++;
    }
  }
  const population = Math.max(1, scan.files.length, priorCount);
  const threshold = Math.max(1, Math.ceil(Math.sqrt(population)));
  if (!scan.previous) {
    return { rebuild: true, reason: 'missing-index', threshold };
  }
  if (!scan.compatible) {
    return { rebuild: true, reason: 'incompatible-index', threshold };
  }
  if (scan.totalChanged >= threshold) {
    return { rebuild: true, reason: 'large-change', threshold };
  }
  return { rebuild: false, reason: 'current', threshold };
}
