import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { scheduler } from 'node:timers/promises';
import {
  AdmissionQueue,
  type AdmissionStats,
  ByteLru,
  type ByteLruStats,
} from './runtime-control.ts';

const DIRECTORY_BATCH_SIZE = 32;
const PROJECT_STAT_CONCURRENCY = 64;
const SCAN_YIELD_INTERVAL = 4096;
const STAT_TIME_SCALE = 1000;
const FINGERPRINT_RADIX = 36;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const CACHE_ENTRY_OVERHEAD_BYTES = 64;
const MAX_DEGRADATION_EXAMPLES = 8;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.cache',
  'coverage',
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
  'site-packages',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.eggs',
]);

export type Lang = 'ts' | 'py';
type ProjectFileKind = Lang | `${Lang}-config`;
export type ProjectFile = { signature: string; kind: ProjectFileKind };
export type Epoch = string;
type ProjectScanDegradation = {
  failureCount: number;
  examples: Array<{
    phase: 'list-directory' | 'stat-file';
    path: string;
    message: string;
  }>;
};
export type ProjectSnapshot = {
  epoch: Epoch;
  /** Monotonic process-local id assigned when this root scan starts. */
  scanSerial: number;
  files: Map<string, ProjectFile>;
  residentBytes: number;
  degradation: ProjectScanDegradation | null;
};

interface AbortableFlight<T> {
  controller: AbortController;
  promise: Promise<T>;
}

interface ProjectSnapshotOptions {
  maxActiveScans: number;
  cacheMaxBytes: number;
  cacheIdleMs: number;
  ttlMs: number;
}

interface ProjectSnapshotStats {
  admission: AdmissionStats;
  cache: ByteLruStats;
}

export function langOf(file: string): Lang | null {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) return 'ts';
  if (/\.(py|pyi)$/.test(file)) return 'py';
  return null;
}

function projectFileKind(path: string): ProjectFileKind | null {
  const name = basename(path);
  if (
    /^(?:tsconfig(?:\.[^.]+)?|jsconfig(?:\.[^.]+)?)\.json$/.test(name) ||
    name === 'package.json'
  ) {
    return 'ts-config';
  }
  if (name === 'pyproject.toml' || name === 'setup.cfg') return 'py-config';
  return langOf(path);
}

function fnv1a32(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), FNV_PRIME);
  }
  return hash >>> 0;
}

async function scanProject(
  root: string,
  signal?: AbortSignal,
  scanSerial = 0,
): Promise<ProjectSnapshot> {
  signal?.throwIfAborted();
  let degradationCount = 0;
  const degradationExamples: ProjectScanDegradation['examples'] = [];
  const recordDegradation = (
    phase: ProjectScanDegradation['examples'][number]['phase'],
    path: string,
    error: unknown,
  ): void => {
    degradationCount++;
    if (degradationExamples.length >= MAX_DEGRADATION_EXAMPLES) return;
    degradationExamples.push({
      phase,
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  const dirs = [root];
  const projectFiles: { path: string; kind: ProjectFileKind }[] = [];
  let scannedEntries = 0;
  for (let cursor = 0; cursor < dirs.length; ) {
    signal?.throwIfAborted();
    const batch = dirs.slice(cursor, cursor + DIRECTORY_BATCH_SIZE);
    cursor += batch.length;
    const listings = await Promise.all(
      batch.map(async (dir) => {
        try {
          return { dir, entries: await readdir(dir, { withFileTypes: true }) };
        } catch (error) {
          signal?.throwIfAborted();
          recordDegradation('list-directory', dir, error);
          return { dir, entries: [] };
        }
      }),
    );
    signal?.throwIfAborted();
    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        if (++scannedEntries % SCAN_YIELD_INTERVAL === 0) {
          await scheduler.yield();
          signal?.throwIfAborted();
        }
        if (SKIP_DIRS.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          dirs.push(path);
        } else {
          const kind = projectFileKind(path);
          if (kind) projectFiles.push({ path, kind });
        }
      }
    }
  }

  let cursor = 0;
  let count = 0;
  let xor = 0;
  let sum = 0;
  let residentBytes = CACHE_ENTRY_OVERHEAD_BYTES;
  const files = new Map<string, ProjectFile>();
  const worker = async (): Promise<void> => {
    while (cursor < projectFiles.length) {
      signal?.throwIfAborted();
      const { path, kind } = projectFiles[cursor++];
      try {
        const info = await stat(path);
        const signature = `${info.size}\0${Math.trunc(info.mtimeMs * STAT_TIME_SCALE)}\0${Math.trunc(info.ctimeMs * STAT_TIME_SCALE)}\0${info.ino}`;
        const hash = fnv1a32(`${relative(root, path)}\0${signature}`);
        files.set(path, { signature, kind });
        residentBytes +=
          Buffer.byteLength(path) +
          Buffer.byteLength(signature) +
          Buffer.byteLength(kind) +
          CACHE_ENTRY_OVERHEAD_BYTES;
        xor = (xor ^ hash) >>> 0;
        sum = (sum + hash) >>> 0;
        count++;
      } catch (error) {
        signal?.throwIfAborted();
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : null;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          recordDegradation('stat-file', path, error);
        }
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(PROJECT_STAT_CONCURRENCY, projectFiles.length) },
      worker,
    ),
  );
  signal?.throwIfAborted();
  for (const example of degradationExamples) {
    residentBytes +=
      Buffer.byteLength(example.path) +
      Buffer.byteLength(example.message) +
      CACHE_ENTRY_OVERHEAD_BYTES;
  }
  return {
    epoch: `${count.toString(FINGERPRINT_RADIX)}:${xor.toString(FINGERPRINT_RADIX)}:${sum.toString(FINGERPRINT_RADIX)}`,
    scanSerial,
    files,
    residentBytes,
    degradation:
      degradationCount === 0
        ? null
        : { failureCount: degradationCount, examples: degradationExamples },
  };
}

