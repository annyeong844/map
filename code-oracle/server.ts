#!/usr/bin/env node
/**
 * code-oracle MCP — type-aware call resolution over a warm LSP session, multi-language:
 * tsgo (TypeScript-Go) for TS/JS, ty for Python. Picked per file extension; both speak
 * the same LSP, so the session/cache/query machinery is shared.
 *
 * Sibling to code-map, not part of it: code-map routes to coordinates (instant, light,
 * drift-resistant); code-oracle answers "who calls this / what implements this / where is
 * this defined" at CHECKER grade via LSP references/definition/implementation — including
 * calls through interfaces / DI that a structural call graph can't draw. The statefulness
 * (warm LSP sessions, project warmup, file sync, preview churn) is contained HERE behind a
 * stateless MCP tool surface, so code-map stays clean and the backend is swappable.
 *
 * Backends: TS via the tsgo binary (`TSGO_BIN`, else the copy installed in this package);
 * Python via ty's language server (`TY_CMD`, else `uvx ty server`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTOCOL = '2025-06-18';
// Readiness by quiescence: the project is "loaded" once tsgo stops emitting
// log/progress messages for QUIET_MS — far better than a fixed sleep. Bounded by
// MIN_MS (don't trust a momentary pause) and MAX_MS (never hang).
const QUIET_MS = Number(process.env.TS_ORACLE_QUIET_MS ?? 1500);
const MIN_MS = Number(process.env.TS_ORACLE_MIN_MS ?? 1500);
const MAX_MS = Number(process.env.TS_ORACLE_WARMUP_MS ?? 30000);
const REQ_TIMEOUT_MS = Number(process.env.TS_ORACLE_REQ_TIMEOUT_MS ?? 40000);

const HERE = dirname(fileURLToPath(import.meta.url));

type Lang = 'ts' | 'py';
function langOf(file: string): Lang | null {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) return 'ts';
  if (/\.(py|pyi)$/.test(file)) return 'py';
  return null;
}

/** The LSP backend for a language: how to spawn it + the LSP `languageId`. tsgo
 * for TS/JS, ty for Python — both speak the same LSP, so everything downstream
 * (framing, readiness, references/definition/implementation, cache) is shared. */
function backend(lang: Lang): { cmd: string; args: string[]; languageId: string } | null {
  if (lang === 'ts') {
    if (process.env.TSGO_BIN && existsSync(process.env.TSGO_BIN)) {
      const override = process.env.TSGO_BIN;
      return /\.[cm]?js$/i.test(override)
        ? { cmd: process.execPath, args: [override, '--lsp', '--stdio'], languageId: 'typescript' }
        : { cmd: override, args: ['--lsp', '--stdio'], languageId: 'typescript' };
    }
    const bin = join(HERE, 'node_modules/@typescript/native-preview/bin/tsgo.js');
    const platform = join(HERE, 'node_modules/@typescript', `native-preview-${process.platform}-${process.arch}`);
    // npm can leave a wrapper plus another OS's optional package in a shared
    // checkout. Treat that as unavailable now, not as two 40-second LSP timeouts.
    return existsSync(bin) && existsSync(platform) ? { cmd: process.execPath, args: [bin, '--lsp', '--stdio'], languageId: 'typescript' } : null;
  }
  // Python via ty's language server. TY_CMD overrides (e.g. an absolute `ty`); default runs via uvx.
  return process.env.TY_CMD ? { cmd: process.env.TY_CMD, args: ['server'], languageId: 'python' } : { cmd: 'uvx', args: ['ty', 'server'], languageId: 'python' };
}

const ROOT_MARKERS: Record<Lang, string[]> = { ts: ['tsconfig.json'], py: ['pyproject.toml', 'setup.py', 'setup.cfg'] };
/** Nearest ancestor dir with a project marker — the LSP project root for a file. */
function projectRoot(file: string, lang: Lang): string {
  const markers = ROOT_MARKERS[lang];
  let dir = dirname(resolve(file));
  for (;;) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(resolve(file));
    dir = parent;
  }
}

