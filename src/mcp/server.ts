#!/usr/bin/env node
/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), zero deps.
 *
 * It exposes ONE tool — `read` — and nothing else: given a symbol id or a bare
 * name, it returns the RAW source slice (the symbol's own bytes, not the whole
 * file), drift-resistant (re-anchors when the file moved). Coordinates, never
 * meaning — the model does the interpreting. Search with your normal grep; this
 * just pulls the exact slice cheaply.
 *
 *   MAP_INDEX=/path/.map-index.json  node src/mcp/server.ts
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  type FSWatcher,
  realpathSync,
  statSync,
  watch as watchFs,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NdjsonDecoder, type NdjsonEvent } from './ndjson.ts';
import {
  changedSourceFiles,
  fileIdentity,
  type FileIdentity,
  resolveLocalModuleFiles,
  sourceIdentitySnapshot,
} from './source-identity.ts';
export { sourceIdentityChanged } from './source-identity.ts';
export type { FileIdentity } from './source-identity.ts';
import {
  autoIndexDecision,
  type IndexDriftScan,
  scanIndexDrift,
} from '../core/index-drift.ts';
import { changed, read, readMany } from '../core/read.ts';
import { loadIndex, prepareLookup, saveIndex } from '../core/store.ts';
import {
  INDEX_VERSION,
  type MapIndex,
  type ReadResult,
} from '../core/types.ts';
import { isRecord } from '../core/util.ts';
import { VERSION } from '../version.ts';

const PROTOCOL = '2025-06-18';
// oxlint-disable-next-line no-magic-numbers -- JSON-RPC 2.0 standard error code.
const JSON_RPC_INVALID_REQUEST = -32600;
// oxlint-disable-next-line no-magic-numbers -- JSON-RPC 2.0 standard error code.
const JSON_RPC_PARSE_ERROR = -32700;
const SERVER_INSTRUCTIONS = [
  'Known symbol: call read directly. Unknown name or location: use rg first.',
  'Pass the absolute repository root and repository-relative ref(s). Batch independent refs, prefer responseFormat:"compact", and use changedOnly only for refs read earlier in this session.',
  'Use diagnostics for suspected stale processes. Judge the returned raw source, not index metadata.',
].join(' ');

/** Walk up from `start` looking for `name`; null if never found. */
function findUp(name: string, start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, name))) return join(dir, name);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Default index location: explicit env/flag, else auto-detected by walking up
// from the server cwd. Per-call `root` selection overrides this default below.
const configuredIndexPath = process.env.MAP_INDEX ?? argIndex();
const MAX_INDEX_RUNTIMES = 8;
const MAX_INVALID_FILE_DIAGNOSTICS = 8;
const MAX_OBSERVATIONS = 8192;
const DEFAULT_AUTO_INDEX_POLL_MS = 2_000;
const DEFAULT_MAX_ACTIVE_INDEXES = 2;
const DEFAULT_MAX_INFLIGHT_REQUESTS = 32;
// oxlint-disable-next-line no-magic-numbers -- 8 MiB protocol safety default.
const DEFAULT_MAX_NDJSON_LINE_BYTES = 8 * 1024 * 1024;
const AUTO_INDEX_ENABLED = !/^(?:0|false|off)$/i.test(
  process.env.CODE_MAP_AUTO_INDEX?.trim() ?? 'large',
);
const AUTO_INDEX_POLL_MS = positiveInteger(
  process.env.CODE_MAP_AUTO_INDEX_POLL_MS,
  DEFAULT_AUTO_INDEX_POLL_MS,
);
const MAX_ACTIVE_INDEXES = positiveInteger(
  process.env.CODE_MAP_MAX_ACTIVE_INDEXES,
  DEFAULT_MAX_ACTIVE_INDEXES,
);
const MAX_INFLIGHT_REQUESTS = positiveInteger(
  process.env.CODE_MAP_MAX_INFLIGHT_REQUESTS,
  DEFAULT_MAX_INFLIGHT_REQUESTS,
);
const MAX_NDJSON_LINE_BYTES = positiveInteger(
  process.env.CODE_MAP_MAX_NDJSON_LINE_BYTES,
  DEFAULT_MAX_NDJSON_LINE_BYTES,
);
const SOURCE_IDENTITY_POLL_MS = 2_000;
const INSTANCE_STARTED_AT = new Date().toISOString();
const SERVER_FILE = fileURLToPath(import.meta.url);
const SERVER_SOURCE_SPECIFIERS = [
  '../core/build-index.js',
  '../core/extract-symbols.js',
  '../core/fan-in.js',
  '../core/files.js',
  '../core/index-drift.js',
  '../core/locate.js',
  '../core/python-command.js',
  '../core/read.js',
  '../core/store.js',
  '../core/types.js',
  '../core/util.js',
  '../version.js',
  './ndjson.js',
  './source-identity.js',
] as const;
export const MCP_SOURCE_FILES = resolveLocalModuleFiles(
  SERVER_FILE,
  SERVER_SOURCE_SPECIFIERS,
);

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

interface AdmissionStats {
  limit: number;
  active: number;
  queued: number;
  maxActive: number;
  maxQueued: number;
}

interface AdmissionWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

class AdmissionQueue {
  readonly limit: number;
  private active = 0;
  private maxActive = 0;
  private maxQueued = 0;
  private nextWaiterId = 1;
  private readonly waiters = new Map<number, AdmissionWaiter>();

  constructor(limit: number) {
    this.limit = limit;
  }