/** Uncached O(files) pass used by deterministic fingerprint and cancellation tests. */
export async function scanProjectEpoch(
  root: string,
  signal?: AbortSignal,
): Promise<Epoch> {
  return (await scanProject(root, signal)).epoch;
}

/** Bounded seed discovery for optional checker prewarm. This shares the project
 * scanner's directory exclusions without coupling prewarm to a full epoch pass. */
export async function firstSourceFile(
  root: string,
  lang: Lang,
  scanLimit: number,
): Promise<string | null> {
  const sourcePattern =
    lang === 'ts' ? /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/ : /\.(py|pyi)$/;
  const queue = [root];
  let scanned = 0;
  for (let cursor = 0; cursor < queue.length && scanned < scanLimit; cursor++) {
    const dir = queue[cursor];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const subdirectories: string[] = [];
    for (const entry of entries) {
      scanned++;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          subdirectories.push(join(dir, entry.name));
        }
      } else if (
        sourcePattern.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      ) {
        return join(dir, entry.name);
      }
    }
    queue.push(...subdirectories);
  }
  return null;
}

/** Owns project scan deduplication, admission, cancellation, and optional TTL
 * snapshots. It can be disposed and reused by in-process tests. */
export class ProjectSnapshotStore {
  private readonly options: ProjectSnapshotOptions;
  private readonly admission: AdmissionQueue;
  private readonly cache: ByteLru<
    string,
    { at: number; snapshot: ProjectSnapshot }
  >;
  private readonly flights = new Map<
    string,
    AbortableFlight<ProjectSnapshot>
  >();
  private generation = 0;
  private nextScanSerial = 1;
  private readonly latestStartedScan = new Map<string, number>();

  constructor(options: ProjectSnapshotOptions) {
    this.options = options;
    this.admission = new AdmissionQueue(options.maxActiveScans);
    this.cache = new ByteLru(options.cacheMaxBytes, options.cacheIdleMs);
  }

  async snapshot(root: string): Promise<ProjectSnapshot> {
    if (this.options.ttlMs > 0) {
      const cached = this.cache.get(root);
      if (cached && Date.now() - cached.at < this.options.ttlMs) {
        return cached.snapshot;
      }
      if (cached) this.cache.delete(root);
    }
    const active = this.flights.get(root);
    if (active) return active.promise;

    const scanSerial = this.nextScanSerial++;
    this.latestStartedScan.set(root, scanSerial);
    const generation = this.generation;
    const controller = new AbortController();
    const flight = this.admission
      .run(
        () => scanProject(root, controller.signal, scanSerial),
        controller.signal,
      )
      .then((snapshot) => {
        controller.signal.throwIfAborted();
        if (generation === this.generation && this.options.ttlMs > 0) {
          this.cache.set(
            root,
            { at: Date.now(), snapshot },
            Buffer.byteLength(root) +
              snapshot.residentBytes +
              CACHE_ENTRY_OVERHEAD_BYTES,
          );
        }
        return snapshot;
      })
      .finally(() => {
        if (this.flights.get(root)?.promise === flight) {
          this.flights.delete(root);
        }
      });
    this.flights.set(root, { controller, promise: flight });
    return flight;
  }

  /** The first root scan that is guaranteed to start after the current call. */
  nextValidationSerial(root: string): number {
    return (this.latestStartedScan.get(root) ?? 0) + 1;
  }

  dispose(error = new Error('Project snapshot store is shutting down.')): void {
    this.generation++;
    for (const flight of this.flights.values()) {
      flight.controller.abort(error);
    }
    this.admission.cancelQueued(error);
    this.flights.clear();
    this.cache.clear();
    this.latestStartedScan.clear();
  }

  stats(): ProjectSnapshotStats {
    return { admission: this.admission.stats(), cache: this.cache.stats() };
  }
}
