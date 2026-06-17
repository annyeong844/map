import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extractPrivateDefs, isParseable } from './extract-private.ts';
import type { FileStat, MapEntry, MapIndex } from './types.ts';
import { firstLine, lineAt, offsetOfLine, parseRange, posix, token } from './util.ts';

/** Concurrent stat — a read-free change signal. Cheaper than reading on a mount. */
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

/**
 * Read many files concurrently. The index build is I/O-bound, not CPU-bound:
 * over a Windows/drvfs mount, sequential reads of a few thousand small files
 * cost ~10× more than reading them with bounded concurrency (oxc parsing of the
 * same set is an order of magnitude cheaper still).
 */
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

export interface BuildOptions {
  /** Path to the symbol-graph artifact (its symbols.json output). */
  symbolsPath: string;
  /** Source root the paths resolve against. Defaults to symbols.meta.root. */
  root?: string;
  /** Prior index to reuse unchanged files from (incremental rebuild). */
  previous?: MapIndex | null;
  /** Ignore `previous` and rebuild every file. */
  force?: boolean;
}

export interface BuildReport {
  index: MapIndex;
  filesIndexed: number;
  filesMissing: string[];
  defs: number;
  methods: number;
  /** Module-private top-level defs the map parsed itself (the symbol graph omits these). */
  privateDefs: number;
  /** Files reused verbatim from the previous index (incremental). */
  reused: number;
  /** Files re-read and re-derived this build. */
  changed: number;
  /** Nothing changed vs the previous index — the caller may skip writing it. */
  unchanged: boolean;
}

/**
 * Turn an existing AST symbol graph into a coordinate-only map.
 *
 * We reuse the symbol graph's precise AST work and throw away everything that
 * smells like meaning. What survives the transform: path, line, char range,
 * a content token per file, and one anchor line per symbol.
 */
