import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { availableParallelism, freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractSymbols,
  type ImportEdge,
  isPython,
  type SymbolRec,
} from './extract-symbols.ts';
import { computeFanIn } from './fan-in.ts';
import { type IndexDriftScan, scanIndexDrift } from './index-drift.ts';
import {
  type PythonBackendCommand,
  resolvePythonBackend,
} from './python-command.ts';
import {
  type FileStat,
  INDEX_VERSION,
  type MapEntry,
  type MapIndex,
} from './types.ts';
import {
  buildLineIndex,
  firstLine,
  indexedLineAt,
  isRecord,
  token,
} from './util.ts';

/** Python parse backend: packaged native Ruff parser, with stdlib AST fallback.
 * Only `targets` are parsed (incremental); the complete file set is used for
 * import resolution. Both implementations return the same per-file primitives
 * as oxc, so the shared entry/fan-in pipeline stays unchanged. A backend failure
 * aborts the build: silently replacing valid entries would corrupt the index. */
// Both src/core/build-index.ts and dist/core/build-index.js resolve this to the
// package's single shipped Python source file.
const PY_BACKEND = fileURLToPath(
  new URL('../../src/py/extract.py', import.meta.url),
);
interface PySymbolRec extends SymbolRec {
  file: string;
  line: number;
  endLine: number;
  searchText: string;
}
interface PyParse {
  entries: PySymbolRec[];
  fileImports: Record<string, ImportEdge[]>;
  fileTokens: Record<string, string>;
  fileRefs: Record<string, Record<string, number>>;
  filesMissing: string[];
  filesInvalid: string[];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isIndexNumber);
}

function isPyImportEdge(value: unknown): value is ImportEdge {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.name === 'string' &&
    (value.sourceName === undefined || typeof value.sourceName === 'string') &&
    (value.reexport === undefined || typeof value.reexport === 'boolean')
  );
}

function isPySymbol(value: unknown): value is PySymbolRec {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.file === 'string' &&
    isIndexNumber(value.line) &&
    value.line >= 1 &&
    isIndexNumber(value.endLine) &&
    value.endLine >= value.line &&
    isIndexNumber(value.charStart) &&
    isIndexNumber(value.charEnd) &&
    value.charEnd >= value.charStart &&
    (value.anchorOffset === undefined ||
      (isIndexNumber(value.anchorOffset) &&
        value.anchorOffset <= value.charEnd - value.charStart)) &&
    typeof value.searchText === 'string' &&
    typeof value.exported === 'boolean' &&
    (value.namePath === undefined || typeof value.namePath === 'string') &&
    (value.className === undefined || typeof value.className === 'string') &&
    (value.extends === undefined || typeof value.extends === 'string') &&
    (value.visibility === undefined || typeof value.visibility === 'string') &&
    (value.static === undefined || typeof value.static === 'boolean') &&
    (value.default === undefined || typeof value.default === 'boolean')
  );
}

function isPyParse(value: unknown): value is PyParse {
  if (
    !isRecord(value) ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isPySymbol) ||
    !isStringRecord(value.fileTokens) ||
    !Array.isArray(value.filesMissing) ||
    !value.filesMissing.every((file) => typeof file === 'string') ||
    !Array.isArray(value.filesInvalid) ||
    !value.filesInvalid.every((file) => typeof file === 'string') ||
    !isRecord(value.fileImports) ||
    !isRecord(value.fileRefs)
  ) {
    return false;
  }
  return (
    Object.values(value.fileImports).every(
      (edges) => Array.isArray(edges) && edges.every(isPyImportEdge),
    ) && Object.values(value.fileRefs).every(isNumberRecord)
  );
}

const NATIVE_PY_KINDS = [
  'FunctionDeclaration',
  'ClassDeclaration',
  'ClassMethod',
  'assign-var',
  'ann-var',
  'TypeAlias',
] as const;
const NATIVE_PY_FILE_FIELDS = 5;
const NATIVE_PY_ENTRY_FIELDS = 11;

function isIndexNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

type NativePyEntry = readonly [
  name: string,
  kindIndex: number,
  charStart: number,
  charEnd: number,
  line: number,
  endLine: number,
  searchText: string,
  anchorOffset: number | null,
  namePath: string | null,
  className: string | null,
  extendsName: string | null,
];

type NativePyFileRecord = readonly [
  file: string,
  sourceToken: string,
  entries: unknown[],
  imports: unknown[],
  refs: Record<string, number>,
];

interface NativePyEnvelope {
  v: 1;
  p: unknown[];
  i: unknown[];
  m: string[];
}

function isNativePyEnvelope(value: unknown): value is NativePyEnvelope {
  return (
    isRecord(value) &&
    value.v === 1 &&
    Array.isArray(value.p) &&
    Array.isArray(value.i) &&
    Array.isArray(value.m) &&
    value.m.every((file) => typeof file === 'string')
  );
}

function isNativePyFileRecord(value: unknown): value is NativePyFileRecord {
  return (
    Array.isArray(value) &&
    value.length === NATIVE_PY_FILE_FIELDS &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string' &&
    Array.isArray(value[2]) &&
    Array.isArray(value[3]) &&
    isNumberRecord(value[4])
  );
}

function isNativePyImportEdge(
  value: unknown,
): value is readonly [source: string, name: string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

function isNativePyEntry(value: unknown): value is NativePyEntry {
  return (
    Array.isArray(value) &&
    value.length === NATIVE_PY_ENTRY_FIELDS &&
    typeof value[0] === 'string' &&
    isIndexNumber(value[1]) &&
    value[1] < NATIVE_PY_KINDS.length &&
    isIndexNumber(value[2]) &&
    isIndexNumber(value[3]) &&
    value[3] >= value[2] &&
    isIndexNumber(value[4]) &&
    value[4] >= 1 &&
    isIndexNumber(value[5]) &&
    value[5] >= value[4] &&
    typeof value[6] === 'string' &&
    (value[7] === null ||
      (isIndexNumber(value[7]) && value[7] <= value[3] - value[2])) &&
    (value[8] === null || typeof value[8] === 'string') &&
    (value[9] === null || typeof value[9] === 'string') &&
    (value[10] === null || typeof value[10] === 'string')
  );
}

function isNativePyInvalidRecord(
  value: unknown,
): value is readonly [file: string, sourceToken: string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string'
  );
}

/** Decode the native extractor's file-grouped wire format. Repeated field
 * names and file paths would otherwise dominate its output on large corpora.
 * The validation stays strict because CODE_MAP_PY_NATIVE may point at a
 * user-supplied executable. */
function decodeNativePyParse(value: unknown): PyParse | null {
  if (!isNativePyEnvelope(value)) return null;
  const result: PyParse = {
    entries: [],
    fileImports: {},
    fileTokens: {},
    fileRefs: {},
    filesMissing: value.m,
    filesInvalid: [],
  };
  const seen = new Set<string>();
  for (const record of value.p) {
    if (!isNativePyFileRecord(record) || seen.has(record[0])) {
      return null;
    }
    const [file, sourceToken, wireEntries, wireImports, refs] = record;
    seen.add(file);
    const imports: ImportEdge[] = [];
    for (const edge of wireImports) {
      if (!isNativePyImportEdge(edge)) return null;
      imports.push({ source: edge[0], name: edge[1] });
    }
    for (const entry of wireEntries) {
      if (!isNativePyEntry(entry)) return null;
      const [
        name,
        kindIndex,
        charStart,
        charEnd,
        line,
        endLine,
        searchText,
        anchorOffset,
        namePath,
        className,
        extendsName,
      ] = entry;
      result.entries.push({
        name,
        kind: NATIVE_PY_KINDS[kindIndex],
        file,
        charStart,
        charEnd,
        line,
        endLine,
        searchText,
        exported: !name.startsWith('_'),
        anchorOffset: anchorOffset ?? undefined,
        namePath: namePath ?? undefined,
        visibility: name.startsWith('_') ? 'module-private' : undefined,
        className: className ?? undefined,
        extends: extendsName ?? undefined,
      });
    }
    result.fileTokens[file] = sourceToken;
    result.fileImports[file] = imports;
    result.fileRefs[file] = refs;
  }
  for (const record of value.i) {
    if (!isNativePyInvalidRecord(record) || seen.has(record[0])) {
      return null;
    }
    const [file, sourceToken] = record;
    seen.add(file);
    result.fileTokens[file] = sourceToken;
    result.fileImports[file] = [];
    result.fileRefs[file] = {};
    result.filesInvalid.push(file);
  }
  return result;
}