/** Incremental Content-Length decoder. Every input/body byte is copied at most
 * once, even when a large JSON-RPC message arrives one tiny chunk at a time. */
export class ContentLengthDecoder {
  private headerBytes: number[] = [];
  private bodyChunks: Buffer[] = [];
  private bodyBytes = 0;
  private bodyLength: number | null = null;

  push(chunk: Buffer): Buffer[] {
    const messages: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.bodyLength == null) {
        const byte = chunk[offset++];
        this.headerBytes.push(byte);
        const n = this.headerBytes.length;
        if (n > 16 * 1024) { this.headerBytes = []; continue; }
        if (n < 4 || this.headerBytes[n - 4] !== 13 || this.headerBytes[n - 3] !== 10 || this.headerBytes[n - 2] !== 13 || this.headerBytes[n - 1] !== 10) continue;
        const header = Buffer.from(this.headerBytes).toString();
        this.headerBytes = [];
        const match = /Content-Length: (\d+)/i.exec(header);
        const length = match ? Number(match[1]) : -1;
        if (!Number.isSafeInteger(length) || length < 0 || length > 256 * 1024 * 1024) continue;
        this.bodyLength = length;
        this.bodyBytes = 0;
        this.bodyChunks = [];
        if (length === 0) {
          this.bodyLength = null;
          messages.push(Buffer.alloc(0));
        }
        continue;
      }

      const take = Math.min(this.bodyLength - this.bodyBytes, chunk.length - offset);
      if (take > 0) this.bodyChunks.push(chunk.subarray(offset, offset + take));
      this.bodyBytes += take;
      offset += take;
      if (this.bodyBytes !== this.bodyLength) continue;
      messages.push(this.bodyChunks.length === 1 ? this.bodyChunks[0] : Buffer.concat(this.bodyChunks, this.bodyLength));
      this.bodyLength = null;
      this.bodyBytes = 0;
      this.bodyChunks = [];
    }
    return messages;
  }
}

/** A warm LSP session (tsgo or ty): Content-Length framed JSON-RPC, server-request
 * replies, quiescence warmup, live file sync. Language-agnostic — the backend just
 * supplies the spawn command and the LSP `languageId`. */
class LspSession {
  private proc: ChildProcess;
  private decoder = new ContentLengthDecoder();
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private failure: Error | null = null;
  private nextId = 1;
  private opened = new Map<string, { version: number; mtimeMs: number; ctimeMs: number; size: number; ino: number }>();
  private initDone: Promise<void>;
  private warmed = false;
  private lastMsgAt = Date.now();
  private languageId: string;