  private abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error('Queued work was aborted.', { cause: signal.reason });
  }

  private grant(): () => void {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.size > 0) {
      const next = this.waiters.entries().next();
      if (next.done) return;
      const [id, waiter] = next.value;
      this.waiters.delete(id);
      if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener('abort', waiter.abort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(this.abortError(waiter.signal));
        continue;
      }
      waiter.resolve(this.grant());
    }
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(this.abortError(signal));
    if (this.active < this.limit) return Promise.resolve(this.grant());
    return new Promise((grantWaiter, reject) => {
      const id = this.nextWaiterId++;
      const waiter: AdmissionWaiter = {
        resolve: grantWaiter,
        reject,
        signal,
      };
      if (signal) {
        const abort = () => {
          if (!this.waiters.delete(id)) return;
          signal.removeEventListener('abort', abort);
          reject(this.abortError(signal));
        };
        waiter.abort = abort;
        signal.addEventListener('abort', abort, { once: true });
      }
      this.waiters.set(id, waiter);
      this.maxQueued = Math.max(this.maxQueued, this.waiters.size);
    });
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  cancelQueued(error: Error): void {
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id);
      if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener('abort', waiter.abort);
      }
      waiter.reject(error);
    }
  }

  stats(): AdmissionStats {
    return {
      limit: this.limit,
      active: this.active,
      queued: this.waiters.size,
      maxActive: this.maxActive,
      maxQueued: this.maxQueued,
    };
  }
}

const indexAdmission = new AdmissionQueue(MAX_ACTIVE_INDEXES);
let activeMcpRequests = 0;
let maxObservedMcpRequests = 0;
let queuedMcpRequests = 0;
let maxObservedQueuedMcpRequests = 0;

const SERVER_SOURCE_IDENTITIES_AT_START =
  sourceIdentitySnapshot(MCP_SOURCE_FILES);
const SERVER_SOURCE_AT_START = fileIdentity(SERVER_FILE);
let serverSourceNow = SERVER_SOURCE_AT_START;
let serverSourceCheckedAt = Date.now();
let serverRestartRequired = false;
let serverChangedSourceFiles: string[] = [];

/** Resolve an explicit index, or discover the nearest one from `start`. Kept as
 * a function because an index may be created after the long-lived server starts. */
export function resolveIndexPath(
  start: string,
  explicit = configuredIndexPath,
): string {
  const hostStart = toHostPath(start);
  const hostExplicit = explicit ? toHostPath(explicit) : explicit;
  return hostExplicit
    ? resolve(hostStart, hostExplicit)
    : (findUp('.map-index.json', hostStart) ??
        resolve(hostStart, '.map-index.json'));
}

/** Accept either side's spelling when a Windows-hosted server serves WSL (or a
 * WSL-hosted server receives a Windows path). Native Linux paths pass through. */
