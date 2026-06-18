#!/usr/bin/env node
/**
 * ts-oracle MCP — type-aware call resolution over a warm tsgo (TypeScript-Go) LSP session.
 *
 * Sibling to code-map, not part of it: code-map routes to coordinates (instant, light,
 * drift-resistant); ts-oracle answers "who calls this" at CHECKER grade via LSP
 * `references` — including calls through interfaces / DI that code-map's structural
 * call graph cannot draw. The statefulness (a warm LSP session, project warmup, file
 * sync, preview churn) is contained HERE behind a stateless MCP tool surface, so
 * code-map stays clean and the backend is swappable (LSP today → @typescript/api at TS 7.1).
 *
 * One tool — `callers` — done end-to-end (a vertical slice): resolve a symbol to a
 * position, ask tsgo for its references, return the caller sites with previews.
 *
 * Needs the tsgo binary: `TSGO_BIN=/path/to/@typescript/native-preview/bin/tsgo.js`,
 * else it resolves the copy installed in this package.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTOCOL = '2025-06-18';
const WARMUP_MS = Number(process.env.TS_ORACLE_WARMUP_MS ?? 15000);
const REQ_TIMEOUT_MS = Number(process.env.TS_ORACLE_REQ_TIMEOUT_MS ?? 40000);

const HERE = dirname(fileURLToPath(import.meta.url));

function tsgoBin(): string | null {
  if (process.env.TSGO_BIN && existsSync(process.env.TSGO_BIN)) return process.env.TSGO_BIN;
  const local = join(HERE, 'node_modules/@typescript/native-preview/bin/tsgo.js');
  return existsSync(local) ? local : null;
}

/** Nearest ancestor dir containing tsconfig.json — the LSP project root for a file. */
function projectRoot(file: string): string {
  let dir = dirname(resolve(file));
  for (;;) {
    if (existsSync(join(dir, 'tsconfig.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(resolve(file));
    dir = parent;
  }
}

/** A warm tsgo LSP session: Content-Length framed JSON-RPC, server-request replies,
 * one-time project warmup, live file sync. */
class TsgoLsp {
  private proc: ChildProcess;
  private buf = Buffer.alloc(0);
  private pending = new Map<number, (r: unknown) => void>();
  private nextId = 1;
  private opened = new Map<string, number>(); // uri -> version
  private initDone: Promise<void>;
  private warmed = false;

  constructor(bin: string, root: string) {
    this.proc = spawn(process.execPath, [bin, '--lsp', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.stdout!.on('data', (d: Buffer) => this.onData(d));
    this.initDone = this.initialize(root);
  }

  private onData(d: Buffer): void {
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
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    return uri;
  }

  /** Caller sites of the symbol at (file, position) — LSP references, declaration excluded. */
  async references(file: string, line: number, character: number): Promise<{ uri: string; line: number }[]> {
    await this.initDone;
    const uri = this.syncFile(file);
    if (!this.warmed) {
      await new Promise((r) => setTimeout(r, WARMUP_MS)); // one-time project warmup; session stays warm after
      this.warmed = true;
    }
    const r = (await this.request('textDocument/references', {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: false },
    })) as { uri: string; range: { start: { line: number } } }[] | null;
    return (r ?? []).map((l) => ({ uri: l.uri, line: l.range.start.line }));
  }

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

// ── one warm session per project root (lazy — only spun up on a cache MISS) ──
const sessions = new Map<string, TsgoLsp>();
function session(root: string, bin: string): TsgoLsp {
  let s = sessions.get(root);
  if (!s) sessions.set(root, (s = new TsgoLsp(bin, root)));
  return s;
}

// ── persistent answer cache (the practical "snapshot"): the checker's RAM can't be
// serialized, but the ANSWERS can. Persisted per root, reloaded on start → after a
// restart, queries with no project change are served INSTANTLY, without even warming
// the LSP. Validity is gated by a project epoch (max source mtime): any change bumps
// it and drops the stale answers, which then lazily recompute against the warm LSP. ──
const CACHE_DIR = join(HERE, '.cache');
const sha16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.cache', 'coverage']);
const SRC_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const epochCache = new Map<string, { at: number; epoch: number }>();
/** Project epoch = max source-file mtime; sampled ≤ once / 2s so repeat queries are O(1). */
function projectEpoch(root: string): number {
  const c = epochCache.get(root);
  if (c && Date.now() - c.at < 2000) return c.epoch;
  let max = 0;
  const walk = (d: string) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (SRC_RE.test(e.name)) { try { const m = statSync(p).mtimeMs; if (m > max) max = m; } catch { /* gone */ } }
    }
  };
  walk(root);
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

async function callers(args: Record<string, any>): Promise<unknown> {
  const bin = tsgoBin();
  if (!bin) return { error: 'tsgo not found. Set TSGO_BIN to @typescript/native-preview/bin/tsgo.js, or `npm install` in ts-oracle/.' };
  if (!args.file) return { error: 'callers needs `file` (and `name` or line/character).' };
  const file = isAbsolute(args.file) ? args.file : resolve(args.root ?? process.cwd(), args.file);
  if (!existsSync(file)) return { error: `file not found: ${file}` };
  const pos = findPosition(file, args.name, args.line, args.character);
  if (!pos) return { error: `could not locate symbol "${args.name}" in ${file}; pass line/character.` };

  const root = args.root ? resolve(args.root) : projectRoot(file);
  const relFile = relative(root, file).replace(/\\/g, '/');
  const cacheKey = `${relFile}#${args.name ?? `${pos.line}:${pos.character}`}`;

  // Cache gate: serve instantly (no LSP warmup) when the project hasn't changed.
  const epoch = projectEpoch(root);
  const cache = loadCache(root);
  if (cache.epoch === epoch && cache.entries[cacheKey]) {
    return { ...(cache.entries[cacheKey] as object), cached: true };
  }

  const refs = await session(root, bin).references(file, pos.line, pos.character);
  const seen = new Set<string>();
  const out: { file: string; line: number; preview: string }[] = [];
  for (const r of refs) {
    const f = fileURLToPath(r.uri);
    const dk = `${f}\t${r.line}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    out.push({ file: relative(root, f).replace(/\\/g, '/'), line: r.line + 1, preview: sourceLine(f, r.line) });
  }
  out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const result = {
    symbol: { file: relFile, name: args.name ?? null, position: pos },
    root,
    callers: out,
    count: out.length,
    cached: false,
    note: 'Type-aware callers via tsgo LSP references (checker grade, resolves through interfaces/DI standard cases). Truly dynamic dispatch (Proxy, obj[k](), token-only DI) is still invisible to the checker — a residual the agent must resolve from raw.',
  };
  if (cache.epoch !== epoch) { cache.epoch = epoch; cache.entries = {}; } // project changed → drop stale, re-seed
  cache.entries[cacheKey] = result;
  persistCache(root);
  return result;
}

// ── MCP server (newline-delimited JSON-RPC over stdio, like code-map) ──
const TOOLS = [
  {
    name: 'callers',
    description:
      'Type-aware callers of a symbol — "who calls this", at TypeScript-checker grade via a warm tsgo LSP session. Resolves calls through interfaces and standard DI (declaration types) that a structural call graph cannot. Pass `file` (abs or relative to `root`) and `name` (the symbol; its first occurrence is used) or explicit `line`/`character` (0-based). Optional `root` (project dir; else the nearest tsconfig.json). First call warms the project (~seconds); the session stays warm after.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Source file (absolute, or relative to root/cwd).' },
        name: { type: 'string', description: 'Symbol name to find callers of (its first occurrence in the file).' },
        line: { type: 'number', description: 'Optional 0-based line of the symbol (use with character).' },
        character: { type: 'number', description: 'Optional 0-based column of the symbol.' },
        root: { type: 'string', description: 'Optional project root; default = nearest ancestor tsconfig.json.' },
      },
      required: ['file'],
    },
  },
];

function send(msg: unknown): void { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(req: any): Promise<void> {
  const { id, method, params } = req;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'ts-oracle', version: '0.1.0' } } });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        if (params?.name !== 'callers') throw new Error(`unknown tool: ${params?.name}`);
        const result = await callers(params.arguments ?? {});
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

function main(): void {
  if (!tsgoBin()) process.stderr.write('ts-oracle: tsgo not found — set TSGO_BIN or `npm install` in ts-oracle/. Tools will error until then.\n');
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

export { callers, TOOLS };
