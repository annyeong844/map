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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    const bin = process.env.TSGO_BIN && existsSync(process.env.TSGO_BIN) ? process.env.TSGO_BIN : join(HERE, 'node_modules/@typescript/native-preview/bin/tsgo.js');
    return existsSync(bin) ? { cmd: process.execPath, args: [bin, '--lsp', '--stdio'], languageId: 'typescript' } : null;
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

/** A warm LSP session (tsgo or ty): Content-Length framed JSON-RPC, server-request
 * replies, quiescence warmup, live file sync. Language-agnostic — the backend just
 * supplies the spawn command and the LSP `languageId`. */
class LspSession {
  private proc: ChildProcess;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, (r: unknown) => void>();
  private nextId = 1;
  private opened = new Map<string, number>(); // uri -> version
  private initDone: Promise<void>;
  private warmed = false;
  private lastMsgAt = Date.now();
  private languageId: string;

  constructor(spec: { cmd: string; args: string[]; languageId: string }, root: string) {
    this.languageId = spec.languageId;
    this.proc = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout!.on('data', (d: Buffer) => this.onData(d));
    this.initDone = this.initialize(root);
  }

  private onData(d: Buffer): void {
    this.lastMsgAt = Date.now(); // bump on any server activity (logs/progress) — drives quiescence readiness
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) break;
      const m = /Content-Length: (\d+)/i.exec(this.buf.subarray(0, sep).toString());
      if (!m) { this.buf = this.buf.subarray(sep + 4); continue; }
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.buf.length < start + len) break;
      let msg: any;
      try { msg = JSON.parse(this.buf.subarray(start, start + len).toString()); } catch { msg = null; }
      this.buf = this.buf.subarray(start + len);
      if (!msg) continue;
      if (msg.id != null && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg.result);
        this.pending.delete(msg.id);
      } else if (msg.id != null && msg.method) {
        // server→client request: must answer or the server stalls (watcher/config).
        const result = msg.method === 'workspace/configuration' ? (msg.params?.items ?? []).map(() => ({})) : null;
        this.write({ jsonrpc: '2.0', id: msg.id, result });
      }
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
    this.write({ jsonrpc: '2.0', id, method, params });
    return new Promise((res) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) res(null); }, REQ_TIMEOUT_MS);
      this.pending.set(id, (r) => { clearTimeout(t); res(r); });
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
    const text = readFileSync(file, 'utf8');
    const version = (this.opened.get(uri) ?? 0) + 1;
    this.opened.set(uri, version);
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
    return arr.map((l: any) => ({ uri: l.uri ?? l.targetUri, line: (l.range ?? l.targetRange)?.start?.line ?? 0 })).filter((x: any) => x.uri);
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

// ── symbol → position (find a whole-word occurrence of `name` in the file) ──
function findPosition(file: string, name?: string, line?: number, character?: number): { line: number; character: number } | null {
  if (line != null && character != null) return { line, character };
  if (!name) return null;
  const lines = readFileSync(file, 'utf8').split('\n');
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].search(re);
    if (c >= 0) return { line: i, character: c };
  }
  return null;
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
// the LSP. Validity is gated by a project epoch (max source mtime): any change bumps
// it and drops the stale answers, which then lazily recompute against the warm LSP. ──
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

const epochCache = new Map<string, { at: number; epoch: number }>();
/** Project epoch = max source-file mtime; sampled ≤ once / EPOCH_TTL so repeat queries
 * are O(1). The walk + stats run CONCURRENTLY: on a high-latency FS (e.g. /mnt over WSL)
 * a serial scan of a 1000+ file tree took ~8s and dominated even cache hits; fanning the
 * readdir/stat out in parallel overlaps the syscall latency. (Also: .py was missing from
 * SRC_RE, so Python epochs were stuck at 0 — no change detection.) */
async function projectEpoch(root: string): Promise<number> {
  const c = epochCache.get(root);
  if (c && Date.now() - c.at < EPOCH_TTL_MS) return c.epoch;
  let max = 0;
  const walk = async (d: string): Promise<void> => {
    let ents;
    try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
    const tasks: Promise<unknown>[] = [];
    for (const e of ents) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) tasks.push(walk(p));
      else if (SRC_RE.test(e.name)) tasks.push(stat(p).then((s) => { if (s.mtimeMs > max) max = s.mtimeMs; }).catch(() => {}));
    }
    await Promise.all(tasks);
  };
  await walk(root);
  const epoch = Math.floor(max);
  epochCache.set(root, { at: Date.now(), epoch });
  return epoch;
}