export function toHostPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  wslDistro = process.env.WSL_DISTRO_NAME,
): string {
  if (platform === 'win32') {
    const wsl = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(path);
    return wsl
      ? `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}`
      : path;
  }
  if (platform === 'linux') {
    const unc =
      /^(?:\\\\|\/\/)(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/iu.exec(
        path,
      );
    if (unc && wslDistro && unc[1].toLowerCase() === wslDistro.toLowerCase()) {
      return `/${(unc[2] ?? '').replace(/\\/g, '/')}`;
    }
    const windows = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
    return windows
      ? `/mnt/${windows[1].toLowerCase()}/${windows[2].replace(/\\/g, '/')}`
      : path;
  }
  return path;
}

interface IndexRuntime {
  index: MapIndex | null;
  mtimeMs: number;
  size: number;
  ctimeMs: number;
  ino: number;
  observations: Map<string, string>;
  root: string | null;
  watcher: FSWatcher | null;
  watcherUnavailable: boolean;
  changeGeneration: number;
  checkedGeneration: number;
  lastCheckAt: number;
}

// A global MCP can serve several workspaces. Keep the warmed lookup tables for
// the most recent few, but bound them so arbitrary roots cannot grow memory forever.
const indexRuntimes = new Map<string, IndexRuntime>();

function runtimeFor(indexPath: string): IndexRuntime {
  const cached = indexRuntimes.get(indexPath);
  if (cached) {
    indexRuntimes.delete(indexPath);
    indexRuntimes.set(indexPath, cached);
    return cached;
  }
  const runtime: IndexRuntime = {
    index: null,
    mtimeMs: 0,
    size: -1,
    ctimeMs: 0,
    ino: -1,
    observations: new Map(),
    root: null,
    watcher: null,
    watcherUnavailable: false,
    changeGeneration: 1,
    checkedGeneration: 0,
    lastCheckAt: 0,
  };
  indexRuntimes.set(indexPath, runtime);
  if (indexRuntimes.size > MAX_INDEX_RUNTIMES) {
    const oldestEntry = indexRuntimes.keys().next();
    if (!oldestEntry.done) {
      const oldest = oldestEntry.value;
      disposeRuntime(indexRuntimes.get(oldest));
      indexRuntimes.delete(oldest);
    }
  }
  return runtime;
}

function disposeRuntime(runtime: IndexRuntime | undefined): void {
  if (!runtime?.watcher) return;
  const watcher = runtime.watcher;
  runtime.watcher = null;
  watcher.close();
}

function ensureRootWatch(runtime: IndexRuntime, rootInput: string): void {
  const resolvedRoot = resolve(rootInput);
  let root = resolvedRoot;
  try {
    root = realpathSync(resolvedRoot);
  } catch {
    // A disappearing root falls through to the watcher fallback below.
  }
  if (
    runtime.root === root &&
    (runtime.watcher || runtime.watcherUnavailable)
  ) {
    return;
  }
  disposeRuntime(runtime);
  runtime.root = root;
  runtime.watcherUnavailable = false;
  runtime.changeGeneration++;
  try {
    const watcher = watchFs(root, { recursive: true }, (_event, filename) => {
      const changedPath = filename
        ? String(filename).replaceAll('\\', '/')
        : '';
      const leaf = changedPath.slice(changedPath.lastIndexOf('/') + 1);
      if (leaf.startsWith('.map-index.json')) return;
      runtime.changeGeneration++;
    });
    watcher.unref();
    const useFallback = (): void => {
      if (runtime.watcher === watcher) {
        disposeRuntime(runtime);
        runtime.watcherUnavailable = true;
        runtime.changeGeneration++;
      }
    };
    watcher.on('error', useFallback);
    watcher.on('close', useFallback);
    runtime.watcher = watcher;
  } catch {
    runtime.watcherUnavailable = true;
  }
}

/**
 * (Re)load the index when its file appears or changes. Called before every tool
 * call, so a `map index` rebuild — or the first build in a fresh project — is
 * picked up with no client reconnect. A missing/half-written index is non-fatal:
 * the server stays up and retries on the next call.
 */
function ensureFresh(indexPath: string): IndexRuntime {
  const runtime = runtimeFor(indexPath);
  let mtimeMs: number;
  let size: number;
  let ctimeMs: number;
  let ino: number;
  try {
    const s = statSync(indexPath);
    mtimeMs = s.mtimeMs;
    size = s.size;
    ctimeMs = s.ctimeMs;
    ino = s.ino;
  } catch {
    return runtime; // no index yet (or mid-write) — keep the prior good copy, if any
  }
  // ctime/inode catch same-size rewrites with a restored/coarse mtime.
  if (
    runtime.index &&
    mtimeMs === runtime.mtimeMs &&
    size === runtime.size &&
    ctimeMs === runtime.ctimeMs &&
    ino === runtime.ino
  ) {
    return runtime;
  }
  try {
    const loaded = loadIndex(indexPath);
    // The server is long-lived, so one O(entries) lookup build is amortized over
    // every later read. One-shot CLI commands deliberately skip this warm-up.
    prepareLookup(loaded);
    runtime.index = loaded;
    runtime.mtimeMs = mtimeMs;
    runtime.size = size;
    runtime.ctimeMs = ctimeMs;
    runtime.ino = ino;
    process.stderr.write(
      `code-map MCP: loaded index (${loaded.meta.entryCount} symbols) from ${indexPath}\n`,
    );
  } catch {
    // half-written index — keep the prior good copy, retry on the next call
  }
  return runtime;
}

export const TOOLS = [
  {
    name: 'read',
    description:
      'Read the exact current source slice for one known symbol or a batch; resolves names and re-anchors edited files.',
    annotations: {
      title: 'Read symbol source',
      // The source operation is read-only, but automatic indexing may atomically
      // refresh the derived .map-index.json cache.
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Symbol id, name, or path#name.',
        },
        refs: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          description: 'Up to 64 independent known refs; use instead of ref.',
        },
        changedOnly: {
          type: 'boolean',
          description:
            'With refs, return changes since this session last read them.',
        },
        snippet: {
          type: 'string',
          description: 'Exact text inside one ref used to narrow its slice.',
        },
        root: {
          type: 'string',
          description:
            'Absolute repository path; Windows, /mnt/c, and WSL UNC work.',
        },
        diagnostics: {
          type: 'boolean',
          description: 'Include process identity and restart status.',
        },
        responseFormat: {
          type: 'string',
          enum: ['json', 'compact'],
          default: 'json',
          description: 'compact for models; json for machine consumers.',
        },
      },
    },
  },
];

interface CallContext {
  indexPath: string;
  root: string;
}

function callContext(
  args: Record<string, unknown>,
): CallContext | { error: string } {
  if (args.root !== undefined) {
    if (typeof args.root !== 'string' || !args.root.trim()) {
      return { error: '`root` must be a non-empty absolute repository path.' };
    }
    const input = args.root.trim();
    if (
      process.platform === 'win32' &&
      input.startsWith('/') &&
      !input.startsWith('//') &&
      !/^\/mnt\/[a-zA-Z]\//.test(input)
    ) {
      return {
        error:
          'A Windows-hosted code-map cannot open a native WSL path such as `/home/...` directly. Pass the repository as a `\\\\wsl.localhost\\<distro>\\...` UNC `root`, and keep `ref` repository-relative.',
      };
    }
    const root = toHostPath(input);
    if (!isAbsolute(root)) {
      return {
        error:
          '`root` must be absolute so a global MCP server does not resolve it against its own working directory.',
      };
    }
    const resolvedRoot = resolve(root);
    return {
      root: resolvedRoot,
      indexPath: join(resolvedRoot, '.map-index.json'),
    };
  }
  const indexPath = resolveIndexPath(process.cwd());
  return { indexPath, root: dirname(indexPath) };
}

export interface McpDiagnostics {
  version: string;
  indexVersion: number;
  instanceId: string;
  pid: number;
  startedAt: string;
  platform: NodeJS.Platform;
  cwd: string;
  execPath: string;
  entrypoint: string | null;
  serverFile: string;
  configuredIndexPath: string | null;
  autoIndex: 'large' | 'off';
  autoIndexPollMs: number;
  maxInflightRequests: number;
  activeMcpRequests: number;
  maxObservedMcpRequests: number;
  queuedMcpRequests: number;
  maxObservedQueuedMcpRequests: number;
  indexAdmission: AdmissionStats;
  sourceAtStart: FileIdentity | null;
  sourceNow: FileIdentity | null;
  sourceFileCount: number;
  changedSourceFiles?: string[];
  restartRequired: boolean;
  warning?: string;
}