  constructor(spec: { cmd: string; args: string[]; languageId: string }, root: string) {
    this.languageId = spec.languageId;
    this.proc = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout!.on('data', (d: Buffer) => this.onData(d));
    this.proc.on('error', (error) => this.fail(error));
    this.proc.on('exit', (code, signal) => this.fail(new Error(`LSP backend exited before replying (${signal ?? `code ${code}`}).`)));
    this.initDone = this.initialize(root);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private onData(d: Buffer): void {
    this.lastMsgAt = Date.now(); // bump on any server activity (logs/progress) — drives quiescence readiness
    for (const body of this.decoder.push(d)) this.handleMessage(body);
  }

  private handleMessage(body: Buffer): void {
    let msg: any;
    try { msg = JSON.parse(body.toString()); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      pending.resolve(msg.result);
    } else if (msg.id != null && msg.method) {
      // server→client request: must answer or the server stalls (watcher/config).
      const result = msg.method === 'workspace/configuration' ? (msg.params?.items ?? []).map(() => ({})) : null;
      this.write({ jsonrpc: '2.0', id: msg.id, result });
    }
  }

  private write(msg: unknown): void {
    const s = JSON.stringify(msg);
    this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }
  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }
  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve(null);
      }, REQ_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private async initialize(root: string): Promise<void> {
    const uri = pathToFileURL(root).href;
    await this.request('initialize', {
      processId: process.pid,
      rootUri: uri,
      capabilities: { workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: true } } },
      workspaceFolders: [{ uri, name: 'root' }],
    });
    this.notify('initialized', {});
  }

  /** Sync a file's current content into the session (didOpen first time, didChange after). */
  private syncFile(file: string): string {
    const uri = pathToFileURL(file).href;
    const info = statSync(file);
    const prior = this.opened.get(uri);
    if (prior && prior.mtimeMs === info.mtimeMs && prior.ctimeMs === info.ctimeMs && prior.size === info.size && prior.ino === info.ino) return uri;
    const text = readFileSync(file, 'utf8');
    const version = (prior?.version ?? 0) + 1;
    this.opened.set(uri, { version, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, ino: info.ino });
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.languageId, version, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    return uri;
  }

  /** Wait until the project is loaded — tsgo has gone quiet for QUIET_MS (bounded). */
  private async waitReady(): Promise<void> {
    if (this.warmed) return;
    const start = Date.now();
    for (;;) {
      const elapsed = Date.now() - start;
      if ((Date.now() - this.lastMsgAt > QUIET_MS && elapsed > MIN_MS) || elapsed > MAX_MS) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    this.warmed = true;
  }

  /** Run an LSP location query (`references` / `definition` / `implementation`) at a
   * position; return target locations. Handles both Location and LocationLink shapes. */
  async locate(method: string, file: string, line: number, character: number): Promise<{ uri: string; line: number }[]> {
    await this.initDone;
    const uri = this.syncFile(file);
    await this.waitReady();
    const params: Record<string, unknown> = { textDocument: { uri }, position: { line, character } };
    if (method === 'textDocument/references') params.context = { includeDeclaration: false };
    const r = (await this.request(method, params)) as any;
    const arr = Array.isArray(r) ? r : r ? [r] : [];
    const locations: { uri: string; line: number }[] = [];
    for (const location of arr) {
      const target = location.uri ?? location.targetUri;
      if (target) locations.push({ uri: target, line: (location.range ?? location.targetRange)?.start?.line ?? 0 });
    }
    return locations;
  }

  /** Resolve a symbol NAME to its DECLARATION position via the LSP's documentSymbol —
   * the name's own range (selectionRange), so we anchor on the real declaration and never
   * on a comment/string/import the way a raw text scan can. Returns null if `name` isn't a
   * declared symbol in this file (caller then falls back to the comment-skipping text scan).
   * Among same-name symbols, prefer declaration kinds (function/method/class/…) over vars. */
  async documentSymbolPosition(file: string, name: string): Promise<{ line: number; character: number } | { ambiguous: OracleSym[] } | null> {
    await this.initDone;
    const uri = this.syncFile(file);
    await this.waitReady();
    const r = (await this.request('textDocument/documentSymbol', { textDocument: { uri } })) as any;
    if (!Array.isArray(r)) return null;
    let fileLines: string[] | null = null;
    const lineText = (ln: number): string => {
      if (!fileLines) { try { fileLines = readFileSync(file, 'utf8').split('\n'); } catch { fileLines = []; } }
      return fileLines[ln] ?? '';
    };
    const out: OracleSym[] = [];
    const walk = (nodes: any[], container: string | null): void => {
      for (const n of nodes) {
        if (n?.name) {
          const sel = n.selectionRange?.start; // DocumentSymbol: range of the name itself
          if (sel) out.push({ name: n.name, container, line: sel.line, character: sel.character, kind: n.kind ?? 0 });
          else if (n.location?.range?.start) { // SymbolInformation: refine column to the identifier
            const ln = n.location.range.start.line;
            const col = lineText(ln).indexOf(n.name);
            out.push({ name: n.name, container: n.containerName ?? container, line: ln, character: col >= 0 ? col : n.location.range.start.character, kind: n.kind ?? 0 });
          }
        }
        if (Array.isArray(n?.children)) walk(n.children, n?.name ?? container);
      }
    };
    walk(r, null);
    return resolveNamePosition(out, name);
  }

  /** Eagerly load the project (open a seed file + wait for quiescence) so the first
   * real query doesn't pay the cold warmup. Fire-and-forget at startup. */
  async prewarm(seedFile: string): Promise<void> {
    await this.initDone;
    this.syncFile(seedFile);
    await this.waitReady();
  }

  get ready(): boolean { return this.warmed; }

  dispose(): void { try { this.proc.kill(); } catch { /* ignore */ } }
}