const MAX_PY_SHARDS = 8;
const PY_BYTES_PER_SHARD = 2_097_152; // 2 MiB of changed source
const PY_MEMORY_RESERVE = 536_870_912; // leave 512 MiB outside workers
const PY_MEMORY_PER_SHARD = 134_217_728; // conservative 128 MiB allowance

function partitionPyTargets(
  targets: string[],
  stats: ReadonlyMap<string, FileStat | null>,
): string[][] {
  let totalBytes = 0;
  const weighted = targets.map((file, order) => {
    const bytes = stats.get(file)?.size ?? 0;
    totalBytes += bytes;
    return { file, order, bytes };
  });
  const availableMemory =
    typeof process.availableMemory === 'function'
      ? process.availableMemory()
      : freemem();
  const memoryShards = Math.max(
    1,
    Math.floor(
      Math.max(0, availableMemory - PY_MEMORY_RESERVE) / PY_MEMORY_PER_SHARD,
    ),
  );
  const shardCount = Math.min(
    MAX_PY_SHARDS,
    availableParallelism(),
    memoryShards,
    targets.length,
    Math.max(1, Math.ceil(totalBytes / PY_BYTES_PER_SHARD)),
  );
  if (shardCount <= 1) return [targets];

  // Largest-first greedy packing prevents one generated or god-file from
  // becoming the serial tail. Sorting is O(files log files); the capped
  // assignment that follows is O(files).
  weighted.sort((a, b) => b.bytes - a.bytes || a.order - b.order);
  const shards = Array.from({ length: shardCount }, () => ({
    bytes: 0,
    targets: [] as { file: string; order: number }[],
  }));
  for (const target of weighted) {
    let lightest = shards[0];
    for (let i = 1; i < shards.length; i++) {
      if (shards[i].bytes < lightest.bytes) lightest = shards[i];
    }
    lightest.bytes += target.bytes;
    lightest.targets.push(target);
  }
  return shards.map((shard) =>
    shard.targets.sort((a, b) => a.order - b.order).map(({ file }) => file),
  );
}

function mergePyParses(parts: PyParse[]): PyParse {
  const merged: PyParse = {
    entries: [],
    fileImports: {},
    fileTokens: {},
    fileRefs: {},
    filesMissing: [],
    filesInvalid: [],
  };
  for (const part of parts) {
    for (const entry of part.entries) merged.entries.push(entry);
    Object.assign(merged.fileImports, part.fileImports);
    Object.assign(merged.fileTokens, part.fileTokens);
    Object.assign(merged.fileRefs, part.fileRefs);
    for (const file of part.filesMissing) merged.filesMissing.push(file);
    for (const file of part.filesInvalid) merged.filesInvalid.push(file);
  }
  return merged;
}