export async function buildIndex(opts: BuildOptions): Promise<BuildReport> {
  const symbolsText = readFileSync(opts.symbolsPath, 'utf8');
  const symbols = JSON.parse(symbolsText);
  const sourceToken = token(symbolsText);
  const root = opts.root ?? symbols?.meta?.root;
  if (!root) throw new Error('No root: pass { root } or ensure symbols.meta.root exists.');
  const schemaVersion = symbols?.meta?.schemaVersion ?? 0;

  const defIndex: Record<string, Record<string, any>> = symbols.defIndex ?? {};
  const methodIndex: Record<string, Record<string, any[]>> = symbols.classMethodIndex ?? {};
  // Call-site counts, keyed by identity ("file::name" for defs, "file::Class#method" for methods).
  const fanInByIdentity: Record<string, number> = symbols.fanInByIdentity ?? {};

  // Group fan-in by owning file so a file's srcHash can fold in its consumer
  // counts — fan-in can shift (a new caller elsewhere) even when the file's own
  // bytes don't, and the index's ranking must reflect that.
  const fanInByFile = new Map<string, Record<string, number>>();
  for (const key of Object.keys(fanInByIdentity)) {
    const sep = key.indexOf('::');
    if (sep === -1) continue;
    const f = key.slice(0, sep);
    let slice = fanInByFile.get(f);
    if (!slice) fanInByFile.set(f, (slice = {}));
    slice[key.slice(sep + 2)] = fanInByIdentity[key];
  }
  /** Hash of a file's entire contribution from the symbol graph. */
  const srcHash = (file: string): string =>
    token(JSON.stringify([defIndex[file] ?? null, methodIndex[file] ?? null, fanInByFile.get(file) ?? null]));

  // Collect raw locations per file so we read each file exactly once.
  const byFile = new Map<string, RawLoc[]>();
  const push = (file: string, loc: RawLoc) => {
    const f = posix(file);
    const arr = byFile.get(f);
    if (arr) arr.push(loc);
    else byFile.set(f, [loc]);
  };

  // Export names per file — lets the private pass skip anything already public
  // (e.g. `function foo(){}; export { foo }`).
  const exportNames = new Map<string, Set<string>>();

  let defCount = 0;
  for (const [file, defs] of Object.entries(defIndex)) {
    const f = posix(file);
    const names = new Set<string>();
    exportNames.set(f, names);
    // Process every source file the symbol graph saw, even those with zero
    // exports (their defs object is empty) — that is exactly where private-only
    // CLI scripts live, and where the export-surface index gives us nothing.
    if (!byFile.has(f)) byFile.set(f, []);
    for (const d of Object.values(defs)) {
      names.add(d.name);
      if (d.localName) names.add(d.localName);
      const range = d.definitionId ? parseRange(d.definitionId) : null;
      push(file, {
        name: d.name,
        kind: d.kind ?? 'Definition',
        line: d.line ?? 1,
        charStart: range?.start,
        charEnd: range?.end,
        definitionId: d.definitionId,
        fanInKey: `${posix(file)}::${d.name}`,
      });
      defCount++;
    }
  }

  let methodCount = 0;
  for (const [file, methods] of Object.entries(methodIndex)) {
    for (const overloads of Object.values(methods)) {
      for (const m of overloads) {
        push(file, {
          name: m.name ?? m.methodName,
          kind: m.kind ?? 'ClassMethod',
          line: m.line ?? 1,
          className: m.className,
          visibility: m.visibility,
          static: m.static,
          definitionId: m.identity,
          fanInKey: m.identity,
        });
        methodCount++;
      }
    }
  }

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

  // Incremental: a file is reusable only if both its bytes (stat: mtime+size)
  // and its symbol-graph contribution (srcHash) are unchanged. Schema/root must
  // match too, else the prior index is from a different world.
  const prev =
    opts.previous && !opts.force && opts.previous.fileStats && opts.previous.meta.root === root && opts.previous.meta.sourceSchemaVersion === schemaVersion
      ? opts.previous
      : null;
  const prevByFile = new Map<string, MapEntry[]>();
  if (prev) {
    for (const e of prev.entries) {
      const arr = prevByFile.get(e.file);
      if (arr) arr.push(e);
      else prevByFile.set(e.file, [e]);
    }
  }

  const allFiles = [...byFile.keys()];
  const stats = await statAll(root, allFiles);

  const changedFiles: string[] = [];
  let reused = 0;
  for (const file of allFiles) {
    const st = stats.get(file) ?? null;
    const pv = prev?.fileStats[file];
    // Reuse on unchanged bytes + unchanged symbol-graph slice. A file with zero
    // entries last time (a barrel, side-effect-only module) is still reusable —
    // it just carries nothing forward; re-reading it would only re-confirm that.
    const reusable =
      !!pv && !!st && prev!.fileTokens[file] !== undefined && pv.mtimeMs === st.mtimeMs && pv.size === st.size && pv.srcHash === srcHash(file);
    if (reusable) {
      for (const e of prevByFile.get(file) ?? []) entries.push(e);
      fileTokens[file] = prev!.fileTokens[file];
      fileStats[file] = pv!;
      reused++;
    } else {
      changedFiles.push(file);
    }
  }

  // Read & re-derive only the changed/new files — the build's real cost.
  const fileText = await readAll(root, changedFiles);
  for (const file of changedFiles) {
    const locs = byFile.get(file)!;
    const text = fileText.get(file) ?? null;
    const st = stats.get(file) ?? null;
    if (text == null) {
      filesMissing.push(file);
    } else {
      fileTokens[file] = token(text);
      if (st) fileStats[file] = { mtimeMs: st.mtimeMs, size: st.size, srcHash: srcHash(file) };
      // Private-symbol coverage: parse the file ourselves (oxc) and add every
      // top-level definition the export surface left out. Same char-offset
      // convention, so these slice exactly like the exported ones.
      if (isParseable(file)) {
        const exported = exportNames.get(file) ?? new Set<string>();
        for (const p of extractPrivateDefs(file, text, exported)) {
          locs.push({
            name: p.name,
            kind: p.kind,
            line: lineAt(text, p.charStart),
            charStart: p.charStart,
            charEnd: p.charEnd,
            visibility: 'module-private',
            fanInKey: `${file}::${p.name}`,
          });
        }
      }
    }
    locs.sort((a, b) => a.line - b.line);
    for (const loc of locs) {
      let searchText = loc.name;
      let endLine: number | undefined;
      if (text != null) {
        if (loc.charStart != null) {
          searchText = firstLine(text, loc.charStart);
          if (loc.charEnd != null) endLine = lineAt(text, loc.charEnd);
        } else {
          searchText = firstLine(text, offsetOfLine(text, loc.line));
        }
      }
      entries.push({
        id: mkId(file, loc.name, loc.kind, loc.line),
        name: loc.name,
        kind: loc.kind,
        file,
        line: loc.line,
        endLine,
        charStart: loc.charStart,
        charEnd: loc.charEnd,
        searchText: searchText || loc.name,
        className: loc.className,
        visibility: loc.visibility,
        static: loc.static,
        fanIn: loc.fanInKey ? (fanInByIdentity[loc.fanInKey] ?? 0) : 0,
        definitionId: loc.definitionId,
      });
    }
  }

  entries.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
  const privateCount = entries.reduce((n, e) => (e.visibility === 'module-private' ? n + 1 : n), 0);

  const index: MapIndex = {
    meta: {
      tool: 'code-map',
      version: 1,
      generated: new Date().toISOString(),
      builtAtMs: Date.now(),
      root,
      source: opts.symbolsPath,
      sourceTool: symbols?.meta?.tool ?? 'unknown',
      sourceSchemaVersion: schemaVersion,
      sourceToken,
      entryCount: entries.length,
    },
    fileTokens,
    fileStats,
    entries,
  };

  // True no-op: every file reused and the entry set is identical to last time
  // (a dropped file would shrink entries even with zero re-reads).
  const unchanged = !!prev && changedFiles.length === 0 && entries.length === prev.entries.length;

  return { index, filesIndexed: byFile.size, filesMissing, defs: defCount, methods: methodCount, privateDefs: privateCount, reused, changed: changedFiles.length, unchanged };
}

interface RawLoc {
  name: string;
  kind: string;
  line: number;
  charStart?: number;
  charEnd?: number;
  className?: string;
  visibility?: string;
  static?: boolean;
  definitionId?: string;
  fanInKey?: string;
}