export function mcpDiagnostics(forceSourceCheck = true): McpDiagnostics {
  if (
    forceSourceCheck ||
    Date.now() - serverSourceCheckedAt >= SOURCE_IDENTITY_POLL_MS
  ) {
    serverSourceNow = fileIdentity(SERVER_FILE);
    serverChangedSourceFiles = changedSourceFiles(
      SERVER_SOURCE_IDENTITIES_AT_START,
    );
    serverSourceCheckedAt = Date.now();
    serverRestartRequired = serverChangedSourceFiles.length > 0;
  }
  return {
    version: VERSION,
    indexVersion: INDEX_VERSION,
    instanceId: `${process.pid}:${INSTANCE_STARTED_AT}`,
    pid: process.pid,
    startedAt: INSTANCE_STARTED_AT,
    platform: process.platform,
    cwd: process.cwd(),
    execPath: process.execPath,
    entrypoint: process.argv[1] ?? null,
    serverFile: SERVER_FILE,
    configuredIndexPath: configuredIndexPath ?? null,
    autoIndex: AUTO_INDEX_ENABLED ? 'large' : 'off',
    autoIndexPollMs: AUTO_INDEX_POLL_MS,
    maxInflightRequests: MAX_INFLIGHT_REQUESTS,
    activeMcpRequests,
    maxObservedMcpRequests,
    queuedMcpRequests,
    maxObservedQueuedMcpRequests,
    indexAdmission: indexAdmission.stats(),
    sourceAtStart: SERVER_SOURCE_AT_START,
    sourceNow: serverSourceNow,
    sourceFileCount: MCP_SOURCE_FILES.length,
    ...(serverChangedSourceFiles.length > 0
      ? {
          changedSourceFiles: serverChangedSourceFiles.map(
            (file) => relative(dirname(SERVER_FILE), file) || '.',
          ),
        }
      : {}),
    restartRequired: serverRestartRequired,
    ...(serverRestartRequired
      ? {
          warning:
            'MCP runtime source changed after startup. Restart before treating results as evidence.',
        }
      : {}),
  };
}

type AutoIndexReason =
  | 'current'
  | 'missing-index'
  | 'incompatible-index'
  | 'large-change'
  | 'requested-symbol-missing';

function selectAutoIndexReason(
  requestedSymbolMissing: boolean,
  indexMissing: boolean,
  fallback: AutoIndexReason,
): AutoIndexReason {
  if (requestedSymbolMissing) return 'requested-symbol-missing';
  if (indexMissing) return 'missing-index';
  return fallback;
}

interface AutoIndexScanStats {
  threshold: number;
  changed: number;
  added: number;
  modified: number;
  removed: number;
}

type FailedAutoIndexOutcome = {
  status: 'failed';
  reason: AutoIndexReason;
  error: string;
} & (
  | AutoIndexScanStats
  | {
      threshold?: never;
      changed?: never;
      added?: never;
      modified?: never;
      removed?: never;
    }
);

export type AutoIndexOutcome =
  | ({ status: 'current'; reason: 'current' } & AutoIndexScanStats)
  | ({
      status: 'rebuilt';
      reason: Exclude<AutoIndexReason, 'current'>;
      reused: number;
    } & AutoIndexScanStats)
  | FailedAutoIndexOutcome
  | { status: 'disabled'; reason: 'requested-symbol-missing' };

interface AutoIndexFlight {
  controller: AbortController;
  promise: Promise<AutoIndexOutcome>;
  token: symbol;
}

const autoIndexFlights = new Map<string, AutoIndexFlight>();

