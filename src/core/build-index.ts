import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCallEdges } from './call-graph.ts';
import { type CallSite, extractSymbols, type ImportEdge, isPython, type SymbolRec } from './extract-symbols.ts';
import { computeFanIn } from './fan-in.ts';
import { listSourceFiles } from './files.ts';
import { computePublicSurface } from './public-surface.ts';
import type { FileStat, MapEntry, MapIndex } from './types.ts';
import { firstLine, lineAt, token } from './util.ts';

/** Python parse backend: the stdlib-ast extractor, shelled out once per build.
 * The whole tree is walked for import resolution; only `targets` are parsed
 * (incremental). Returns the same per-file primitives the oxc path does, so the
 * shared entry/fan-in/call-graph pipeline runs over Python unchanged. Returns null
 * if Python isn't available — Python files then just don't appear (honest skip). */
const PY_BACKEND = fileURLToPath(new URL('../py/extract.py', import.meta.url));
interface PyParse { entries: (SymbolRec & { file: string })[]; fileImports: Record<string, ImportEdge[]>; fileCalls: Record<string, CallSite[]> }
function runPyBackend(root: string, targets: string[]): Promise<PyParse | null> {
  return new Promise((res) => {
    const cmd = process.env.CODE_MAP_PYTHON ?? 'python3';
    const p = spawn(cmd, [PY_BACKEND, root], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => res(null)); // python not found → skip Python gracefully
    p.on('close', () => { try { res(JSON.parse(out)); } catch { res(null); } });
    p.stdin.end(targets.join('\n'));
  });
}

/** Index format version. Bump invalidates incremental reuse from older indexes. */
const INDEX_VERSION = 8;

async function readAll(root: string, files: string[], concurrency = 32): Promise<Map<string, string | null>> {
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
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return out;
}