function runPyShard(
  backend: PythonBackendCommand,
  root: string,
  files: string[],
  targets: string[],
  signal?: AbortSignal,
): Promise<PyParse> {
  return new Promise((res, rej) => {
    if (signal?.aborted) {
      rej(new Error('Index build aborted.'));
      return;
    }
    const backendArgs =
      backend.kind === 'native'
        ? [...backend.args, root]
        : [...backend.args, PY_BACKEND, root];
    const p = spawn(backend.command, backendArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try {
        p.kill();
      } catch {
        /* already gone */
      }
      rej(new Error('Index build aborted.'));
    };
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try {
        p.kill();
      } catch {
        /* already gone */
      }
      rej(
        new Error(
          `Python backend failed (${backend.display}): ${reason}. ` +
            (backend.kind === 'native'
              ? 'Set CODE_MAP_PY_BACKEND=stdlib to use the portable fallback.'
              : 'Set CODE_MAP_PYTHON to a working Python 3 executable.'),
        ),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    p.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    p.stdin.on('error', (e) => {
      fail(e.message);
    });
    p.on('error', (e) => {
      fail(e.message);
    });
    p.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        const errorText = Buffer.concat(stderr, stderrBytes).toString().trim();
        fail(`exited with code ${code}${errorText ? `: ${errorText}` : ''}`);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(
          Buffer.concat(stdout, stdoutBytes).toString(),
        );
        let normalized: PyParse | null;
        if (backend.kind === 'native') {
          normalized = decodeNativePyParse(parsed);
        } else {
          normalized = isPyParse(parsed) ? parsed : null;
        }
        if (!normalized) {
          fail('returned JSON with an invalid result shape');
          return;
        }
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        res(normalized);
      } catch (e) {
        fail(
          `returned invalid JSON${e instanceof Error ? `: ${e.message}` : ''}`,
        );
      }
    });
    // Node already enumerated the gitignore-aware source set. Hand it to the
    // backend so it neither walks the whole repository again nor sees ignored
    // Python files that the main index intentionally excluded.
    p.stdin.end(JSON.stringify({ files, targets }));
  });
}

async function runPyBackend(
  root: string,
  files: string[],
  targets: string[],
  stats: ReadonlyMap<string, FileStat | null>,
  signal?: AbortSignal,
): Promise<PyParse> {
  let backend: PythonBackendCommand;
  try {
    backend = resolvePythonBackend();
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Python backend resolution failed.', { cause: error });
  }

  // The native extractor parallelizes within one process. Node-side sharding
  // would only duplicate process startup and memory; keep it for stdlib Python.
  if (backend.kind === 'native') {
    return runPyShard(backend, root, files, targets, signal);
  }

  const shards = partitionPyTargets(targets, stats);
  if (shards.length === 1) {
    return runPyShard(backend, root, files, shards[0], signal);
  }

  // One failing or cancelled shard tears down its siblings. Workers are
  // short-lived direct Node children; no resident pool survives the build.
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const parts = await Promise.all(
      shards.map((targetsInShard) =>
        runPyShard(backend, root, files, targetsInShard, controller.signal),
      ),
    );
    return mergePyParses(parts);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

const READ_CONCURRENCY = 32;
// Raw transfer removes JSON AST materialization but has a fixed virtual-buffer
// setup cost. Corpus A/B keeps tiny repositories and edits on the cheaper path.
const RAW_TRANSFER_MIN_CHANGED_BYTES = 262_144;
async function readAll(
  root: string,
  files: string[],
  concurrency = READ_CONCURRENCY,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < files.length) {
      const f = files[i++];
      try {
        out.set(f, await readFile(join(root, f), 'utf8'));
      } catch {
        out.set(f, null);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker),
  );
  return out;
}

/** Concurrent stat — a read-free change signal, cheaper than reading on a mount. */
export interface BuildOptions {
  /** Source root to index. The only required input — the map parses it itself. */
  root: string;
  /** Prior index to reuse unchanged files from (incremental rebuild). */
  previous?: MapIndex | null;
  /** Ignore `previous` and rebuild every file. */
  force?: boolean;
  /** Reuse a drift scan already performed by an automatic-index gate. */
  scan?: IndexDriftScan;
  /** Abort external parser work when the owning MCP connection closes. */
  signal?: AbortSignal;
}

