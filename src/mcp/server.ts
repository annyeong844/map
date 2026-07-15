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
import { existsSync, realpathSync, statSync, watch as watchFs, type FSWatcher } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { autoIndexDecision, scanIndexDrift, type IndexDriftScan } from '../core/index-drift.ts';
import { changed, read, readMany } from '../core/read.ts';
import { loadIndex, prepareLookup, saveIndex } from '../core/store.ts';
import { INDEX_VERSION, type MapIndex, type ReadResult } from '../core/types.ts';
import { VERSION } from '../version.ts';

const PROTOCOL = '2025-06-18';
const SERVER_INSTRUCTIONS = [
  'ROUTING RULES: for indexed repos, do not read known symbol bodies with shell commands. If a file:line, symbol id, or path#name is known, call code-map read for source.',
  'Pass root as the absolute current repository directory on every read so a global server can select the right index. Windows C:\\... and WSL /mnt/c/... spellings are interchangeable; for a Windows-hosted server reading native WSL ext4, pass the \\\\wsl.localhost\\... UNC repository path as root and keep ref repository-relative.',
  'code-map read resolves a bare name or path#name directly — for any symbol you can already name, call read; do NOT grep first to locate a name read can resolve (grepping to find a known symbol is a redundant double-call). Use shell search only to discover a name you do not know yet, then read the body — never grep/cat it.',
  'For two or more independent known refs, make one read call with refs: [...] before answering. Split only when a later ref depends on earlier output or the batch exceeds 64 refs.',
  'Missing/incompatible indexes and large source drift are rebuilt lazily on read; a requested symbol miss also checks small drift and retries once. Pass diagnostics:true when a long-lived MCP process may be stale.',
  'Never answer from index metadata alone; answer from raw code returned by read.',
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
const MAX_OBSERVATIONS = 8192;
const AUTO_INDEX_ENABLED = !/^(?:0|false|off)$/i.test(process.env.CODE_MAP_AUTO_INDEX?.trim() ?? 'large');
const AUTO_INDEX_POLL_MS = positiveInteger(process.env.CODE_MAP_AUTO_INDEX_POLL_MS, 2_000);
const SOURCE_IDENTITY_POLL_MS = 2_000;
const INSTANCE_STARTED_AT = new Date().toISOString();
const SERVER_FILE = fileURLToPath(import.meta.url);

export interface FileIdentity {
  mtimeMs: number;
  size: number;
  ctimeMs: number;
  ino: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function fileIdentity(path: string): FileIdentity | null {
  try {
    const value = statSync(path);
    return { mtimeMs: value.mtimeMs, size: value.size, ctimeMs: value.ctimeMs, ino: value.ino };
  } catch {
    return null;
  }
}

const SERVER_SOURCE_AT_START = fileIdentity(SERVER_FILE);
let serverSourceNow = SERVER_SOURCE_AT_START;
let serverSourceCheckedAt = Date.now();
let serverRestartRequired = false;

export function sourceIdentityChanged(start: FileIdentity | null, current: FileIdentity | null): boolean {
  if (!start || !current) return start !== current;
  return start.mtimeMs !== current.mtimeMs || start.size !== current.size || start.ctimeMs !== current.ctimeMs || start.ino !== current.ino;
}

/** Resolve an explicit index, or discover the nearest one from `start`. Kept as
 * a function because an index may be created after the long-lived server starts. */
export function resolveIndexPath(start: string, explicit = configuredIndexPath): string {
  const hostStart = toHostPath(start);
  const hostExplicit = explicit ? toHostPath(explicit) : explicit;
  return hostExplicit ? resolve(hostStart, hostExplicit) : findUp('.map-index.json', hostStart) ?? resolve(hostStart, '.map-index.json');
}

/** Accept either side's spelling when a Windows-hosted server serves WSL (or a
 * WSL-hosted server receives a Windows path). Native Linux paths pass through. */
export function toHostPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const wsl = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(path);
    return wsl ? `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}` : path;
  }
  if (platform === 'linux') {
    const windows = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
    return windows ? `/mnt/${windows[1].toLowerCase()}/${windows[2].replace(/\\/g, '/')}` : path;
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
    const oldest = indexRuntimes.keys().next().value as string | undefined;
    if (oldest !== undefined) {
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
  const root = resolve(rootInput);
  if (runtime.root === root && (runtime.watcher || runtime.watcherUnavailable)) return;
  disposeRuntime(runtime);
  runtime.root = root;
  runtime.watcherUnavailable = false;
  runtime.changeGeneration++;
  try {
    const watcher = watchFs(root, { recursive: true }, (_event, filename) => {
      const changedPath = filename ? String(filename).replaceAll('\\', '/') : '';
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
  if (runtime.index && mtimeMs === runtime.mtimeMs && size === runtime.size && ctimeMs === runtime.ctimeMs && ino === runtime.ino) return runtime;
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
    process.stderr.write(`code-map MCP: loaded index (${loaded.meta.entryCount} symbols) from ${indexPath}\n`);
  } catch {
    // half-written index — keep the prior good copy, retry on the next call
  }
  return runtime;
}

export const TOOLS = [
  {
    name: 'read',
    description:
      'Return the RAW source slice of a symbol — its own bytes (a function/method/class body), NOT the whole file, so it is token-efficient. Pass `root` as the indexed repository\'s absolute directory so one global MCP can serve multiple workspaces; Windows and /mnt/c spellings are interchangeable. For native WSL ext4 from a Windows-hosted MCP, pass a \\\\wsl.localhost\\... UNC root and keep `ref` repository-relative. Pass a symbol id or a bare name / path-scoped name ("alias-map#buildAliasMap"); it resolves the name internally. Missing/incompatible indexes and large drift rebuild lazily; a missing requested symbol checks small drift and retries once. **Batch: pass `refs` (an array) to read several symbols in ONE call.** Pass `ref` OR `refs`, not both. Drift-resistant reads re-anchor changed files. Use `diagnostics:true` to report the live MCP instance and whether its server file changed after startup.',
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
        ref: { type: 'string', description: 'A symbol id, or a bare name / "path#name".' },
        refs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64, uniqueItems: true, description: 'Read several INDEPENDENT, already-known symbols in one call (ids or names). One result per ref. Use sequential single reads when later reads depend on earlier ones.' },
        changedOnly: { type: 'boolean', description: 'With `refs`: a working-set DELTA against this MCP session\'s prior reads — return only changed current slices plus an `unchanged` id list. Index rebuilds do not erase the read baseline; refs without one are returned conservatively.' },
        snippet: { type: 'string', description: 'Optional: verbatim text from inside the symbol — resolved to exact char range(s). Applies when reading a single `ref`.' },
        root: { type: 'string', description: 'Absolute repository path. Pass it on every global-server call. On a Windows-hosted server, use C:\\..., /mnt/c/..., or a \\\\wsl.localhost\\... UNC root for native WSL ext4; keep refs repository-relative.' },
        diagnostics: { type: 'boolean', description: 'Include live MCP pid/startup/file diagnostics and restartRequired state.' },
      },
    },
  },
];

interface CallContext {
  indexPath: string;
  root: string;
}

function callContext(args: Record<string, unknown>): CallContext | { error: string } {
  if (args.root !== undefined) {
    if (typeof args.root !== 'string' || !args.root.trim()) {
      return { error: '`root` must be a non-empty absolute repository path.' };
    }
    const input = args.root.trim();
    if (process.platform === 'win32' && input.startsWith('/') && !input.startsWith('//') && !/^\/mnt\/[a-zA-Z]\//.test(input)) {
      return {
        error: 'A Windows-hosted code-map cannot open a native WSL path such as `/home/...` directly. Pass the repository as a `\\\\wsl.localhost\\<distro>\\...` UNC `root`, and keep `ref` repository-relative.',
      };
    }
    const root = toHostPath(input);
    if (!isAbsolute(root)) {
      return { error: '`root` must be absolute so a global MCP server does not resolve it against its own working directory.' };
    }
    const resolvedRoot = resolve(root);
    return { root: resolvedRoot, indexPath: join(resolvedRoot, '.map-index.json') };
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
  sourceAtStart: FileIdentity | null;
  sourceNow: FileIdentity | null;
  restartRequired: boolean;
  warning?: string;
}

export function mcpDiagnostics(forceSourceCheck = true): McpDiagnostics {
  if (forceSourceCheck || Date.now() - serverSourceCheckedAt >= SOURCE_IDENTITY_POLL_MS) {
    serverSourceNow = fileIdentity(SERVER_FILE);
    serverSourceCheckedAt = Date.now();
    serverRestartRequired = sourceIdentityChanged(SERVER_SOURCE_AT_START, serverSourceNow);
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
    sourceAtStart: SERVER_SOURCE_AT_START,
    sourceNow: serverSourceNow,
    restartRequired: serverRestartRequired,
    ...(serverRestartRequired
      ? { warning: 'This MCP server file changed after the process started. Start a new MCP session before treating its results as evidence.' }
      : {}),
  };
}

type AutoIndexReason = 'current' | 'missing-index' | 'incompatible-index' | 'large-change' | 'requested-symbol-missing';

export interface AutoIndexOutcome {
  status: 'current' | 'rebuilt' | 'failed' | 'disabled';
  reason: AutoIndexReason;
  threshold?: number;
  changed?: number;
  added?: number;
  modified?: number;
  removed?: number;
  reused?: number;
  error?: string;
}

interface AutoIndexFlight {
  controller: AbortController;
  promise: Promise<AutoIndexOutcome>;
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
    scan = await scanIndexDrift(root, runtime.index);
    const decision = autoIndexDecision(scan);
    const rebuild = indexMissing || decision.rebuild || (requestedSymbolMissing && scan.totalChanged > 0);
    const reason: AutoIndexReason = requestedSymbolMissing && scan.totalChanged > 0
      ? 'requested-symbol-missing'
      : indexMissing
        ? 'missing-index'
        : decision.reason;
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

    const { buildIndex } = await import('../core/build-index.ts');
    const report = await buildIndex({
      root,
      previous: scan.previous,
      scan,
      signal: controller.signal,
    });
    if (indexMissing || !report.unchanged) saveIndex(report.index, indexPath);
    const fresh = ensureFresh(indexPath);
    if (!fresh.index) throw new Error(`The rebuilt index at ${indexPath} could not be loaded.`);
    process.stderr.write(`code-map MCP: auto-indexed ${root} (${scan.totalChanged} changed, reason: ${reason})\n`);
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
    return {
      status: 'failed',
      reason: requestedSymbolMissing ? 'requested-symbol-missing' : indexMissing ? 'missing-index' : scan?.compatible === false ? 'incompatible-index' : 'large-change',
      ...(scan
        ? {
            threshold: autoIndexDecision(scan).threshold,
            changed: scan.totalChanged,
            added: scan.added,
            modified: scan.modified,
            removed: scan.removed,
          }
        : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function maybeAutoIndex(
  runtime: IndexRuntime,
  indexPath: string,
  root: string,
  requestedSymbolMissing = false,
): Promise<AutoIndexOutcome | null> {
  if (!AUTO_INDEX_ENABLED) return requestedSymbolMissing ? { status: 'disabled', reason: 'requested-symbol-missing' } : null;
  ensureRootWatch(runtime, root);
  const due =
    requestedSymbolMissing ||
    runtime.changeGeneration !== runtime.checkedGeneration ||
    (runtime.watcherUnavailable && Date.now() - runtime.lastCheckAt >= AUTO_INDEX_POLL_MS);
  if (!due) return null;

  const existing = autoIndexFlights.get(indexPath);
  if (existing) {
    const joined = await existing.promise;
    if (requestedSymbolMissing && joined.status === 'current' && (joined.changed ?? 0) > 0) {
      return maybeAutoIndex(runtime, indexPath, root, true);
    }
    return joined;
  }

  const controller = new AbortController();
  const flight = {} as AutoIndexFlight;
  flight.controller = controller;
  flight.promise = runAutoIndex(runtime, indexPath, root, requestedSymbolMissing, controller)
    .finally(() => {
      if (autoIndexFlights.get(indexPath) === flight) autoIndexFlights.delete(indexPath);
    });
  autoIndexFlights.set(indexPath, flight);
  return flight.promise;
}

function responseNeedsIndexRetry(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  const visit = (item: unknown): boolean => {
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    if (record.status === 'not-found' || record.status === 'anchor-lost' || record.status === 'ambiguous') return true;
    return ['results', 'changed'].some((key) => Array.isArray(record[key]) && (record[key] as unknown[]).some(visit));
  };
  return visit(value);
}

function withResponseMeta(
  text: string,
  outcome: AutoIndexOutcome | null,
  forceDiagnostics: boolean,
  context?: CallContext,
  runtime?: IndexRuntime,
): string {
  const diagnostics = mcpDiagnostics(forceDiagnostics);
  const includeOutcome = !!outcome && (outcome.status === 'rebuilt' || outcome.status === 'failed' || outcome.status === 'disabled' || forceDiagnostics);
  if (!includeOutcome && !forceDiagnostics && !diagnostics.restartRequired) return text;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
    parsed._meta = {
      ...(parsed._meta && typeof parsed._meta === 'object' ? parsed._meta as Record<string, unknown> : {}),
      ...(includeOutcome ? { autoIndex: outcome } : {}),
      ...(forceDiagnostics || diagnostics.restartRequired ? { mcp: diagnostics } : {}),
      ...(context && runtime && (forceDiagnostics || diagnostics.restartRequired)
        ? {
            index: {
              root: context.root,
              indexPath: context.indexPath,
              loaded: !!runtime.index,
              generated: runtime.index?.meta.generated ?? null,
              watchMode: runtime.watcher ? 'active' : 'on-call-fallback',
              dirty: runtime.changeGeneration !== runtime.checkedGeneration,
              lastCheckedAt: runtime.lastCheckAt ? new Date(runtime.lastCheckAt).toISOString() : null,
            },
          }
        : {}),
    };
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

export function callTool(name: string, args: Record<string, unknown>): string {
  const context = callContext(args);
  if ('error' in context) return JSON.stringify(context, null, 2);
  const runtime = ensureFresh(context.indexPath);
  if (!runtime.index) {
    return JSON.stringify({ error: `No code-map index found at ${context.indexPath}. Run \`map index --root <repo>\`, then pass \`root\` as that repository's absolute path.` }, null, 2);
  }
  return dispatch(runtime.index, name, args, runtime.observations);
}

export async function callToolAsync(name: string, args: Record<string, unknown>): Promise<string> {
  const context = callContext(args);
  if ('error' in context) return withResponseMeta(JSON.stringify(context, null, 2), null, args.diagnostics === true);
  let runtime = ensureFresh(context.indexPath);
  const root = args.root === undefined && runtime.index?.meta.root ? resolve(runtime.index.meta.root) : context.root;
  let outcome = await maybeAutoIndex(runtime, context.indexPath, root);
  runtime = ensureFresh(context.indexPath);
  if (!runtime.index) {
    const error = outcome?.status === 'failed'
      ? `Automatic code-map indexing failed for ${root}: ${outcome.error}`
      : `No code-map index found at ${context.indexPath}. Automatic indexing is ${AUTO_INDEX_ENABLED ? 'enabled but did not produce an index' : 'disabled by CODE_MAP_AUTO_INDEX=off'}.`;
    return withResponseMeta(JSON.stringify({ error }, null, 2), outcome, args.diagnostics === true, { ...context, root }, runtime);
  }

  const before = runtime.observations;
  const trial = new Map(before);
  let text = dispatch(runtime.index, name, args, trial);
  if (responseNeedsIndexRetry(text)) {
    const retryOutcome = await maybeAutoIndex(runtime, context.indexPath, root, true);
    if (retryOutcome && (retryOutcome.status !== 'current' || !outcome)) outcome = retryOutcome;
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
  return withResponseMeta(text, outcome, args.diagnostics === true, { ...context, root }, runtime);
}

export function disposeMcpState(): void {
  for (const runtime of indexRuntimes.values()) disposeRuntime(runtime);
  indexRuntimes.clear();
  for (const flight of autoIndexFlights.values()) flight.controller.abort();
  autoIndexFlights.clear();
}

function uniqueRefs(values: unknown[], max = 64): { refs: string[]; total: number } {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const value of values) {
    const ref = String(value);
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (refs.length < max) refs.push(ref);
  }
  return { refs, total: seen.size };
}

function observationFingerprint(result: ReadResult): string {
  const hash = createHash('sha256').update(JSON.stringify([
    result.status,
    result.id,
    result.file,
    result.line,
    result.endLine ?? null,
    result.candidates ?? null,
  ]));
  hash.update(result.raw == null ? '\x00' : '\x01');
  if (result.raw != null) hash.update(result.raw);
  return hash.digest('base64url');
}

function rememberObservation(observations: Map<string, string>, key: string, fingerprint: string): void {
  observations.delete(key);
  observations.set(key, fingerprint);
  while (observations.size > MAX_OBSERVATIONS) {
    const oldest = observations.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    observations.delete(oldest);
  }
}

function rememberResult(observations: Map<string, string>, ref: string, result: ReadResult): void {
  const fingerprint = observationFingerprint(result);
  rememberObservation(observations, ref, fingerprint);
  if (result.id !== ref) rememberObservation(observations, result.id, fingerprint);
}

function observedDelta(index: MapIndex, refs: string[], observations: Map<string, string>): {
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
    if (stable && previous === fingerprint) unchanged.push(result.id);
    else {
      changedOut.push(result);
      if (result.file) filesChanged.add(result.file);
    }
    rememberResult(observations, ref, result);
  }
  return { unchanged, changed: changedOut, filesChecked: filesChecked.size, filesChanged: filesChanged.size };
}

/** Pure tool dispatch over a given index — exported so the protocol layer can be
 * exercised in tests without a live stdio process. */
export function dispatch(index: MapIndex, name: string, args: Record<string, unknown>, observations?: Map<string, string>): string {
  switch (name) {
    case 'read': {
      const hasRefs = args.refs !== undefined;
      const hasRef = args.ref !== undefined;
      if (hasRefs && hasRef) return JSON.stringify({ error: 'Pass `ref` (single) OR `refs` (batch), not both.' }, null, 2);
      if (hasRefs) {
        if (!Array.isArray(args.refs) || args.refs.length === 0) return JSON.stringify({ error: '`refs` must be a non-empty array of symbol ids or names.' }, null, 2);
        // Long-lived MCP calls compare with what this session actually returned before.
        // Pure/one-shot dispatch has no session baseline, so it keeps the index-relative fallback.
        if (args.changedOnly) {
          const { refs } = uniqueRefs(args.refs);
          return JSON.stringify(observations ? observedDelta(index, refs, observations) : changed(index, refs));
        }
        // Batch: one round-trip for many symbols — same slices, fewer turns. Dedupe (keep
        // first occurrence) and cap so a stray huge array can't blow up the context window.
        const MAX = 64;
        const { refs, total } = uniqueRefs(args.refs, MAX);
        const results = readMany(index, refs);
        if (observations) {
          for (let i = 0; i < refs.length; i++) rememberResult(observations, refs[i], results[i]);
        }
        const out: Record<string, unknown> = { results };
        if (total > MAX) out.note = `Read first ${MAX} of ${total} refs; split the rest into another call.`;
        // Compact (no pretty-print indentation) — leaner in context than N single pretty reads.
        return JSON.stringify(out);
      }
      if (!hasRef) return JSON.stringify({ error: 'Pass `ref` (a symbol id or name) or `refs` (an array).' }, null, 2);
      if (typeof args.ref !== 'string' || !args.ref.trim()) {
        return JSON.stringify({ error: '`ref` must be a non-empty string.' }, null, 2);
      }
      if (args.snippet !== undefined && typeof args.snippet !== 'string') {
        return JSON.stringify({ error: '`snippet` must be a string when provided.' }, null, 2);
      }
      const ref = args.ref;
      const result = read(index, ref, { snippet: args.snippet });
      if (observations) rememberResult(observations, ref, result);
      return JSON.stringify(result, null, 2);
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
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown>; [k: string]: unknown };
}

async function handle(req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'code-map', version: VERSION },
            instructions: SERVER_INSTRUCTIONS,
          },
        });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const text = await callToolAsync(String(params?.name ?? ''), params?.arguments ?? {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      }
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // notifications: no reply
      default:
        if (isRequest) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    if (isRequest) await send({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } });
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
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      return;
    }
    void handle(req);
  });
  const close = (): void => {
    if (stopping) return;
    stopping = true;
    disposeMcpState();
  };
  rl.once('close', close);
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
  isEntry = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  /* not resolvable (e.g. imported) — stay dormant */
}
if (isEntry) main();

function argIndex(): string | undefined {
  const i = process.argv.indexOf('--index');
  return i !== -1 ? process.argv[i + 1] : undefined;
}