async function runAutoIndex(
  runtime: IndexRuntime,
  indexPath: string,
  root: string,
  requestedSymbolMissing: boolean,
  controller: AbortController,
): Promise<AutoIndexOutcome> {
  const checkedGeneration = runtime.changeGeneration;
  const indexMissing = !existsSync(indexPath) || !runtime.index;
  let scan: IndexDriftScan | null = null;
  try {
    scan = await scanIndexDrift(root, runtime.index, false, controller.signal);
    const decision = autoIndexDecision(scan);
    const rebuild =
      indexMissing ||
      decision.rebuild ||
      (requestedSymbolMissing && scan.totalChanged > 0);
    const reason = selectAutoIndexReason(
      requestedSymbolMissing && scan.totalChanged > 0,
      indexMissing,
      decision.reason,
    );
    runtime.lastCheckAt = Date.now();
    runtime.checkedGeneration = checkedGeneration;
    if (!rebuild) {
      return {
        status: 'current',
        reason: 'current',
        threshold: decision.threshold,
        changed: scan.totalChanged,
        added: scan.added,
        modified: scan.modified,
        removed: scan.removed,
      };
    }
    if (reason === 'current') {
      throw new Error('An auto-index rebuild requires a non-current reason.');
    }

    const { buildIndex } = await import('../core/build-index.ts');
    const report = await buildIndex({
      root,
      previous: scan.previous,
      scan,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (indexMissing || !report.unchanged) saveIndex(report.index, indexPath);
    const fresh = ensureFresh(indexPath);
    if (!fresh.index) {
      throw new Error(`The rebuilt index at ${indexPath} could not be loaded.`);
    }
    process.stderr.write(
      `code-map MCP: auto-indexed ${root} (${scan.totalChanged} changed, reason: ${reason})\n`,
    );
    return {
      status: 'rebuilt',
      reason,
      threshold: decision.threshold,
      changed: scan.totalChanged,
      added: scan.added,
      modified: scan.modified,
      removed: scan.removed,
      reused: report.reused,
    };
  } catch (error) {
    runtime.lastCheckAt = Date.now();
    runtime.checkedGeneration = checkedGeneration;
    const failureReason = selectAutoIndexReason(
      requestedSymbolMissing,
      indexMissing,
      scan?.compatible === false ? 'incompatible-index' : 'large-change',
    );
    const message = error instanceof Error ? error.message : String(error);
    if (!scan) {
      return { status: 'failed', reason: failureReason, error: message };
    }
    return {
      status: 'failed',
      reason: failureReason,
      threshold: autoIndexDecision(scan).threshold,
      changed: scan.totalChanged,
      added: scan.added,
      modified: scan.modified,
      removed: scan.removed,
      error: message,
    };
  }
}

async function maybeAutoIndex(
  runtime: IndexRuntime,
  indexPath: string,
  root: string,
  requestedSymbolMissing = false,
): Promise<AutoIndexOutcome | null> {
  if (!AUTO_INDEX_ENABLED) {
    return requestedSymbolMissing
      ? { status: 'disabled', reason: 'requested-symbol-missing' }
      : null;
  }
  ensureRootWatch(runtime, root);
  const due =
    requestedSymbolMissing ||
    runtime.changeGeneration !== runtime.checkedGeneration ||
    (runtime.watcherUnavailable &&
      Date.now() - runtime.lastCheckAt >= AUTO_INDEX_POLL_MS);
  if (!due) return null;

  const existing = autoIndexFlights.get(indexPath);
  if (existing) {
    const joined = await existing.promise;
    if (
      requestedSymbolMissing &&
      joined.status === 'current' &&
      joined.changed > 0
    ) {
      return maybeAutoIndex(runtime, indexPath, root, true);
    }
    return joined;
  }

  const controller = new AbortController();
  const token = Symbol('auto-index-flight');
  const promise = indexAdmission
    .run(
      () =>
        runAutoIndex(
          runtime,
          indexPath,
          root,
          requestedSymbolMissing,
          controller,
        ),
      controller.signal,
    )
    .catch(
      (error: unknown): AutoIndexOutcome => ({
        status: 'failed',
        reason: selectAutoIndexReason(
          requestedSymbolMissing,
          !runtime.index,
          'large-change',
        ),
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    .finally(() => {
      if (autoIndexFlights.get(indexPath)?.token === token) {
        autoIndexFlights.delete(indexPath);
      }
    });
  const flight: AutoIndexFlight = { controller, promise, token };
  autoIndexFlights.set(indexPath, flight);
  return flight.promise;
}

function responseItemNeedsIndexRetry(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const record = item;
  if (
    record.status === 'not-found' ||
    record.status === 'anchor-lost' ||
    record.status === 'ambiguous'
  ) {
    return true;
  }
  return ['results', 'changed'].some((key) => {
    const nested = record[key];
    return Array.isArray(nested) && nested.some(responseItemNeedsIndexRetry);
  });
}

function responseNeedsIndexRetry(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return /(?:^|\n)\[(?:not-found|anchor-lost|ambiguous)\s/u.test(text);
  }
  return responseItemNeedsIndexRetry(value);
}

function withResponseMeta(
  text: string,
  outcome: AutoIndexOutcome | null,
  forceDiagnostics: boolean,
  context?: CallContext,
  runtime?: IndexRuntime,
): string {
  const diagnostics = mcpDiagnostics(forceDiagnostics);
  const includeOutcome =
    !!outcome &&
    (outcome.status === 'rebuilt' ||
      outcome.status === 'failed' ||
      outcome.status === 'disabled' ||
      forceDiagnostics);
  if (!includeOutcome && !forceDiagnostics && !diagnostics.restartRequired) {
    return text;
  }
  const meta = {
    ...(includeOutcome ? { autoIndex: outcome } : {}),
    ...(forceDiagnostics || diagnostics.restartRequired
      ? { mcp: diagnostics }
      : {}),
    ...(context && runtime && (forceDiagnostics || diagnostics.restartRequired)
      ? {
          index: {
            root: context.root,
            indexPath: context.indexPath,
            loaded: !!runtime.index,
            generated: runtime.index?.meta.generated ?? null,
            invalidFiles: {
              count: runtime.index?.meta.invalidFiles?.length ?? 0,
              sample:
                runtime.index?.meta.invalidFiles?.slice(
                  0,
                  MAX_INVALID_FILE_DIAGNOSTICS,
                ) ?? [],
            },
            watchMode: runtime.watcher ? 'active' : 'on-call-fallback',
            dirty: runtime.changeGeneration !== runtime.checkedGeneration,
            lastCheckedAt: runtime.lastCheckAt
              ? new Date(runtime.lastCheckAt).toISOString()
              : null,
          },
        }
      : {}),
  };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return text;
    parsed._meta = {
      ...(isRecord(parsed._meta) ? parsed._meta : {}),
      ...meta,
    };
    return JSON.stringify(parsed, null, 2);
  } catch {
    return `${text}\n\n[meta] ${JSON.stringify(meta)}`;
  }
}

export function callTool(name: string, args: Record<string, unknown>): string {
  if (name === 'read') {
    const validated = validateReadArguments(args);
    if (!validated.ok) {
      return JSON.stringify({ error: validated.error }, null, 2);
    }
  }
  const context = callContext(args);
  if ('error' in context) return JSON.stringify(context, null, 2);
  const runtime = ensureFresh(context.indexPath);
  if (!runtime.index) {
    return JSON.stringify(
      {
        error: `No code-map index found at ${context.indexPath}. Run \`map index --root <repo>\`, then pass \`root\` as that repository's absolute path.`,
      },
      null,
      2,
    );
  }
  return dispatch(runtime.index, name, args, runtime.observations);
}

export async function callToolAsync(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === 'read') {
    const validated = validateReadArguments(args);
    if (!validated.ok) {
      return JSON.stringify({ error: validated.error }, null, 2);
    }
  }
  const context = callContext(args);
  if ('error' in context) {
    return withResponseMeta(
      JSON.stringify(context, null, 2),
      null,
      args.diagnostics === true,
    );
  }
  let runtime = ensureFresh(context.indexPath);
  const root =
    args.root === undefined && runtime.index?.meta.root
      ? resolve(runtime.index.meta.root)
      : context.root;
  let outcome = await maybeAutoIndex(runtime, context.indexPath, root);
  runtime = ensureFresh(context.indexPath);
  if (!runtime.index) {
    const error =
      outcome?.status === 'failed'
        ? `Automatic code-map indexing failed for ${root}: ${outcome.error}`
        : `No code-map index found at ${context.indexPath}. Automatic indexing is ${AUTO_INDEX_ENABLED ? 'enabled but did not produce an index' : 'disabled by CODE_MAP_AUTO_INDEX=off'}.`;
    return withResponseMeta(
      JSON.stringify({ error }, null, 2),
      outcome,
      args.diagnostics === true,
      { ...context, root },
      runtime,
    );
  }

  const before = runtime.observations;
  const trial = new Map(before);
  let text = dispatch(runtime.index, name, args, trial);
  if (responseNeedsIndexRetry(text)) {
    const retryOutcome = await maybeAutoIndex(
      runtime,
      context.indexPath,
      root,
      true,
    );
    if (retryOutcome && (retryOutcome.status !== 'current' || !outcome)) {
      outcome = retryOutcome;
    }
    runtime = ensureFresh(context.indexPath);
    if (retryOutcome?.status === 'rebuilt' && runtime.index) {
      text = dispatch(runtime.index, name, args, before);
      runtime.observations = before;
    } else {
      runtime.observations = trial;
    }
  } else {
    runtime.observations = trial;
  }
  return withResponseMeta(
    text,
    outcome,
    args.diagnostics === true,
    { ...context, root },
    runtime,
  );
}

export function disposeMcpState(): void {
  for (const runtime of indexRuntimes.values()) disposeRuntime(runtime);
  indexRuntimes.clear();
  for (const flight of autoIndexFlights.values()) flight.controller.abort();
  autoIndexFlights.clear();
  indexAdmission.cancelQueued(new Error('code-map MCP is shutting down.'));
}

function uniqueRefs(
  values: readonly string[],
  max = 64,
): { refs: string[]; total: number } {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    if (refs.length < max) refs.push(value);
  }
  return { refs, total: seen.size };
}

type ReadResponseFormat = 'json' | 'compact';

type ValidatedReadArguments =
  | { ok: false; error: string }
  | {
      ok: true;
      kind: 'single';
      ref: string;
      snippet?: string;
      responseFormat: ReadResponseFormat;
    }
  | {
      ok: true;
      kind: 'batch';
      refs: string[];
      changedOnly: boolean;
      responseFormat: ReadResponseFormat;
    };

function validateReadArguments(
  args: Record<string, unknown>,
): ValidatedReadArguments {
  if (args.diagnostics !== undefined && typeof args.diagnostics !== 'boolean') {
    return { ok: false, error: '`diagnostics` must be a boolean.' };
  }
  if (args.changedOnly !== undefined && typeof args.changedOnly !== 'boolean') {
    return { ok: false, error: '`changedOnly` must be a boolean.' };
  }
  if (
    args.responseFormat !== undefined &&
    args.responseFormat !== 'json' &&
    args.responseFormat !== 'compact'
  ) {
    return {
      ok: false,
      error: '`responseFormat` must be `json` or `compact`.',
    };
  }
  const responseFormat = args.responseFormat === 'compact' ? 'compact' : 'json';

  const hasRefs = args.refs !== undefined;
  const hasRef = args.ref !== undefined;
  if (hasRefs && hasRef) {
    return {
      ok: false,
      error: 'Pass `ref` (single) OR `refs` (batch), not both.',
    };
  }
  if (hasRefs) {
    if (!Array.isArray(args.refs) || args.refs.length === 0) {
      return {
        ok: false,
        error: '`refs` must be a non-empty array of symbol ids or names.',
      };
    }
    const refs: string[] = [];
    for (const value of args.refs) {
      if (typeof value !== 'string' || !value.trim()) {
        return {
          ok: false,
          error: 'Every `refs` element must be a non-empty string.',
        };
      }
      refs.push(value);
    }
    if (args.snippet !== undefined) {
      return {
        ok: false,
        error: '`snippet` is only valid with a single `ref`.',
      };
    }
    return {
      ok: true,
      kind: 'batch',
      refs,
      changedOnly: args.changedOnly === true,
      responseFormat,
    };
  }
  if (!hasRef) {
    return {
      ok: false,
      error: 'Pass `ref` (a symbol id or name) or `refs` (an array).',
    };
  }
  if (typeof args.ref !== 'string' || !args.ref.trim()) {
    return { ok: false, error: '`ref` must be a non-empty string.' };
  }
  if (args.snippet !== undefined && typeof args.snippet !== 'string') {
    return {
      ok: false,
      error: '`snippet` must be a string when provided.',
    };
  }
  return {
    ok: true,
    kind: 'single',
    ref: args.ref,
    ...(args.snippet === undefined ? {} : { snippet: args.snippet }),
    responseFormat,
  };
}

function observationFingerprint(result: ReadResult): string {
  const hash = createHash('sha256').update(
    JSON.stringify([
      result.status,
      result.id,
      result.file,
      result.line,
      result.endLine ?? null,
      result.candidates ?? null,
    ]),
  );
  hash.update(result.raw == null ? '\x00' : '\x01');
  if (result.raw != null) hash.update(result.raw);
  return hash.digest('base64url');
}

function rememberObservation(
  observations: Map<string, string>,
  key: string,
  fingerprint: string,
): void {
  observations.delete(key);
  observations.set(key, fingerprint);
  while (observations.size > MAX_OBSERVATIONS) {
    const oldestEntry = observations.keys().next();
    if (oldestEntry.done) break;
    const oldest = oldestEntry.value;
    observations.delete(oldest);
  }
}

function rememberResult(
  observations: Map<string, string>,
  ref: string,
  result: ReadResult,
): void {
  const fingerprint = observationFingerprint(result);
  rememberObservation(observations, ref, fingerprint);
  if (result.id !== ref) {
    rememberObservation(observations, result.id, fingerprint);
  }
}

function observedDelta(
  index: MapIndex,
  refs: string[],
  observations: Map<string, string>,
): {
  unchanged: string[];
  changed: ReadResult[];
  filesChecked: number;
  filesChanged: number;
} {
  const results = readMany(index, refs);
  const unchanged: string[] = [];
  const changedOut: ReadResult[] = [];
  const filesChecked = new Set<string>();
  const filesChanged = new Set<string>();
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const result = results[i];
    if (result.file) filesChecked.add(result.file);
    const fingerprint = observationFingerprint(result);
    const previous = observations.get(ref) ?? observations.get(result.id);
    const stable = result.status === 'exact' || result.status === 'relocated';
    if (stable && previous === fingerprint) {
      unchanged.push(result.id);
    } else {
      changedOut.push(result);
      if (result.file) filesChanged.add(result.file);
    }
    rememberResult(observations, ref, result);
  }
  return {
    unchanged,
    changed: changedOut,
    filesChecked: filesChecked.size,
    filesChanged: filesChanged.size,
  };
}

type ReadDelta = ReturnType<typeof changed>;

function compactReadResult(result: ReadResult, requestedRef?: string): string {
  const endLine = 'endLine' in result ? result.endLine : undefined;
  const range =
    typeof endLine === 'number'
      ? `${result.line}-${endLine}`
      : String(result.line);
  const label =
    requestedRef === result.id
      ? result.id.slice(result.id.lastIndexOf('#') + 1) || result.id
      : result.id;
  const lines = [`[${result.status} ${label} @${range}]`];
  if (result.raw !== null) lines.push(result.raw);
  if (result.note) lines.push(`note: ${result.note}`);
  if (result.aim) lines.push(`aim: ${JSON.stringify(result.aim)}`);
  if (result.candidates?.length) {
    lines.push(
      'candidates:',
      ...result.candidates.map(
        (candidate) =>
          `- ${candidate.line}: ${JSON.stringify(candidate.preview)}`,
      ),
    );
  }
  return lines.join('\n');
}

function compactReadResults(
  results: ReadResult[],
  refs: string[],
  note?: string,
): string {
  const sections = results.map((result, index) =>
    compactReadResult(result, refs[index]),
  );
  if (note) sections.push(`[note] ${note}`);
  return sections.join('\n\n');
}

function compactReadDelta(delta: ReadDelta): string {
  const sections = [
    `[delta files=${delta.filesChanged}/${delta.filesChecked}]`,
    `unchanged: ${delta.unchanged.length ? delta.unchanged.join(', ') : 'none'}`,
  ];
  sections.push(
    delta.changed.length
      ? `changed:\n${delta.changed.map((result) => compactReadResult(result)).join('\n\n')}`
      : 'changed: none',
  );
  return sections.join('\n');
}

/** Pure tool dispatch over a given index — exported so the protocol layer can be
 * exercised in tests without a live stdio process. */
export function dispatch(
  index: MapIndex,
  name: string,
  args: Record<string, unknown>,
  observations?: Map<string, string>,
): string {
  switch (name) {
    case 'read': {
      const validated = validateReadArguments(args);
      if (!validated.ok) {
        return JSON.stringify({ error: validated.error }, null, 2);
      }
      if (validated.kind === 'batch') {
        // Long-lived MCP calls compare with what this session actually returned before.
        // Pure/one-shot dispatch has no session baseline, so it keeps the index-relative fallback.
        if (validated.changedOnly) {
          const { refs } = uniqueRefs(validated.refs);
          const delta = observations
            ? observedDelta(index, refs, observations)
            : changed(index, refs);
          return validated.responseFormat === 'compact'
            ? compactReadDelta(delta)
            : JSON.stringify(delta);
        }
        // Batch: one round-trip for many symbols — same slices, fewer turns. Dedupe (keep
        // first occurrence) and cap so a stray huge array can't blow up the context window.
        const MAX = 64;
        const { refs, total } = uniqueRefs(validated.refs, MAX);
        const results = readMany(index, refs);
        if (observations) {
          for (let i = 0; i < refs.length; i++) {
            rememberResult(observations, refs[i], results[i]);
          }
        }
        const note =
          total > MAX
            ? `Read first ${MAX} of ${total} refs; split the rest into another call.`
            : undefined;
        if (validated.responseFormat === 'compact') {
          return compactReadResults(results, refs, note);
        }
        const out: Record<string, unknown> = { results };
        if (note) out.note = note;
        // Compact (no pretty-print indentation) — leaner in context than N single pretty reads.
        return JSON.stringify(out);
      }
      const { ref, snippet } = validated;
      const result = read(index, ref, { snippet });
      if (observations) rememberResult(observations, ref, result);
      return validated.responseFormat === 'compact'
        ? compactReadResult(result, ref)
        : JSON.stringify(result, null, 2);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

let sendTail = Promise.resolve();
let stopping = false;

function send(msg: unknown): Promise<void> {
  const queued = sendTail.then(async () => {
    if (stopping || process.stdout.destroyed) return;
    const line = `${JSON.stringify(msg)}\n`;
    if (process.stdout.write(line)) return;
    const resumeInput = !process.stdin.isPaused();
    process.stdin.pause();
    try {
      await once(process.stdout, 'drain');
    } finally {
      if (resumeInput && !stopping) process.stdin.resume();
    }
  });
  sendTail = queued.catch(() => undefined);
  return queued;
}

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: unknown;
    arguments?: Record<string, unknown>;
    [k: string]: unknown;
  };
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value)) return false;
  if (
    value.id !== undefined &&
    value.id !== null &&
    typeof value.id !== 'string' &&
    typeof value.id !== 'number'
  ) {
    return false;
  }
  if (value.method !== undefined && typeof value.method !== 'string') {
    return false;
  }
  if (value.params !== undefined && !isRecord(value.params)) return false;
  return !(
    isRecord(value.params) &&
    value.params.arguments !== undefined &&
    !isRecord(value.params.arguments)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handle(req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': {
        await send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'code-map', version: VERSION },
            runtime: mcpDiagnostics(),
            instructions: SERVER_INSTRUCTIONS,
          },
        });
        return;
      }
      case 'tools/list':
        await send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        let invalidParams: string | null = null;
        if (typeof toolName !== 'string' || !toolName.trim()) {
          invalidParams = '`name` must identify a tool.';
        } else if (toolName !== 'read') {
          invalidParams = `unknown tool: ${toolName}`;
        } else {
          const validated = validateReadArguments(toolArgs);
          if (!validated.ok) {
            invalidParams = validated.error;
          } else {
            const context = callContext(toolArgs);
            if ('error' in context) invalidParams = context.error;
          }
        }
        if (invalidParams) {
          await send({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: 'invalid params',
              data: { detail: invalidParams },
            },
          });
          return;
        }
        if (typeof toolName !== 'string') {
          throw new Error('Validated tool name was not a string.');
        }
        const text = await callToolAsync(toolName, toolArgs);
        await send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }] },
        });
        return;
      }
      case 'ping':
        await send({
          jsonrpc: '2.0',
          id,
          result: { runtime: mcpDiagnostics() },
        });
        return;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // notifications: no reply
      case undefined:
        if (isRequest) {
          await send({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32600,
              message: 'invalid request: method is required',
            },
          });
        }
        return;
      default:
        if (isRequest) {
          await send({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `method not found: ${method}` },
          });
        }
        return;
    }
  } catch (e) {
    if (isRequest) {
      await send({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: errorMessage(e) },
      });
    }
  }
}