// ── name → declaration position, from the LSP's documentSymbol tree ──
// A flattened documentSymbol entry: the symbol's name, its immediate container
// (parent symbol name, e.g. the class/interface holding a method), and the position
// of the name token itself.
export interface OracleSym { name: string; container: string | null; line: number; character: number; kind: number; }

// LSP SymbolKind values that name a real DECLARATION we'd want to anchor a query on.
const DECL_KINDS = new Set([5, 6, 9, 10, 11, 12, 23]); // Class/Method/Constructor/Enum/Interface/Function/Struct

/** Resolve a symbol NAME to a declaration position among a file's documentSymbol entries.
 *  Accepts a bare name (`send`) or a qualified `Container.name` (`RunChannelClient.send`).
 *  - Returns `{ line, character }` when the name resolves to a single declaration
 *    (declarations sharing one container — e.g. overload signatures — collapse to one).
 *  - Returns `{ ambiguous: [...] }` when a BARE name matches declarations in more than
 *    one container (e.g. `interface WebSocketLike.send` AND `class RunChannelClient.send`):
 *    silently anchoring on the first returns the wrong callers, so surface the choices.
 *  - Returns `null` when the name isn't a declared symbol here (caller falls back to a
 *    comment/import-skipping text scan). */
export function resolveNamePosition(
  symbols: OracleSym[],
  name: string,
): { line: number; character: number } | { ambiguous: OracleSym[] } | null {
  const dot = name.lastIndexOf('.');
  const wantContainer = dot > 0 ? name.slice(0, dot) : null;
  const wantName = dot > 0 ? name.slice(dot + 1) : name;
  const declarations = new Map<string, OracleSym>();
  const fallback = new Map<string, OracleSym>();
  // Match, prioritize and collapse overloads in one pass instead of allocating
  // two full filtered arrays for a large documentSymbol tree.
  for (const symbol of symbols) {
    if (symbol.name !== wantName || (wantContainer != null && symbol.container !== wantContainer)) continue;
    const key = symbol.container ?? '';
    const bucket = DECL_KINDS.has(symbol.kind) ? declarations : fallback;
    if (!bucket.has(key)) bucket.set(key, symbol);
  }
  const byContainer = declarations.size ? declarations : fallback;
  if (!byContainer.size) return null;
  const cands = [...byContainer.values()];
  if (cands.length > 1) return { ambiguous: cands };
  return { line: cands[0].line, character: cands[0].character };
}

// ── symbol → position, TEXT fallback (used only when the LSP can't resolve the name).
// Prefer the first occurrence on a line that is NOT a comment or an import — a raw
// first-hit scan anchored on the word inside a doc comment and returned 0 callers
// (firsthand 2026-06). Keep the first raw hit as a last resort so we never regress to null. ──
function findPosition(file: string, name?: string, line?: number, character?: number): { line: number; character: number } | null {
  if (line != null && character != null) return { line, character };
  if (!name) return null;
  const lines = readFileSync(file, 'utf8').split('\n');
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const isComment = (s: string) => /^\s*(\/\/|\/\*|\*|#)/.test(s);
  const isImport = (s: string) => /^\s*import\b/.test(s) || /^\s*(export\b.*\bfrom\b)/.test(s);
  let firstHit: { line: number; character: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].search(re);
    if (c < 0) continue;
    if (firstHit == null) firstHit = { line: i, character: c };
    if (isComment(lines[i]) || isImport(lines[i])) continue;
    return { line: i, character: c }; // first non-comment, non-import occurrence
  }
  return firstHit; // everything was comment/import — better than nothing
}

// ── one warm session per (language, project root). The working root is pre-warmed
// at startup (see prewarm()); other roots spin up lazily on first use. ──
const sessions = new Map<string, LspSession>();
function session(root: string, lang: Lang, spec: { cmd: string; args: string[]; languageId: string }): LspSession {
  const key = `${lang}::${root}`;
  let s = sessions.get(key);
  if (!s) sessions.set(key, (s = new LspSession(spec, root)));
  return s;
}