export interface BuildReport {
  index: MapIndex;
  filesIndexed: number;
  filesMissing: string[];
  /** Python files whose current text did not parse. */
  filesInvalid: string[];
  /** Exported top-level symbols. */
  defs: number;
  /** Class methods. */
  methods: number;
  /** Module-private top-level symbols. */
  privateDefs: number;
  /** Declarations below a top-level function or class, excluding methods. */
  nestedDefs: number;
  /** Files reused verbatim from the previous index (incremental). */
  reused: number;
  /** Files re-read and re-parsed this build. */
  changed: number;
  /** Nothing changed vs the previous index — the caller may skip writing it. */
  unchanged: boolean;
  /** Global import routes and each changed file's fan-in key surface were
   * identical, so prior per-entry fan-in values were reused. */
  fanInReused: boolean;
}

function sameImportEdges(before: ImportEdge[], after: ImportEdge[]): boolean {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if (
      a.source !== b.source ||
      a.name !== b.name ||
      (a.sourceName ?? a.name) !== (b.sourceName ?? b.name) ||
      !!a.reexport !== !!b.reexport
    ) {
      return false;
    }
  }
  return true;
}

const fanInSurfaceKey = (entry: MapEntry): string | null =>
  entry.kind === 'ClassMethod' || entry.namePath
    ? null
    : `${entry.name}\0${entry.default ? 1 : 0}`;

function sameFanInSurface(before: MapEntry[], after: MapEntry[]): boolean {
  const oldKeys = new Set<string>();
  const newKeys = new Set<string>();
  for (const entry of before) {
    const key = fanInSurfaceKey(entry);
    if (key !== null) oldKeys.add(key);
  }
  for (const entry of after) {
    const key = fanInSurfaceKey(entry);
    if (key !== null) newKeys.add(key);
  }
  if (oldKeys.size !== newKeys.size) return false;
  for (const key of oldKeys) if (!newKeys.has(key)) return false;
  return true;
}

/** Reusing entry fan-in is sound only when computeFanIn's complete input
 * (file set + ordered import edges) is unchanged and every new entry asks for
 * a key that existed previously. The surface guard catches the tempting but
 * wrong case where an already-imported definition is newly added. */
function canReuseFanIn(
  previous: MapIndex | null,
  files: string[],
  changedFiles: string[],
  prevByFile: Map<string, MapEntry[]>,
  entriesByFile: Map<string, MapEntry[]>,
  fileImports: Record<string, ImportEdge[]>,
): previous is MapIndex {
  if (!previous) return false;
  const oldFiles = Object.keys(previous.fileStats);
  if (
    oldFiles.length !== files.length ||
    files.some((file) => !Object.hasOwn(previous.fileStats, file))
  ) {
    return false;
  }
  for (const file of changedFiles) {
    const before = prevByFile.get(file) ?? [];
    const after = entriesByFile.get(file) ?? [];
    if (before.some((entry) => typeof entry.fanIn !== 'number')) return false;
    if (
      !sameImportEdges(
        previous.fileImports?.[file] ?? [],
        fileImports[file] ?? [],
      )
    ) {
      return false;
    }
    if (!sameFanInSurface(before, after)) return false;
  }
  return true;
}

function compareWithinFile(a: MapEntry, b: MapEntry): number {
  return a.line - b.line || a.name.localeCompare(b.name);
}

/**
 * Build a coordinate-only map by parsing the source tree directly with oxc.
 *
 * No external symbol graph: the map enumerates the repo's files, parses each,
 * and records the coordinate of every top-level symbol and class method. It
 * stores where things are, never what they mean.
 */
