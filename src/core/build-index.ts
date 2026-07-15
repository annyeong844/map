import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
import { resolvePythonCommand } from './python-command.ts';
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

/** Python parse backend: the stdlib-ast extractor, shelled out once per build.
 * The whole tree is walked for import resolution; only `targets` are parsed
 * (incremental). Returns the same per-file primitives the oxc path does, so the
 * shared entry/fan-in pipeline runs over Python unchanged. A backend failure
 * aborts the build: silently replacing valid Python entries with an empty set
 * would corrupt an incremental index. */
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
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'number')
  );
}

function isPyImportEdge(value: unknown): value is ImportEdge {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    typeof value.name === 'string' &&
    (value.reexport === undefined || typeof value.reexport === 'boolean')
  );
}

function isPySymbol(value: unknown): value is PySymbolRec {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.file === 'string' &&
    typeof value.line === 'number' &&
    typeof value.endLine === 'number' &&
    typeof value.charStart === 'number' &&
    typeof value.charEnd === 'number' &&
    typeof value.searchText === 'string' &&
    typeof value.exported === 'boolean'
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

function runPyBackend(
  root: string,
  files: string[],
  targets: string[],
  signal?: AbortSignal,
): Promise<PyParse> {
  return new Promise((res, rej) => {
    let python;
    try {
      python = resolvePythonCommand();
    } catch (error) {
      rej(
        error instanceof Error
          ? error
          : new Error('Python command resolution failed.', { cause: error }),
      );
      return;
    }
    if (signal?.aborted) {
      rej(new Error('Index build aborted.'));
      return;
    }
    const p = spawn(python.command, [...python.args, PY_BACKEND, root], {
      stdio: ['pipe', 'pipe', 'pipe'],
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
      rej(
        new Error(
          `Python backend failed (${python.display}): ${reason}. Set CODE_MAP_PYTHON to a working Python 3 executable.`,
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
        if (!isPyParse(parsed)) {
          fail('returned JSON with an invalid result shape');
          return;
        }
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        res(parsed);
      } catch (e) {
        fail(
          `returned invalid JSON${e instanceof Error ? `: ${e.message}` : ''}`,
        );
      }
    });
    // Node already enumerated the gitignore-aware source set. Hand it to Python
    // so the backend neither walks the whole repository again nor sees ignored
    // Python files that the main index intentionally excluded.
    p.stdin.end(JSON.stringify({ files, targets }));
  });
}

const READ_CONCURRENCY = 32;
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
  /** Exported top-level symbols. */
  defs: number;
  /** Class methods. */
  methods: number;
  /** Module-private top-level symbols. */
  privateDefs: number;
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
      !!a.reexport !== !!b.reexport
    ) {
      return false;
    }
  }
  return true;
}

const fanInSurfaceKey = (entry: MapEntry): string =>
  `${entry.name}\0${entry.default ? 1 : 0}`;

function sameFanInSurface(before: MapEntry[], after: MapEntry[]): boolean {
  const oldKeys = new Set(before.map(fanInSurfaceKey));
  const newKeys = new Set(after.map(fanInSurfaceKey));
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
      for (const entry of prev.entries) {
        if (entry.kind === 'ClassMethod') methods++;
        else if (entry.visibility === 'module-private') privateDefs++;
      }
      counts = {
        defs: prev.entries.length - methods - privateDefs,
        methods,
        privateDefs,
      };
    }
    return {
      index: prev,
      filesIndexed: files.length,
      filesMissing: [],
      defs: counts.defs,
      methods: counts.methods,
      privateDefs: counts.privateDefs,
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
  const pyChanged = changedFiles.filter(isPython);

  // Python files go through the stdlib-ast backend (one batched subprocess, the
  // gitignore-aware file set supplied by Node); TS/JS goes through oxc.
  const pyByFile = new Map<string, PySymbolRec[]>();
  let py: PyParse | null = null;
  if (pyChanged.length) {
    py = await runPyBackend(root, pyFiles, pyChanged, opts.signal);
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
            kind: rec.kind,
            file,
            line: rec.line,
            endLine: rec.endLine,
            charStart: rec.charStart,
            charEnd: rec.charEnd,
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
      const parsed = extractSymbols(file, src);
      fileImports[file] = parsed.imports;
      const lines = buildLineIndex(src);
      for (const rec of parsed.symbols) {
        const line = indexedLineAt(lines, rec.charStart);
        bucket.push({
          id: mkId(file, rec.name, rec.kind, line),
          name: rec.name,
          kind: rec.kind,
          file,
          line,
          endLine: indexedLineAt(lines, rec.charEnd),
          charStart: rec.charStart,
          charEnd: rec.charEnd,
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
        oldFanIn.set(fanInSurfaceKey(entry), entry.fanIn ?? 0);
      }
      for (const entry of entriesByFile.get(file) ?? []) {
        entry.fanIn = oldFanIn.get(fanInSurfaceKey(entry)) ?? 0;
      }
    }
  } else {
    const importsByFile = new Map<string, ImportEdge[]>(
      Object.entries(fileImports),
    );
    const fanIn = computeFanIn(files, importsByFile);
    for (const e of entries) {
      // A default-exported symbol is referenced by importers as `default`, not its
      // local name, so credit that bucket too (`import foo from './x'` → x.ts::default).
      e.fanIn =
        (fanIn.get(`${e.file}::${e.name}`) ?? 0) +
        (e.default ? (fanIn.get(`${e.file}::default`) ?? 0) : 0);
    }
  }

  let methods = 0;
  let privateDefs = 0;
  for (const e of entries) {
    if (e.kind === 'ClassMethod') methods++;
    else if (e.visibility === 'module-private') privateDefs++;
  }
  const defs = entries.length - methods - privateDefs;

  const index: MapIndex = {
    meta: {
      tool: 'code-map',
      version: INDEX_VERSION,
      generated: new Date().toISOString(),
      builtAtMs: Date.now(),
      root,
      entryCount: entries.length,
      fileCount: files.length,
      counts: { defs, methods, privateDefs },
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
    defs,
    methods,
    privateDefs,
    reused: reusableFiles.length,
    changed: changedFiles.length,
    unchanged: false,
    fanInReused,
  };
}