// ── persistent answer cache (the practical "snapshot"): the checker's RAM can't be
// serialized, but the ANSWERS can. Persisted per root, reloaded on start → after a
// restart, queries with no project change are served INSTANTLY, without even warming
// the LSP. Validity is gated by an order-independent project fingerprint: edits,
// additions and deletions all drop stale answers. ──
const CACHE_DIR = join(HERE, '.cache');
const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.cache', 'coverage',
  // Python vendored / caches — scanning these (esp. site-packages) made the epoch
  // scan dominate even cache hits on a big repo (the "ty warm" check surfaced it).
  'venv', '.venv', 'env', '.env', '__pycache__', 'site-packages', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.eggs',
]);
const SRC_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/;
const EPOCH_TTL_MS = Number(process.env.CODE_ORACLE_EPOCH_TTL_MS ?? 2000);

type Epoch = string;
const epochCache = new Map<string, { at: number; epoch: Epoch }>();

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** Sampled ≤ once / EPOCH_TTL, so repeat queries are O(1). A bounded breadth-first
 * directory walk plus 64 stat workers stays O(files) without the old unbounded
 * Promise tree / file-descriptor burst. The commutative fingerprint includes path,
 * size, mtime, ctime and inode, so non-max edits and deletions cannot hide behind an
 * unchanged "maximum mtime". */
async function projectEpoch(root: string): Promise<Epoch> {
  const c = epochCache.get(root);
  if (c && Date.now() - c.at < EPOCH_TTL_MS) return c.epoch;
  const epoch = await scanProjectEpoch(root);
  epochCache.set(root, { at: Date.now(), epoch });
  return epoch;
}

/** Uncached O(files) fingerprint pass, exported for deterministic regression tests. */
export async function scanProjectEpoch(root: string): Promise<Epoch> {
  const dirs = [root];
  const sources: string[] = [];
  for (let cursor = 0; cursor < dirs.length;) {
    const batch = dirs.slice(cursor, cursor + 32);
    cursor += batch.length;
    const listings = await Promise.all(batch.map(async (dir) => {
      try { return { dir, entries: await readdir(dir, { withFileTypes: true }) }; }
      catch { return { dir, entries: [] }; }
    }));
    for (const { dir, entries } of listings) {
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) dirs.push(path);
        else if (SRC_RE.test(entry.name)) sources.push(path);
      }
    }
  }

  let cursor = 0;
  let count = 0;
  let xor = 0;
  let sum = 0;
  const worker = async (): Promise<void> => {
    while (cursor < sources.length) {
      const path = sources[cursor++];
      try {
        const info = await stat(path);
        const signature = `${relative(root, path)}\0${info.size}\0${Math.trunc(info.mtimeMs * 1000)}\0${Math.trunc(info.ctimeMs * 1000)}\0${info.ino}`;
        const hash = fnv1a32(signature);
        xor = (xor ^ hash) >>> 0;
        sum = (sum + hash) >>> 0;
        count++;
      } catch { /* file disappeared during the scan */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(64, sources.length) }, worker));
  return `${count.toString(36)}:${xor.toString(36)}:${sum.toString(36)}`;
}

type Cache = { epoch: Epoch; entries: Record<string, unknown> };
const caches = new Map<string, Cache>();
const cacheFile = (root: string) => join(CACHE_DIR, `${sha16(root)}.json`);
function loadCache(root: string): Cache {
  let c = caches.get(root);
  if (c) return c;
  try { c = JSON.parse(readFileSync(cacheFile(root), 'utf8')) as Cache; } catch { c = { epoch: '', entries: {} }; }
  caches.set(root, c);
  return c;
}
function persistCache(root: string): void {
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(cacheFile(root), JSON.stringify(caches.get(root))); } catch { /* best effort */ }
}