export async function buildIndex(opts: BuildOptions): Promise<BuildReport> {
  const root = resolve(opts.root);
  if (opts.signal?.aborted) throw new Error('Index build aborted.');
  const drift =
    opts.scan && opts.scan.root === root && !opts.force
      ? opts.scan
      : await scanIndexDrift(root, opts.previous, !!opts.force, opts.signal);
  const { files, stats, changedFiles, reusableFiles } = drift;
  const prev = drift.compatible ? drift.previous : null;

  // True no-op: stats are identical and no source file appeared/disappeared.
  // Return the prior object directly; fan-in, entry cloning, sorting and JSON
  // preparation would all reproduce bytes the caller intentionally won't save.
  if (prev && drift.totalChanged === 0) {
    let counts = prev.meta.counts;
    if (!counts) {
      let methods = 0;
      let privateDefs = 0;
      let nestedDefs = 0;
      for (const entry of prev.entries) {
        if (entry.kind === 'ClassMethod') methods++;
        else if (entry.namePath) nestedDefs++;
        else if (entry.visibility === 'module-private') privateDefs++;
      }
      counts = {
        defs: prev.entries.length - methods - privateDefs - nestedDefs,
        methods,
        privateDefs,
        nestedDefs,
      };
    }
    return {
      index: prev,
      filesIndexed: files.length,
      filesMissing: [],
      filesInvalid: prev.meta.invalidFiles ?? [],
      defs: counts.defs,
      methods: counts.methods,
      privateDefs: counts.privateDefs,
      nestedDefs: counts.nestedDefs ?? 0,
      reused: files.length,
      changed: 0,
      unchanged: true,
      fanInReused: true,
    };
  }

  const entriesByFile = new Map<string, MapEntry[]>();
  const fileTokens: Record<string, string> = {};
  const fileStats: Record<string, FileStat> = {};
  const fileImports: Record<string, ImportEdge[]> = {};
  const filesMissing: string[] = [];
  const currentFiles = new Set(files);
  const filesInvalid = new Set(
    (prev?.meta.invalidFiles ?? []).filter((file) => currentFiles.has(file)),
  );
  const usedIds = new Map<string, number>();

  const mkId = (
    file: string,
    name: string,
    kind: string,
    line: number,
  ): string => {
    let id = `${file}#${name}`;
    if (usedIds.has(id)) id = `${file}#${name}#${kind}`;
    if (usedIds.has(id)) id = `${file}#${name}@${line}`;
    const n = (usedIds.get(id) ?? 0) + 1;
    usedIds.set(id, n);
    return n === 1 ? id : `${id}~${n}`;
  };

  const prevByFile = new Map<string, MapEntry[]>();
  if (prev) {
    for (const entry of prev.entries) {
      const bucket = prevByFile.get(entry.file);
      if (bucket) bucket.push(entry);
      else prevByFile.set(entry.file, [entry]);
    }
    for (const file of reusableFiles) {
      // Fan-in is global and may change because another file changed. Clone the
      // reused entries before updating it so `previous` stays an immutable snapshot.
      const clonedEntries: MapEntry[] = [];
      for (const entry of prevByFile.get(file) ?? []) {
        clonedEntries.push({ ...entry });
      }
      entriesByFile.set(file, clonedEntries);
      fileTokens[file] = prev.fileTokens[file];
      fileStats[file] = prev.fileStats[file];
      fileImports[file] = prev.fileImports?.[file] ?? [];
    }
  }

  const pyFiles = files.filter(isPython);
  const pyChanged: string[] = [];
  let jsChangedBytes = 0;
  for (const file of changedFiles) {
    if (isPython(file)) pyChanged.push(file);
    else jsChangedBytes += stats.get(file)?.size ?? 0;
  }
  const useRawTransfer = jsChangedBytes >= RAW_TRANSFER_MIN_CHANGED_BYTES;

  // Python files go through the native extractor when its platform prebuilt is
  // present; the stdlib fallback keeps the same result contract.
  const pyByFile = new Map<string, PySymbolRec[]>();
  const pyInvalidFiles = new Set<string>();
  let py: PyParse | null = null;
  if (pyChanged.length) {
    py = await runPyBackend(root, pyFiles, pyChanged, stats, opts.signal);
    for (const file of py.filesInvalid) pyInvalidFiles.add(file);
    for (const rec of py.entries) {
      const a = pyByFile.get(rec.file);
      if (a) a.push(rec);
      else pyByFile.set(rec.file, [rec]);
    }
  }

  // Preserve deterministic file order, but release source text after each
  // existing 32-file I/O batch instead of retaining every changed JS/TS file.
  for (
    let batchStart = 0;
    batchStart < changedFiles.length;
    batchStart += READ_CONCURRENCY
  ) {
    if (opts.signal?.aborted) throw new Error('Index build aborted.');
    const batch = changedFiles.slice(batchStart, batchStart + READ_CONCURRENCY);
    const text = await readAll(
      root,
      batch.filter((file) => !isPython(file)),
    );
    for (const file of batch) {
      const st = stats.get(file) ?? null;
      const bucket: MapEntry[] = [];
      if (isPython(file)) {
        const sourceToken = py?.fileTokens[file];
        if (sourceToken === undefined) {
          filesMissing.push(file);
          continue;
        }
        if (pyInvalidFiles.has(file)) {
          filesInvalid.add(file);
          const priorToken = prev?.fileTokens[file];
          if (priorToken !== undefined) {
            for (const entry of prevByFile.get(file) ?? []) {
              bucket.push({ ...entry });
            }
            entriesByFile.set(file, bucket);
            fileTokens[file] = priorToken;
            if (st) {
              fileStats[file] = {
                mtimeMs: st.mtimeMs,
                size: st.size,
                ctimeMs: st.ctimeMs,
                ino: st.ino,
              };
            }
            fileImports[file] = prev?.fileImports?.[file] ?? [];
            continue;
          }
        } else {
          filesInvalid.delete(file);
        }
        entriesByFile.set(file, bucket);
        fileTokens[file] = sourceToken;
        if (st) {
          fileStats[file] = {
            mtimeMs: st.mtimeMs,
            size: st.size,
            ctimeMs: st.ctimeMs,
            ino: st.ino,
          };
        }
        fileImports[file] = py?.fileImports[file] ?? [];
        const refs = py?.fileRefs[file] ?? {};
        for (const rec of pyByFile.get(file) ?? []) {
          bucket.push({
            id: mkId(file, rec.name, rec.kind, rec.line),
            name: rec.name,
            namePath: rec.namePath,
            kind: rec.kind,
            file,
            line: rec.line,
            endLine: rec.endLine,
            charStart: rec.charStart,
            charEnd: rec.charEnd,
            anchorOffset: rec.anchorOffset,
            searchText: rec.searchText || rec.name,
            className: rec.className,
            extends: rec.extends,
            visibility: rec.visibility,
            static: rec.static,
            default: rec.default,
            fanIn: 0,
            intraRefs: refs[rec.name] ?? 0,
            definitionId: `${file}#${rec.kind}:${rec.charStart}-${rec.charEnd}`,
          });
        }
        continue;
      }

      const src = text.get(file) ?? null;
      if (src == null) {
        filesMissing.push(file);
        continue;
      }
      entriesByFile.set(file, bucket);
      fileTokens[file] = token(src);
      if (st) {
        fileStats[file] = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          ctimeMs: st.ctimeMs,
          ino: st.ino,
        };
      }
      const parsed = extractSymbols(file, src, {
        rawTransfer: useRawTransfer,
      });
      fileImports[file] = parsed.imports;
      const lines = buildLineIndex(src);
      for (const rec of parsed.symbols) {
        const line = indexedLineAt(lines, rec.charStart);
        bucket.push({
          id: mkId(file, rec.name, rec.kind, line),
          name: rec.name,
          namePath: rec.namePath,
          kind: rec.kind,
          file,
          line,
          endLine: indexedLineAt(lines, rec.charEnd),
          charStart: rec.charStart,
          charEnd: rec.charEnd,
          anchorOffset: rec.anchorOffset,
          searchText: firstLine(src, rec.charStart) || rec.name,
          className: rec.className,
          extends: rec.extends,
          visibility: rec.visibility,
          static: rec.static,
          default: rec.default,
          fanIn: 0,
          intraRefs: parsed.refs[rec.name] ?? 0,
          definitionId: `${file}#${rec.kind}:${rec.charStart}-${rec.charEnd}`,
        });
      }
    }
  }

  // Format v13 guarantees this global file/line order. Line-only reads use it
  // for an O(log entries) first next-sibling lookup without a full table. `files` is
  // already sorted. Parser output is normally source-ordered; only
  // rare export aliases can point backward, so detect that and sort that one
  // file instead of globally sorting every entry on every build.
  const entries: MapEntry[] = [];
  for (const file of files) {
    const bucket = entriesByFile.get(file);
    if (!bucket) continue;
    let ordered = true;
    for (let i = 1; i < bucket.length; i++) {
      if (compareWithinFile(bucket[i - 1], bucket[i]) > 0) {
        ordered = false;
        break;
      }
    }
    if (!ordered) bucket.sort(compareWithinFile);
    for (const entry of bucket) entries.push(entry);
  }

  // Body-only edits keep the global import graph unchanged. If their exported
  // fan-in key surface is unchanged too, copy the prior values only into those
  // changed entries and skip the O(files + import edges) global graph pass.
  const fanInReused = canReuseFanIn(
    prev,
    files,
    changedFiles,
    prevByFile,
    entriesByFile,
    fileImports,
  );
  if (fanInReused) {
    for (const file of changedFiles) {
      const oldFanIn = new Map<string, number>();
      for (const entry of prevByFile.get(file) ?? []) {
        const key = fanInSurfaceKey(entry);
        if (key !== null) oldFanIn.set(key, entry.fanIn ?? 0);
      }
      for (const entry of entriesByFile.get(file) ?? []) {
        const key = fanInSurfaceKey(entry);
        entry.fanIn = key === null ? 0 : (oldFanIn.get(key) ?? 0);
      }
    }
  } else {
    const importsByFile = new Map<string, ImportEdge[]>(
      Object.entries(fileImports),
    );
    const fanIn = computeFanIn(files, importsByFile);
    for (const e of entries) {
      if (e.kind === 'ClassMethod' || e.namePath) {
        e.fanIn = 0;
        continue;
      }
      // A default-exported symbol is referenced by importers as `default`, not its
      // local name, so credit that bucket too (`import foo from './x'` → x.ts::default).
      e.fanIn =
        (fanIn.get(`${e.file}::${e.name}`) ?? 0) +
        (e.default ? (fanIn.get(`${e.file}::default`) ?? 0) : 0);
    }
  }

  let methods = 0;
  let privateDefs = 0;
  let nestedDefs = 0;
  for (const e of entries) {
    if (e.kind === 'ClassMethod') methods++;
    else if (e.namePath) nestedDefs++;
    else if (e.visibility === 'module-private') privateDefs++;
  }
  const defs = entries.length - methods - privateDefs - nestedDefs;

  const index: MapIndex = {
    meta: {
      tool: 'code-map',
      version: INDEX_VERSION,
      generated: new Date().toISOString(),
      builtAtMs: Date.now(),
      root,
      entryCount: entries.length,
      fileCount: files.length,
      counts: { defs, methods, privateDefs, nestedDefs },
      invalidFiles: [...filesInvalid].sort(),
    },
    fileTokens,
    fileStats,
    fileImports,
    entries,
  };
  if (opts.signal?.aborted) throw new Error('Index build aborted.');
  return {
    index,
    filesIndexed: files.length,
    filesMissing,
    filesInvalid: [...filesInvalid].sort(),
    defs,
    methods,
    privateDefs,
    nestedDefs,
    reused: reusableFiles.length,
    changed: changedFiles.length,
    unchanged: false,
    fanInReused,
  };
}