/** Concurrent stat — a read-free change signal, cheaper than reading on a mount. */
async function statAll(root: string, files: string[], concurrency = 64): Promise<Map<string, { mtimeMs: number; size: number } | null>> {
  const out = new Map<string, { mtimeMs: number; size: number } | null>();
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < files.length) {
      const f = files[i++];
      try {
        const s = await stat(join(root, f));
        out.set(f, { mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        out.set(f, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  return out;
}

export interface BuildOptions {
  /** Source root to index. The only required input — the map parses it itself. */
  root: string;
  /** Prior index to reuse unchanged files from (incremental rebuild). */
  previous?: MapIndex | null;
  /** Ignore `previous` and rebuild every file. */
  force?: boolean;
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
  const files = listSourceFiles(root);

  const entries: MapEntry[] = [];
  const fileTokens: Record<string, string> = {};
  const fileStats: Record<string, FileStat> = {};
  const fileImports: Record<string, ImportEdge[]> = {};
  const fileCalls: Record<string, CallSite[]> = {};
  const filesMissing: string[] = [];
  const usedIds = new Map<string, number>();

  const mkId = (file: string, name: string, kind: string, line: number): string => {
    let id = `${file}#${name}`;
    if (usedIds.has(id)) id = `${file}#${name}#${kind}`;
    if (usedIds.has(id)) id = `${file}#${name}@${line}`;
    const n = (usedIds.get(id) ?? 0) + 1;
    usedIds.set(id, n);
    return n === 1 ? id : `${id}~${n}`;
  };

  // Incremental: a file's coordinates depend only on its own bytes, so an
  // unchanged stat (mtime+size) means its entries can be reused untouched.
  const prev =
    opts.previous && !opts.force && opts.previous.meta.version === INDEX_VERSION && opts.previous.fileStats && opts.previous.meta.root === root ? opts.previous : null;
  const prevByFile = new Map<string, MapEntry[]>();
  if (prev) {
    for (const e of prev.entries) {
      const arr = prevByFile.get(e.file);
      if (arr) arr.push(e);
      else prevByFile.set(e.file, [e]);
    }
  }

  const stats = await statAll(root, files);
  const changedFiles: string[] = [];
  let reused = 0;
  for (const file of files) {
    const st = stats.get(file) ?? null;
    const pv = prev?.fileStats[file];
    const reusable = !!pv && !!st && prev!.fileTokens[file] !== undefined && pv.mtimeMs === st.mtimeMs && pv.size === st.size;
    if (reusable) {
      for (const e of prevByFile.get(file) ?? []) entries.push(e);
      fileTokens[file] = prev!.fileTokens[file];
      fileStats[file] = pv!;
      fileImports[file] = prev!.fileImports?.[file] ?? [];
      fileCalls[file] = prev!.fileCalls?.[file] ?? [];
      reused++;
    } else {
      changedFiles.push(file);
    }
  }

  // Read & re-parse only the changed/new files — the build's real cost.
  const text = await readAll(root, changedFiles);

  // Python files go through the stdlib-ast backend (one batched subprocess, the
  // whole tree walked for import resolution); TS/JS through oxc. Both return the
  // same per-file primitives, so the entry build below — stable ids, fan-in, the
  // Level-1 call graph — is identical regardless of language.
  const pyChanged = changedFiles.filter(isPython);
  const pyByFile = new Map<string, SymbolRec[]>();
  let pyImports: Record<string, ImportEdge[]> = {};
  let pyCalls: Record<string, CallSite[]> = {};
  if (pyChanged.length) {
    const py = await runPyBackend(root, pyChanged);
    if (py) {
      for (const rec of py.entries) {
        const a = pyByFile.get(rec.file);
        if (a) a.push(rec);
        else pyByFile.set(rec.file, [rec]);
      }
      pyImports = py.fileImports ?? {};
      pyCalls = py.fileCalls ?? {};
    }
  }

  for (const file of changedFiles) {
    const src = text.get(file) ?? null;
    const st = stats.get(file) ?? null;
    if (src == null) {
      filesMissing.push(file);
      continue;
    }
    fileTokens[file] = token(src);
    if (st) fileStats[file] = { mtimeMs: st.mtimeMs, size: st.size };
    let symbols: SymbolRec[];
    let imports: ImportEdge[];
    let calls: CallSite[];
    let refs: Record<string, number> = {};
    if (isPython(file)) {
      symbols = pyByFile.get(file) ?? [];
      imports = pyImports[file] ?? [];
      calls = pyCalls[file] ?? [];
    } else {
      const parsed = extractSymbols(file, src);
      symbols = parsed.symbols;
      imports = parsed.imports;
      calls = parsed.calls;
      refs = parsed.refs;
    }
    fileImports[file] = imports;
    fileCalls[file] = calls;
    for (const rec of symbols) {
      const line = lineAt(src, rec.charStart);
      entries.push({
        id: mkId(file, rec.name, rec.kind, line),
        name: rec.name,
        kind: rec.kind,
        file,
        line,
        endLine: lineAt(src, rec.charEnd),
        charStart: rec.charStart,
        charEnd: rec.charEnd,
        searchText: firstLine(src, rec.charStart) || rec.name,
        className: rec.className,
        extends: rec.extends,
        visibility: rec.visibility,
        static: rec.static,
        fanIn: 0,
        intraRefs: refs[rec.name] ?? 0,
        definitionId: `${file}#${rec.kind}:${rec.charStart}-${rec.charEnd}`,
      });
    }
  }

  // Native fan-in: a global pass over all import edges (reused files contribute
  // cached edges, so this needs no extra reads). Recomputed every build because a
  // def's fan-in can shift when *another* file changes its imports.
  const importsByFile = new Map<string, ImportEdge[]>(Object.entries(fileImports));
  const fanIn = computeFanIn(files, importsByFile);
  for (const e of entries) e.fanIn = fanIn.get(`${e.file}::${e.name}`) ?? 0;

  // Public surface: entry/exported files (package.json → tsconfig source map →
  // re-export closure), so the dead-export screen can spare them.
  const reexportsByFile = new Map<string, ImportEdge[]>();
  for (const [f, edges] of importsByFile) {
    const re = edges.filter((e) => e.reexport);
    if (re.length) reexportsByFile.set(f, re);
  }
  const publicSurface = computePublicSurface(root, files, reexportsByFile);

  // Call graph: resolve direct call sites into caller→callee edges (Level 1).
  const callEdges = computeCallEdges(entries, importsByFile, new Map(Object.entries(fileCalls)), files);

  entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));

  let methods = 0;
  let privateDefs = 0;
  for (const e of entries) {
    if (e.kind === 'ClassMethod') methods++;
    else if (e.visibility === 'module-private') privateDefs++;
  }
  const defs = entries.length - methods - privateDefs;
  const unchanged = !!prev && changedFiles.length === 0 && entries.length === prev.entries.length;

  const index: MapIndex = {
    meta: {
      tool: 'code-map',
      version: INDEX_VERSION,
      generated: new Date().toISOString(),
      builtAtMs: Date.now(),
      root,
      entryCount: entries.length,
    },
    fileTokens,
    fileStats,
    fileImports,
    publicFiles: [...publicSurface.files].sort(),
    fileCalls,
    callEdges,
    entries,
  };

  return { index, filesIndexed: files.length, filesMissing, defs, methods, privateDefs, reused, changed: changedFiles.length, unchanged };
}