const dirtyCaches = new Set<string>();
let persistTimer: NodeJS.Timeout | null = null;
function flushCaches(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  for (const root of dirtyCaches) persistCache(root);
  dirtyCaches.clear();
}
function schedulePersist(root: string): void {
  dirtyCaches.add(root);
  if (persistTimer) return;
  // Coalesce a burst of checker queries. Rewriting the whole answer snapshot per
  // result made Q distinct queries cost O(Q²) serialized bytes.
  persistTimer = setTimeout(flushCaches, 5000);
  persistTimer.unref();
}

const LINE_CACHE_MAX = 256;
const lineCache = new Map<string, { epoch: Epoch; lines: string[] }>();
function sourceLine(file: string, line0: number, epoch: Epoch): string {
  let cached = lineCache.get(file);
  if (!cached || cached.epoch !== epoch) {
    let lines: string[];
    try { lines = readFileSync(file, 'utf8').split('\n'); } catch { lines = []; }
    cached = { epoch, lines };
    lineCache.delete(file);
    lineCache.set(file, cached);
    if (lineCache.size > LINE_CACHE_MAX) lineCache.delete(lineCache.keys().next().value!);
  }
  return (cached.lines[line0] ?? '').trim().slice(0, 160);
}

const METHOD: Record<string, string> = {
  callers: 'textDocument/references',
  definition: 'textDocument/definition',
  implementations: 'textDocument/implementation',
};
// `ENGINE` is substituted with the actual backend (tsgo for TS/JS, ty for Python) per query.
const NOTE: Record<string, string> = {
  callers: 'Type-aware callers via ENGINE references (checker grade; resolves through interfaces / standard DI). Truly dynamic dispatch (Proxy, obj[k](), token-only DI) stays invisible — a residual for the agent to read.',
  definition: 'Type-aware definition(s) via ENGINE — where this symbol/expression actually resolves (the precise callee), not a name guess.',
  implementations: 'Implementations via ENGINE (type-aware CHA) — the concrete classes/methods behind an interface/abstract; the over-approximate set that is sound for blast radius.',
};

/** Cross-platform path bridge: accept BOTH WSL (`/mnt/c/...`) and Windows
 * (`C:\...`) paths no matter which OS this server runs on, so ONE server (e.g. a
 * fast win32 tsgo) can serve a Windows IDE and WSL agents (over interop) alike —
 * same files on disk, different path spelling. */
function toHostPath(p: unknown): any {
  if (typeof p !== 'string' || !p) return p;
  if (process.platform === 'win32') {
    const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
    return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p;
  }
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
}

/** One query path for all three tools: resolve a position, gate on the cache, else
 * ask the warm tsgo session (references / definition / implementation), format. */