/** Start the stdio JSON-RPC loop — only when run as the entry point, so importing
 * this module (e.g. from tests) never consumes stdin or eagerly loads an index. */
function main(): void {
  const indexPath = resolveIndexPath(process.cwd());
  // Handshaking must never parse or prepare a repository index. A large index
  // belongs to the first read, after the MCP client has initialized successfully.
  if (!existsSync(indexPath)) {
    process.stderr.write(
      `code-map MCP: no index at ${indexPath} yet — pass the absolute repository \`root\`; the first read will ${AUTO_INDEX_ENABLED ? 'build it lazily' : 'report it missing because CODE_MAP_AUTO_INDEX=off'}.\n`,
    );
  }
  const decoder = new NdjsonDecoder(MAX_NDJSON_LINE_BYTES);
  const input = process.stdin;
  const pendingRequests = new Map<number, JsonRpcRequest>();
  let nextQueuedRequestId = 1;
  const updateQueuedMetrics = (): void => {
    queuedMcpRequests = pendingRequests.size;
    maxObservedQueuedMcpRequests = Math.max(
      maxObservedQueuedMcpRequests,
      queuedMcpRequests,
    );
  };
  function settleRequest(): void {
    activeMcpRequests--;
    drainRequests();
  }
  function drainRequests(): void {
    if (stopping) return;
    while (
      !stopping &&
      activeMcpRequests < MAX_INFLIGHT_REQUESTS &&
      pendingRequests.size > 0
    ) {
      const next = pendingRequests.entries().next();
      if (next.done) break;
      const [queuedId, request] = next.value;
      pendingRequests.delete(queuedId);
      updateQueuedMetrics();
      activeMcpRequests++;
      maxObservedMcpRequests = Math.max(
        maxObservedMcpRequests,
        activeMcpRequests,
      );
      void handle(request).finally(settleRequest);
    }
    if (
      !stopping &&
      activeMcpRequests < MAX_INFLIGHT_REQUESTS &&
      pendingRequests.size === 0
    ) {
      input.resume();
    } else {
      input.pause();
    }
  }
  const sendProtocolError = (code: number, message: string): void => {
    void send({ jsonrpc: '2.0', id: null, error: { code, message } });
  };
  const acceptEvent = (event: NdjsonEvent): void => {
    if (stopping) return;
    if (event.kind === 'oversized') {
      sendProtocolError(
        JSON_RPC_INVALID_REQUEST,
        `request line exceeds ${MAX_NDJSON_LINE_BYTES} bytes`,
      );
      return;
    }
    const trimmed = event.text.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      sendProtocolError(JSON_RPC_PARSE_ERROR, 'parse error');
      return;
    }
    if (!isJsonRpcRequest(parsed)) {
      sendProtocolError(JSON_RPC_INVALID_REQUEST, 'invalid request');
      return;
    }
    pendingRequests.set(nextQueuedRequestId++, parsed);
    updateQueuedMetrics();
    drainRequests();
  };
  input.on('data', (chunk: Buffer) => {
    for (const event of decoder.push(chunk)) acceptEvent(event);
  });
  const close = (): void => {
    if (stopping) return;
    stopping = true;
    pendingRequests.clear();
    updateQueuedMetrics();
    disposeMcpState();
  };
  input.once('end', () => {
    for (const event of decoder.finish()) acceptEvent(event);
    close();
  });
  input.once('close', close);
  input.once('error', close);
  process.stdout.once('error', () => {
    close();
    process.exit(0);
  });
  process.once('exit', disposeMcpState);
  const shutdown = (): void => {
    close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

let isEntry = false;
try {
  isEntry =
    !!process.argv[1] &&
    realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  /* not resolvable (e.g. imported) — stay dormant */
}
if (isEntry) main();

function argIndex(): string | undefined {
  const i = process.argv.indexOf('--index');
  return i !== -1 ? process.argv[i + 1] : undefined;
}