type Cache = { epoch: number; entries: Record<string, unknown> };
const caches = new Map<string, Cache>();
const cacheFile = (root: string) => join(CACHE_DIR, `${sha16(root)}.json`);
function loadCache(root: string): Cache {
  let c = caches.get(root);
  if (c) return c;
  try { c = JSON.parse(readFileSync(cacheFile(root), 'utf8')) as Cache; } catch { c = { epoch: 0, entries: {} }; }
  caches.set(root, c);
  return c;
}
function persistCache(root: string): void {
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(cacheFile(root), JSON.stringify(caches.get(root))); } catch { /* best effort */ }
}

const lineCache = new Map<string, string[]>();
function sourceLine(file: string, line0: number): string {
  let ls = lineCache.get(file);
  if (!ls) { try { ls = readFileSync(file, 'utf8').split('\n'); } catch { ls = []; } lineCache.set(file, ls); }
  return (ls[line0] ?? '').trim().slice(0, 160);
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

/** One query path for all three tools: resolve a position, gate on the cache, else
 * ask the warm tsgo session (references / definition / implementation), format. */
async function query(tool: string, args: Record<string, any>): Promise<unknown> {
  if (!args.file) return { error: `${tool} needs \`file\` (and \`name\` or line/character).` };
  const file = isAbsolute(args.file) ? args.file : resolve(args.root ?? process.cwd(), args.file);
  if (!existsSync(file)) return { error: `file not found: ${file}` };
  const lang = langOf(file);
  if (!lang) return { error: `unsupported file type: ${file} (expected TS/JS or Python).` };
  const be = backend(lang);
  if (!be) return { error: lang === 'ts' ? 'tsgo not found — set TSGO_BIN or `npm install` in code-oracle/.' : 'ty not found — install ty or uvx, or set TY_CMD.' };
  const pos = findPosition(file, args.name, args.line, args.character);
  if (!pos) return { error: `could not locate symbol "${args.name}" in ${file}; pass line/character.` };

  const root = args.root ? resolve(args.root) : projectRoot(file, lang);
  const relFile = relative(root, file).replace(/\\/g, '/');
  const cacheKey = `${tool}:${relFile}#${args.name ?? `${pos.line}:${pos.character}`}`;

  // Cache gate: serve instantly (no LSP warmup) when the project hasn't changed.
  const epoch = await projectEpoch(root);
  const cache = loadCache(root);
  if (cache.epoch === epoch && cache.entries[cacheKey]) {
    return { ...(cache.entries[cacheKey] as object), cached: true };
  }

  const locs = await session(root, lang, be).locate(METHOD[tool], file, pos.line, pos.character);
  const seen = new Set<string>();
  const out: { file: string; line: number; preview: string }[] = [];
  for (const r of locs) {
    const f = fileURLToPath(r.uri);
    const dk = `${f}\t${r.line}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    out.push({ file: relative(root, f).replace(/\\/g, '/'), line: r.line + 1, preview: sourceLine(f, r.line) });
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
  persistCache(root);
  return result;
}

// ── MCP server (newline-delimited JSON-RPC over stdio, like code-map) ──
const INPUT = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Source file (absolute, or relative to root/cwd).' },
    name: { type: 'string', description: 'Symbol name (its first occurrence in the file is used).' },
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
  while (queue.length && scanned < 4000) {
    const dir = queue.shift()!;
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
  const shutdown = () => { for (const root of caches.keys()) persistCache(root); for (const s of sessions.values()) s.dispose(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

let isEntry = false;
try { isEntry = !!process.argv[1] && (await import('node:fs')).realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* imported */ }
if (isEntry) main();

/** Kill every warm LSP session — tests must call this or the live tsgo/ty child
 * keeps the process alive. */
export function disposeAll(): void {
  for (const s of sessions.values()) s.dispose();
  sessions.clear();
}

export { query, TOOLS };