async function query(tool: string, args: Record<string, any>): Promise<unknown> {
  if (!args.file) return { error: `${tool} needs \`file\` (and \`name\` or line/character).` };
  args.file = toHostPath(args.file);
  if (args.root) args.root = toHostPath(args.root);
  const file = isAbsolute(args.file) ? args.file : resolve(args.root ?? process.cwd(), args.file);
  if (!existsSync(file)) return { error: `file not found: ${file}` };
  const lang = langOf(file);
  if (!lang) return { error: `unsupported file type: ${file} (expected TS/JS or Python).` };
  const be = backend(lang);
  if (!be) return { error: lang === 'ts' ? 'tsgo not found — set TSGO_BIN or `npm install` in code-oracle/.' : 'ty not found — install ty or uvx, or set TY_CMD.' };
  const explicit = args.line != null && args.character != null ? { line: args.line as number, character: args.character as number } : null;
  if (!explicit && !args.name) return { error: `${tool} needs \`name\` or line/character.` };

  const root = args.root ? resolve(args.root) : projectRoot(file, lang);
  const relFile = relative(root, file).replace(/\\/g, '/');
  const cacheKey = `${tool}:${relFile}#${args.name ?? `${explicit!.line}:${explicit!.character}`}`;

  // Cache gate: serve instantly (no LSP warmup) when the project hasn't changed.
  const epoch = await projectEpoch(root);
  const cache = loadCache(root);
  if (cache.epoch === epoch && cache.entries[cacheKey]) {
    return { ...(cache.entries[cacheKey] as object), cached: true };
  }

  // Resolve the symbol position. Explicit coords win; otherwise anchor on the DECLARATION
  // via the LSP's documentSymbol (skips comments/strings/imports), falling back to the
  // comment-skipping text scan only if the LSP doesn't know the name.
  const sess = session(root, lang, be);
  let pos: { line: number; character: number } | null = explicit ?? null;
  if (!pos && args.name) {
    const resolved = await sess.documentSymbolPosition(file, args.name);
    if (resolved && 'ambiguous' in resolved) {
      const candidates = resolved.ambiguous.map((c) => ({
        name: c.container ? `${c.container}.${c.name}` : c.name,
        line: c.line,
        character: c.character,
      }));
      return {
        error: `"${args.name}" matches ${candidates.length} declarations in ${relFile}. Re-query with a qualified name (Container.name) or line/character (0-based).`,
        candidates,
      };
    }
    pos = resolved ?? findPosition(file, args.name);
  }
  if (!pos) return { error: `could not locate symbol "${args.name}" in ${relFile}; pass line/character.` };

  const locs = await sess.locate(METHOD[tool], file, pos.line, pos.character);
  const seen = new Set<string>();
  const out: { file: string; line: number; preview: string }[] = [];
  for (const r of locs) {
    const f = fileURLToPath(r.uri);
    const dk = `${f}\t${r.line}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    out.push({ file: relative(root, f).replace(/\\/g, '/'), line: r.line + 1, preview: sourceLine(f, r.line, epoch) });
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  // Honest guard (regression-verified 2026-06): ty 0.0.50's find-references is INTRA-FILE
  // ONLY — cross-file callers are NOT found (heavily-imported functions returned 0, while
  // grep/`definition` confirm they're used across many files). So for Python, callers/
  // implementations are a LOWER BOUND, not the cross-file blast radius. (ty `definition`
  // DOES resolve cross-file, so it's trustworthy.)
  const engine = lang === 'ts' ? 'tsgo' : 'ty';
  const base = NOTE[tool].replace(/ENGINE/g, engine);
  const pyRefsCaveat = lang === 'py' && (tool === 'callers' || tool === 'implementations');
  const note = pyRefsCaveat
    ? base + ' ⚠ Python (ty 0.0.50): find-references is INTRA-FILE ONLY here — cross-file callers are NOT found (verified). Treat as a LOWER BOUND / intra-file screen, NOT a complete blast radius. `definition` does resolve cross-file.'
    : base;
  const result = { tool, symbol: { file: relFile, name: args.name ?? null, position: pos }, root, results: out, count: out.length, cached: false, note, ...(pyRefsCaveat ? { incomplete: true } : {}) };
  if (cache.epoch !== epoch) { cache.epoch = epoch; cache.entries = {}; } // project changed → drop stale, re-seed
  cache.entries[cacheKey] = result;
  schedulePersist(root);
  return result;
}

// ── MCP server (newline-delimited JSON-RPC over stdio, like code-map) ──
const INPUT = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Source file (absolute, or relative to root/cwd).' },
    name: { type: 'string', description: 'Symbol name, resolved to its DECLARATION via the language server (comments/strings/imports are skipped). Accepts a qualified "Container.name" (e.g. "RunChannelClient.send"). If a bare name matches declarations in more than one container (e.g. an interface method and a same-named class method), the tool returns the candidates instead of guessing — re-query with the qualified name or line/character.' },
    line: { type: 'number', description: 'Optional 0-based line of the symbol (use with character).' },
    character: { type: 'number', description: 'Optional 0-based column of the symbol.' },
    root: { type: 'string', description: 'Optional project root; default = nearest ancestor tsconfig.json.' },
  },
  required: ['file'],
} as const;

const TOOLS = [
  {
    name: 'callers',
    description:
      'Type-aware callers of a symbol — "who calls this", at checker grade via a warm LSP session (tsgo for TS/JS, ty for Python; picked by file extension). Resolves calls through interfaces and standard DI (declaration types) that a structural call graph cannot. First call per project warms it (~seconds); the session stays warm and answers are cached.',
    inputSchema: INPUT,
  },
  {
    name: 'definition',
    description: 'Type-aware definition(s) of the symbol/expression at a location — where `obj.m()` actually resolves (the precise callee). Not a name guess. (tsgo for TS/JS, ty for Python.)',
    inputSchema: INPUT,
  },
  {
    name: 'implementations',
    description: 'Implementations of an interface/abstract method — the concrete classes/methods behind it (type-aware Class Hierarchy Analysis). The over-approximate set that is sound for blast radius (catches DI-injected impls); fan-out can be wide (an interface with N impls = N sites) — that breadth is the nature of dispatch, biased safely toward over-inclusion. (tsgo for TS/JS, ty for Python.)',
    inputSchema: INPUT,
  },
];

function send(msg: unknown): void { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(req: any): Promise<void> {
  const { id, method, params } = req;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'code-oracle', version: '0.1.0' } } });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const name = params?.name;
        if (!METHOD[name]) throw new Error(`unknown tool: ${name}`);
        const result = await query(name, params.arguments ?? {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
      }
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      default:
        if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } });
  }
}

// ── eager pre-warm: load the working project at startup so the first query is fast ──
async function firstSourceFile(root: string, lang: Lang): Promise<string | null> {
  const re = lang === 'ts' ? /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/ : /\.(py|pyi)$/;
  const queue = [root];
  let scanned = 0;
  for (let cursor = 0; cursor < queue.length && scanned < 4000; cursor++) {
    const dir = queue[cursor];
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    const subdirs: string[] = [];
    for (const e of ents) {
      scanned++;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) subdirs.push(join(dir, e.name)); }
      else if (re.test(e.name) && !e.name.endsWith('.d.ts')) return join(dir, e.name);
    }
    queue.push(...subdirs);
  }
  return null;
}

/** Pre-warm the oracle for the working project at startup (default on; set
 * CODE_ORACLE_PREWARM=0 to disable). Non-blocking — it overlaps the agent's other
 * startup work, so the first blast-radius query doesn't stall on the ~20s cold load. */
async function prewarm(): Promise<void> {
  if (process.env.CODE_ORACLE_PREWARM === '0') return;
  const root = process.env.CODE_ORACLE_ROOT ? resolve(process.env.CODE_ORACLE_ROOT) : process.cwd();
  const langs: Lang[] = [];
  if (existsSync(join(root, 'tsconfig.json'))) langs.push('ts');
  if (['pyproject.toml', 'setup.py', 'setup.cfg'].some((m) => existsSync(join(root, m)))) langs.push('py');
  for (const lang of langs) {
    const be = backend(lang);
    if (!be) { process.stderr.write(`code-oracle: ${lang} project at ${root} but its tool isn't installed — pre-warm skipped\n`); continue; }
    const seed = await firstSourceFile(root, lang);
    if (!seed) continue;
    process.stderr.write(`code-oracle: warming the ${lang} oracle for ${root} (~10-20s; queries wait until ready)…\n`);
    const started = Date.now();
    session(root, lang, be).prewarm(seed).then(
      () => process.stderr.write(`code-oracle: ${lang} oracle ready in ${Math.round((Date.now() - started) / 1000)}s\n`),
      (e) => process.stderr.write(`code-oracle: ${lang} pre-warm failed: ${e}\n`),
    );
  }
}

function main(): void {
  if (!backend('ts')) process.stderr.write('code-oracle: tsgo not found — set TSGO_BIN or `npm install` in code-oracle/. (Python uses ty via uvx / TY_CMD.) Tools error per-language until present.\n');
  void prewarm(); // eager, non-blocking
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let req: any;
    try { req = JSON.parse(t); } catch { return; }
    void handle(req);
  });
  const shutdown = () => { flushCaches(); for (const s of sessions.values()) s.dispose(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

let isEntry = false;
try { isEntry = !!process.argv[1] && (await import('node:fs')).realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* imported */ }
if (isEntry) main();

/** Kill every warm LSP session — tests must call this or the live tsgo/ty child
 * keeps the process alive. */
export function disposeAll(): void {
  flushCaches();
  for (const s of sessions.values()) s.dispose();
  sessions.clear();
}

export { query, TOOLS };
