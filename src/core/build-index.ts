import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { extractSymbols } from './extract-symbols.ts';
import { listSourceFiles } from './files.ts';
import type { FileStat, MapEntry, MapIndex } from './types.ts';
import { firstLine, lineAt, token } from './util.ts';

/** Index format version. Bump invalidates incremental reuse from older indexes. */
const INDEX_VERSION = 2;

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
      reused++;
    } else {
      changedFiles.push(file);
    }
  }

  // Read & re-parse only the changed/new files — the build's real cost.
  const text = await readAll(root, changedFiles);
  for (const file of changedFiles) {
    const src = text.get(file) ?? null;
    const st = stats.get(file) ?? null;
    if (src == null) {
      filesMissing.push(file);
      continue;
    }
    fileTokens[file] = token(src);
    if (st) fileStats[file] = { mtimeMs: st.mtimeMs, size: st.size };
    for (const rec of extractSymbols(file, src)) {
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
        visibility: rec.visibility,
        static: rec.static,
        fanIn: 0,
        definitionId: `${file}#${rec.kind}:${rec.charStart}-${rec.charEnd}`,
      });
    }
  }

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
    entries,
  };

  return { index, filesIndexed: files.length, filesMissing, defs, methods, privateDefs, reused, changed: changedFiles.length, unchanged };
}
