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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile as readFileAsync, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROTOCOL = '2025-06-18';
const RESULT_SCHEMA = 2;
// Readiness by quiescence: the project is "loaded" once tsgo stops emitting
// log/progress messages for QUIET_MS — far better than a fixed sleep. Bounded by
// MIN_MS (don't trust a momentary pause) and MAX_MS (never hang).
const QUIET_MS = Number(process.env.TS_ORACLE_QUIET_MS ?? 1500);
const MIN_MS = Number(process.env.TS_ORACLE_MIN_MS ?? 1500);
const MAX_MS = Number(process.env.TS_ORACLE_WARMUP_MS ?? 30000);
const REQ_TIMEOUT_MS = Number(process.env.TS_ORACLE_REQ_TIMEOUT_MS ?? 40000);

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const SESSION_IDLE_MS = positiveIntegerEnv('CODE_ORACLE_SESSION_IDLE_MS', 10 * 60_000);
const MAX_SESSIONS = positiveIntegerEnv('CODE_ORACLE_MAX_SESSIONS', 2);

const HERE = dirname(fileURLToPath(import.meta.url));
let stopping = false;

type Lang = 'ts' | 'py';
type ProjectFileKind = Lang | `${Lang}-config`;
type ProjectFile = { signature: string; kind: ProjectFileKind };
type ProjectSnapshot = { epoch: string; files: Map<string, ProjectFile> };
type UnknownRecord = Record<string, unknown>;
type RpcId = string | number | null;

function isObjectRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): UnknownRecord | null {
  if (!isObjectRecord(value)) return null;
  const nested = value[key];
  return isObjectRecord(nested) ? nested : null;
}

function finiteNumberAt(value: UnknownRecord | null, key: string, fallback = 0): number {
  const candidate = value?.[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
}

export interface OracleCoverage {
  kind: 'checker-resolved' | 'checker-confirmed' | 'sound-overapproximation' | 'lower-bound';
  scope: 'project' | 'checker-visible-project' | 'intra-file';
  residuals: string[];
}

export interface StaticInstantiationHint {
  name: string;
  kind: 'constructor' | 'di-use-class';
  file: string;
  line: number;
  preview: string;
}

const DYNAMIC_RESIDUALS = ['proxy-dispatch', 'computed-property-call', 'token-only-di'];

export function coverageFor(tool: string, lang: Lang): OracleCoverage {
  if (lang === 'py' && (tool === 'callers' || tool === 'implementations')) {
    return {
      kind: 'lower-bound',
      scope: 'intra-file',
      residuals: ['cross-file-references', ...DYNAMIC_RESIDUALS],
    };
  }
  if (tool === 'implementations') {
    return {
      kind: 'sound-overapproximation',
      scope: 'checker-visible-project',
      residuals: ['runtime-selection', 'dynamic-loading', ...DYNAMIC_RESIDUALS],
    };
  }
  return {
    kind: tool === 'definition' ? 'checker-resolved' : 'checker-confirmed',
    scope: 'project',
    residuals: [...DYNAMIC_RESIDUALS],
  };
}

function relevantProjectFiles(projectFiles: Map<string, ProjectFile>, lang: Lang): Map<string, ProjectFile> {
  const configKind = `${lang}-config` as const;
  const relevant = new Map<string, ProjectFile>();
  for (const [path, file] of projectFiles) {
    if (file.kind === lang || file.kind === configKind) relevant.set(path, file);
  }
  return relevant;
}

function langOf(file: string): Lang | null {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)) return 'ts';
  if (/\.(py|pyi)$/.test(file)) return 'py';
  return null;
}

/** Build the tsgo spawn command for either a native executable or a Node
 * launcher. New native-preview releases use an extensionless `bin/tsgo`
 * Node wrapper; older releases used `bin/tsgo.js`. */
export function tsgoSpawnCommand(bin: string): { cmd: string; args: string[] } {
  let nodeLauncher = /\.[cm]?js$/i.test(bin);
  if (!nodeLauncher) {
    let fd: number | undefined;
    try {
      fd = openSync(bin, 'r');
      const prefix = Buffer.alloc(64);
      const bytes = readSync(fd, prefix, 0, prefix.length, 0);
      nodeLauncher = /^#![^\r\n]*\bnode(?:\s|$)/i.test(prefix.subarray(0, bytes).toString('utf8'));
    } catch {
      nodeLauncher = false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const args = ['--lsp', '--stdio'];
  return nodeLauncher ? { cmd: process.execPath, args: [bin, ...args] } : { cmd: bin, args };
}

/** Resolve a package-managed tsgo from a trusted Node resolution anchor. This
 * covers nested installs, workspace hoisting, and pnpm layouts. The platform
 * package check rejects a wrapper left by another OS before it can cause LSP
 * timeouts. */
export function resolveTsgoPackageBin(
  anchor: string | URL,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  try {
    const from = createRequire(anchor);
    from.resolve('@typescript/native-preview/package.json');
    const platformRoot = dirname(from.resolve(`@typescript/native-preview-${platform}-${arch}/package.json`));
    const executable = join(platformRoot, 'lib', platform === 'win32' ? 'tsgo.exe' : 'tsgo');
    return existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

/** The LSP backend for a language: how to spawn it + the LSP `languageId`. tsgo
 * for TS/JS, ty for Python — both speak the same LSP, so everything downstream
 * (framing, readiness, references/definition/implementation, cache) is shared. */
function backend(lang: Lang): { cmd: string; args: string[]; languageId: string } | null {
  if (lang === 'ts') {
    if (process.env.TSGO_BIN && existsSync(process.env.TSGO_BIN)) {
      const override = process.env.TSGO_BIN;
      return { ...tsgoSpawnCommand(override), languageId: 'typescript' };
    }
    const platform = join(HERE, 'node_modules/@typescript', `native-preview-${process.platform}-${process.arch}`);
    const native = join(platform, 'lib', process.platform === 'win32' ? 'tsgo.exe' : 'tsgo');
    // npm can leave a wrapper plus another OS's optional package in a shared
    // checkout. Treat that as unavailable now, not as two 40-second LSP timeouts.
    if (existsSync(native)) return { ...tsgoSpawnCommand(native), languageId: 'typescript' };
    // Resolve only from the server module's install tree. Falling back to the
    // queried workspace would execute an untrusted dependency with MCP rights.
    const resolved = resolveTsgoPackageBin(import.meta.url);
    return resolved ? { ...tsgoSpawnCommand(resolved), languageId: 'typescript' } : null;
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
  private projectFiles: Map<string, ProjectFile>;
  private projectEpoch: Epoch;

  constructor(spec: { cmd: string; args: string[]; languageId: string }, root: string, snapshot: ProjectSnapshot, lang: Lang) {
    this.languageId = spec.languageId;
    this.projectFiles = relevantProjectFiles(snapshot.files, lang);
    this.projectEpoch = snapshot.epoch;
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

  private terminateBackend(): void {
    try { this.proc.stdin?.destroy(); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }

  private onData(d: Buffer): void {
    this.lastMsgAt = Date.now(); // bump on any server activity (logs/progress) — drives quiescence readiness
    for (const body of this.decoder.push(d)) this.handleMessage(body);
  }

  private handleMessage(body: Buffer): void {
    let parsed: unknown;
    try { parsed = JSON.parse(body.toString()); } catch { return; }
    if (!isObjectRecord(parsed)) return;
    const id = parsed.id;
    if (typeof id === 'number' && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(parsed.result);
    } else if ((typeof id === 'string' || typeof id === 'number') && typeof parsed.method === 'string') {
      // server→client request: must answer or the server stalls (watcher/config).
      const params = isObjectRecord(parsed.params) ? parsed.params : null;
      const items = params && Array.isArray(params.items) ? params.items : [];
      const result = parsed.method === 'workspace/configuration' ? items.map(() => ({})) : null;
      this.write({ jsonrpc: '2.0', id, result });
    }
  }

  private write(msg: unknown): void {
    if (this.failure) throw this.failure;
    if (!this.proc.stdin?.writable) throw new Error('LSP backend stdin is closed.');
    const s = JSON.stringify(msg);
    this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
  }
  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }
  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        const error = new Error(`LSP request timed out after ${REQ_TIMEOUT_MS}ms: ${method}`);
        this.fail(error);
        this.terminateBackend();
      }, REQ_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error
          ? error
          : new Error('Writing the LSP request failed.', { cause: error }));
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

  /** Bring files changed outside the queried document into the warm project.
   * Added/modified sources can be overlaid cheaply. Deletions and project-config
   * changes require a fresh language-server project graph, so the caller restarts. */
  async reconcileProject(snapshot: ProjectSnapshot, lang: Lang): Promise<boolean> {
    this.throwIfFailed();
    if (this.projectEpoch === snapshot.epoch) return true;
    const projectFiles = snapshot.files;
    const configKind = `${lang}-config` as const;
    const changed: string[] = [];
    let relevantCount = 0;
    for (const [path, current] of projectFiles) {
      if (current.kind !== lang && current.kind !== configKind) continue;
      relevantCount++;
      const prior = this.projectFiles.get(path);
      if (current.kind === configKind && (!prior || prior.signature !== current.signature)) return false;
      if (current.kind === lang && prior?.signature !== current.signature) changed.push(path);
    }
    // Deletions require a project restart. Check the old, already language-filtered
    // map directly; unchanged projects avoid allocating a replacement Map entirely.
    for (const path of this.projectFiles.keys()) if (!projectFiles.has(path)) return false;
    if (changed.length === 0 && relevantCount === this.projectFiles.size) {
      this.projectEpoch = snapshot.epoch;
      return true;
    }

    if (changed.length) {
      await this.initDone;
      for (const path of changed) this.syncFile(path);
      this.warmed = false;
      this.lastMsgAt = Date.now();
    }
    this.projectFiles = relevantProjectFiles(projectFiles, lang);
    this.projectEpoch = snapshot.epoch;
    return true;
  }

  /** Wait until the project is loaded — tsgo has gone quiet for QUIET_MS (bounded). */
  private async waitReady(): Promise<void> {
    if (this.warmed) return;
    const start = Date.now();
    for (;;) {
      this.throwIfFailed();
      const elapsed = Date.now() - start;
      if ((Date.now() - this.lastMsgAt > QUIET_MS && elapsed > MIN_MS) || elapsed > MAX_MS) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    this.throwIfFailed();
    this.warmed = true;
  }

  /** Run an LSP location query (`references` / `definition` / `implementation`) at a
   * position; return target locations. Handles both Location and LocationLink shapes. */
  async locate(method: string, file: string, line: number, character: number): Promise<{ uri: string; line: number; character: number }[]> {
    await this.initDone;
    const uri = this.syncFile(file);
    await this.waitReady();
    const params: Record<string, unknown> = { textDocument: { uri }, position: { line, character } };
    if (method === 'textDocument/references') params.context = { includeDeclaration: false };
    const response = await this.request(method, params);
    const values = Array.isArray(response) ? response : isObjectRecord(response) ? [response] : [];
    const locations: { uri: string; line: number; character: number }[] = [];
    for (const value of values) {
      if (!isObjectRecord(value)) continue;
      const target = typeof value.uri === 'string' ? value.uri : typeof value.targetUri === 'string' ? value.targetUri : null;
      const range = [value.range, value.targetSelectionRange, value.targetRange].find(isObjectRecord) ?? null;
      const start = recordAt(range, 'start');
      if (target) locations.push({ uri: target, line: finiteNumberAt(start, 'line'), character: finiteNumberAt(start, 'character') });
    }
    return locations;
  }

  /** Flatten the LSP documentSymbol tree while preserving each symbol's
   * immediate container. Selection ranges anchor on real declarations rather
   * than comments, strings, or imports. */
  async documentSymbols(file: string, syncDocument = true): Promise<OracleSym[]> {
    await this.initDone;
    // Result files are already part of the checker's project graph. Avoid
    // didOpen-ing every implementation file merely to rank it: open documents
    // stay resident in the LSP and a wide hierarchy could otherwise grow memory
    // with its fan-out. Name resolution still syncs the actively queried file.
    const uri = syncDocument ? this.syncFile(file) : pathToFileURL(file).href;
    await this.waitReady();
    const response = await this.request('textDocument/documentSymbol', { textDocument: { uri } });
    if (!Array.isArray(response)) return [];
    let fileLines: string[] | null = null;
    const lineText = (ln: number): string => {
      if (!fileLines) { try { fileLines = readFileSync(file, 'utf8').split('\n'); } catch { fileLines = []; } }
      return fileLines[ln] ?? '';
    };
    const out: OracleSym[] = [];
    const walk = (nodes: unknown[], container: string | null): void => {
      for (const value of nodes) {
        if (!isObjectRecord(value)) continue;
        const name = typeof value.name === 'string' && value.name ? value.name : null;
        if (name) {
          const selectionStart = recordAt(recordAt(value, 'selectionRange'), 'start');
          if (selectionStart) {
            out.push({
              name,
              container,
              line: finiteNumberAt(selectionStart, 'line'),
              character: finiteNumberAt(selectionStart, 'character'),
              kind: finiteNumberAt(value, 'kind'),
            });
          } else {
            const locationStart = recordAt(recordAt(recordAt(value, 'location'), 'range'), 'start');
            if (locationStart) { // SymbolInformation: refine column to the identifier
              const line = finiteNumberAt(locationStart, 'line');
              const column = lineText(line).indexOf(name);
              out.push({
                name,
                container: typeof value.containerName === 'string' ? value.containerName : container,
                line,
                character: column >= 0 ? column : finiteNumberAt(locationStart, 'character'),
                kind: finiteNumberAt(value, 'kind'),
              });
            }
          }
        }
        if (Array.isArray(value.children)) walk(value.children, name ?? container);
      }
    };
    walk(response, null);
    return out;
  }

  /** Resolve one declared name; ambiguous containers are surfaced to the caller. */
  async documentSymbolPosition(file: string, name: string): Promise<{ line: number; character: number } | { ambiguous: OracleSym[] } | null> {
    return resolveNamePosition(await this.documentSymbols(file), name);
  }

  /** Eagerly load the project (open a seed file + wait for quiescence) so the first
   * real query doesn't pay the cold warmup. Fire-and-forget at startup. */
  async prewarm(seedFile: string): Promise<void> {
    await this.initDone;
    this.syncFile(seedFile);
    await this.waitReady();
  }

  get ready(): boolean { return this.warmed; }

  dispose(): void {
    this.fail(new Error('LSP session disposed.'));
    this.terminateBackend();
  }
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

function implementationOwner(symbols: OracleSym[], line: number, character: number, queriedName: string | undefined): string | null {
  const simpleName = queriedName ? queriedName.slice(queriedName.lastIndexOf('.') + 1) : null;
  let best: { owner: string; score: number } | null = null;
  for (const symbol of symbols) {
    if (symbol.line !== line) continue;
    const owner = symbol.container ?? (symbol.kind === 5 ? symbol.name : null);
    if (!owner) continue;
    const score = Math.abs(symbol.character - character) + (simpleName && symbol.name !== simpleName ? 1000 : 0);
    if (!best || score < best.score) best = { owner, score };
  }
  return best?.owner ?? null;
}

async function documentSymbolsByFile(session: LspSession, files: string[]): Promise<Map<string, OracleSym[]>> {
  const symbols = new Map<string, OracleSym[]>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const file = files[cursor++];
      symbols.set(file, await session.documentSymbols(file, false));
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
  return symbols;
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

// ── bounded warm-session pool. Sessions are lazy, LRU-capped, and reaped after
// an idle timeout. A per-root lease serializes reconcile/query/restart so two MCP
// requests cannot replace the same LSP underneath one another. ──
type SessionEntry = {
  session: LspSession;
  inUse: number;
  idleTimer: NodeJS.Timeout | null;
};
type SessionLease = { session: LspSession; release: () => void };

const sessions = new Map<string, SessionEntry>();
const sessionQueues = new Map<string, Promise<void>>();

function disposeSession(key: string, entry: SessionEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  if (sessions.get(key) === entry) sessions.delete(key);
  entry.session.dispose();
}

function armIdleTimer(key: string, entry: SessionEntry): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  if (entry.inUse > 0 || sessions.get(key) !== entry) return;
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null;
    if (entry.inUse === 0 && sessions.get(key) === entry) disposeSession(key, entry);
  }, SESSION_IDLE_MS);
  entry.idleTimer.unref();
}

function trimSessions(): void {
  // Map order is LRU order. One pass removes as many idle victims as needed;
  // repeatedly spreading the whole Map made overload cleanup O(sessions²).
  for (const [key, entry] of sessions) {
    if (sessions.size <= MAX_SESSIONS) return;
    if (entry.inUse === 0) disposeSession(key, entry);
  }
}

async function acquireSession(
  root: string,
  lang: Lang,
  spec: { cmd: string; args: string[]; languageId: string },
  snapshot: ProjectSnapshot,
): Promise<SessionLease> {
  const key = `${lang}::${root}`;
  const previous = sessionQueues.get(key) ?? Promise.resolve();
  let unlock!: () => void;
  const gate = new Promise<void>((resolveGate) => { unlock = resolveGate; });
  const queued = previous.then(() => gate);
  sessionQueues.set(key, queued);
  await previous;

  const finishQueue = (): void => {
    unlock();
    if (sessionQueues.get(key) === queued) sessionQueues.delete(key);
  };

  let entry: SessionEntry | undefined;
  try {
    if (stopping) throw new Error('code-oracle is shutting down.');
    entry = sessions.get(key);
    if (entry?.idleTimer) clearTimeout(entry.idleTimer);
    if (entry) entry.idleTimer = null;
    if (entry) {
      const candidate = entry;
      let reusable = false;
      try {
        reusable = await candidate.session.reconcileProject(snapshot, lang);
      } catch {
        // A failed checker is poisoned. Retire it here instead of leaving an
        // entry with its idle timer cleared and no future path to collection.
      }
      if (!reusable) {
        disposeSession(key, candidate);
        entry = undefined;
      }
    }
    if (stopping) throw new Error('code-oracle is shutting down.');
    if (!entry) {
      entry = { session: new LspSession(spec, root, snapshot, lang), inUse: 0, idleTimer: null };
      sessions.set(key, entry);
    } else {
      sessions.delete(key);
      sessions.set(key, entry); // Map insertion order is the LRU order
    }
    entry.inUse++;
    trimSessions();

    const acquired = entry;
    let released = false;
    return {
      session: acquired.session,
      release: () => {
        if (released) return;
        released = true;
        acquired.inUse--;
        if (sessions.get(key) === acquired) armIdleTimer(key, acquired);
        trimSessions();
        finishQueue();
      },
    };
  } catch (error) {
    finishQueue();
    throw error;
  }
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
// Exact by default: a positive opt-in TTL can coalesce burst queries, but it also
// explicitly permits that many milliseconds of filesystem staleness.
const EPOCH_TTL_MS = Number(process.env.CODE_ORACLE_EPOCH_TTL_MS ?? 0);

type Epoch = string;
const epochCache = new Map<string, { at: number; snapshot: ProjectSnapshot }>();
const epochFlights = new Map<string, Promise<ProjectSnapshot>>();

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** Fresh by default; an opt-in EPOCH_TTL makes burst repeats O(1). A bounded
 * breadth-first directory walk plus 64 stat workers stays O(files) without the old
 * unbounded Promise tree / file-descriptor burst. The commutative fingerprint
 * includes path, size, mtime, ctime and inode, so non-max edits and deletions cannot
 * hide behind an unchanged "maximum mtime". */
export async function projectSnapshot(root: string): Promise<ProjectSnapshot> {
  if (EPOCH_TTL_MS > 0) {
    const cached = epochCache.get(root);
    if (cached && Date.now() - cached.at < EPOCH_TTL_MS) return cached.snapshot;
  }
  const active = epochFlights.get(root);
  if (active) return active;

  // No cache TTL is added: only callers overlapping the same physical scan share
  // that scan. With TTL=0 the completed O(files) Map is not retained at all.
  const flight = scanProject(root).then((snapshot) => {
    if (!stopping && EPOCH_TTL_MS > 0) epochCache.set(root, { at: Date.now(), snapshot });
    return snapshot;
  }).finally(() => {
    if (epochFlights.get(root) === flight) epochFlights.delete(root);
  });
  epochFlights.set(root, flight);
  return flight;
}

/** Uncached O(files) fingerprint pass, exported for deterministic regression tests. */
export async function scanProjectEpoch(root: string): Promise<Epoch> {
  return (await scanProject(root)).epoch;
}

function projectFileKind(path: string): ProjectFileKind | null {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  if (/^(?:tsconfig(?:\.[^.]+)?|jsconfig(?:\.[^.]+)?)\.json$/.test(name) || name === 'package.json') return 'ts-config';
  if (name === 'pyproject.toml' || name === 'setup.cfg') return 'py-config';
  return langOf(path);
}

async function scanProject(root: string): Promise<ProjectSnapshot> {
  const dirs = [root];
  const projectFiles: { path: string; kind: ProjectFileKind }[] = [];
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
        else {
          const kind = projectFileKind(path);
          if (kind) projectFiles.push({ path, kind });
        }
      }
    }
  }

  let cursor = 0;
  let count = 0;
  let xor = 0;
  let sum = 0;
  const files = new Map<string, ProjectFile>();
  const worker = async (): Promise<void> => {
    while (cursor < projectFiles.length) {
      const { path, kind } = projectFiles[cursor++];
      try {
        const info = await stat(path);
        // The absolute Map key already identifies the file. Keep only stat data in
        // the retained signature; include the relative path solely in the epoch hash.
        const signature = `${info.size}\0${Math.trunc(info.mtimeMs * 1000)}\0${Math.trunc(info.ctimeMs * 1000)}\0${info.ino}`;
        const hash = fnv1a32(`${relative(root, path)}\0${signature}`);
        files.set(path, { signature, kind });
        xor = (xor ^ hash) >>> 0;
        sum = (sum + hash) >>> 0;
        count++;
      } catch { /* file disappeared during the scan */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(64, projectFiles.length) }, worker));
  return { epoch: `${count.toString(36)}:${xor.toString(36)}:${sum.toString(36)}`, files };
}

type LexState = 'code' | 'line-comment' | 'block-comment' | 'single-quote' | 'double-quote' | 'template';

type StaticHintVisitor = (
  name: string,
  kind: StaticInstantiationHint['kind'],
  line: number,
  previewStart: number,
  previewEnd: number,
) => void;

function visitStaticInstantiationHints(text: string, visit: StaticHintVisitor): void {
  const qualifiedName = '[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*';
  const pattern = new RegExp(`\\b(?:new\\s+(${qualifiedName})|useClass\\s*:\\s*(${qualifiedName}))`, 'g');
  let state: LexState = 'code';
  let cursor = 0;
  let line = 1;
  let lineStart = 0;
  let lineEnd = -1;
  let linePreviewStart = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    while (cursor < match.index) {
      const char = text[cursor];
      const next = text[cursor + 1];
      if (state === 'code') {
        if (char === '/' && next === '/') { state = 'line-comment'; cursor += 2; continue; }
        if (char === '/' && next === '*') { state = 'block-comment'; cursor += 2; continue; }
        if (char === "'") state = 'single-quote';
        else if (char === '"') state = 'double-quote';
        else if (char === '`') state = 'template';
      } else if (state === 'line-comment') {
        if (char === '\n') state = 'code';
      } else if (state === 'block-comment') {
        if (char === '*' && next === '/') { state = 'code'; cursor += 2; continue; }
      } else {
        if (char === '\\') {
          if (next === '\n') {
            line++;
            lineStart = cursor + 2;
            lineEnd = -1;
            linePreviewStart = lineStart;
          }
          cursor += 2;
          continue;
        }
        if ((state === 'single-quote' && char === "'")
          || (state === 'double-quote' && char === '"')
          || (state === 'template' && char === '`')) state = 'code';
      }
      if (char === '\n') {
        line++;
        lineStart = cursor + 1;
        lineEnd = -1;
        linePreviewStart = lineStart;
      }
      cursor++;
    }
    if (state !== 'code') continue;
    const qualified = (match[1] ?? match[2]).replace(/\s/g, '');
    if (lineEnd < match.index) {
      const nextNewline = text.indexOf('\n', match.index);
      lineEnd = nextNewline < 0 ? text.length : nextNewline;
      linePreviewStart = lineStart;
      while (linePreviewStart < lineEnd) {
        const code = text.charCodeAt(linePreviewStart);
        if (code !== 9 && code !== 13 && code !== 32) break;
        linePreviewStart++;
      }
    }
    visit(
      qualified.slice(qualified.lastIndexOf('.') + 1),
      match[1] ? 'constructor' : 'di-use-class',
      line,
      linePreviewStart,
      Math.min(lineEnd, linePreviewStart + 160),
    );
  }
}

/** Cheap, conservative source hints for implementation ranking. These are not
 * runtime observations: dead code and same-name classes can still produce a
 * hint, so callers must never use them to remove possible implementations. */
export function scanStaticInstantiationHints(text: string, file: string): StaticInstantiationHint[] {
  const hints: StaticInstantiationHint[] = [];
  visitStaticInstantiationHints(text, (name, kind, line, previewStart, previewEnd) => {
    hints.push({
      name,
      kind,
      file,
      line,
      preview: text.slice(previewStart, previewEnd).trimEnd(),
    });
  });
  return hints;
}

type InstantiationIndex = Map<string, StaticInstantiationHint[]>;
const INSTANTIATION_CACHE_MAX = 2;
const STATIC_HINTS_PER_NAME = 3;
// Bounds simultaneously resident source buffers, not files scanned or results.
const INSTANTIATION_SCAN_WORKERS = 8;
const instantiationCache = new Map<string, { epoch: Epoch; index: InstantiationIndex }>();
const instantiationFlights = new Map<string, Promise<InstantiationIndex>>();

async function scanInstantiationIndex(root: string, snapshot: ProjectSnapshot): Promise<InstantiationIndex> {
  const files = [...snapshot.files].filter(([, info]) => info.kind === 'ts').map(([path]) => path);
  const index: InstantiationIndex = new Map();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const path = files[cursor++];
      let text: string;
      try { text = await readFileAsync(path, 'utf8'); } catch { continue; }
      const rel = relative(root, path).replace(/\\/g, '/');
      visitStaticInstantiationHints(text, (name, kind, line, previewStart, previewEnd) => {
        const signals = index.get(name);
        if (signals && signals.length >= STATIC_HINTS_PER_NAME) return;
        const hint = { name, kind, file: rel, line, preview: text.slice(previewStart, previewEnd).trimEnd() };
        if (!signals) index.set(name, [hint]);
        else signals.push(hint);
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(INSTANTIATION_SCAN_WORKERS, files.length) }, worker));
  return index;
}

function instantiationIndexFor(root: string, snapshot: ProjectSnapshot): Promise<InstantiationIndex> {
  const cached = instantiationCache.get(root);
  if (cached?.epoch === snapshot.epoch) {
    instantiationCache.delete(root);
    instantiationCache.set(root, cached);
    return Promise.resolve(cached.index);
  }
  const flightKey = `${root}\0${snapshot.epoch}`;
  const active = instantiationFlights.get(flightKey);
  if (active) return active;
  const flight = scanInstantiationIndex(root, snapshot).then((index) => {
    if (!stopping) {
      instantiationCache.delete(root);
      instantiationCache.set(root, { epoch: snapshot.epoch, index });
      if (instantiationCache.size > INSTANTIATION_CACHE_MAX) {
        const oldest = instantiationCache.keys().next().value as string | undefined;
        if (oldest !== undefined) instantiationCache.delete(oldest);
      }
    }
    return index;
  }).finally(() => {
    if (instantiationFlights.get(flightKey) === flight) instantiationFlights.delete(flightKey);
  });
  instantiationFlights.set(flightKey, flight);
  return flight;
}

type Cache = { schema: number; epoch: Epoch; entries: Record<string, unknown> };
type CacheDelta = { schema: number; epoch: Epoch; key: string; value: unknown };
const caches = new Map<string, Cache>();
const cacheFile = (root: string) => join(CACHE_DIR, `${sha16(root)}.json`);
const cacheLogFile = (root: string) => join(CACHE_DIR, `${sha16(root)}.jsonl`);
const emptyCache = (): Cache => ({ schema: RESULT_SCHEMA, epoch: '', entries: {} });
function loadCache(root: string): Cache {
  let c = caches.get(root);
  if (c) return c;
  try {
    const parsed = JSON.parse(readFileSync(cacheFile(root), 'utf8')) as Partial<Cache> | null;
    c = parsed?.schema === RESULT_SCHEMA
      && typeof parsed.epoch === 'string'
      && parsed.entries !== null
      && typeof parsed.entries === 'object'
      && !Array.isArray(parsed.entries)
      ? parsed as Cache
      : emptyCache();
  } catch { c = emptyCache(); }
  try {
    const log = readFileSync(cacheLogFile(root), 'utf8');
    let start = 0;
    while (start < log.length) {
      let end = log.indexOf('\n', start);
      if (end === -1) end = log.length;
      const line = log.slice(start, end).trim();
      start = end + 1;
      if (!line) continue;
      try {
        const delta = JSON.parse(line) as CacheDelta;
        if (delta.schema === RESULT_SCHEMA && delta.epoch === c.epoch && typeof delta.key === 'string') c.entries[delta.key] = delta.value;
      } catch { /* an interrupted final append is safe to ignore */ }
    }
  } catch { /* no delta log yet */ }
  caches.set(root, c);
  return c;
}
type DirtyCache = { reset: boolean; keys: Set<string> };
function persistCache(root: string, dirty: DirtyCache): void {
  const cache = caches.get(root);
  if (!cache) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    if (dirty.reset) {
      // One full snapshot per project epoch. Older log records carry their epoch,
      // so a crash between these two operations can only replay matching data.
      writeFileSync(cacheFile(root), JSON.stringify(cache));
      try { unlinkSync(cacheLogFile(root)); } catch { /* no prior log */ }
      return;
    }
    const records: string[] = [];
    for (const key of dirty.keys) {
      if (Object.hasOwn(cache.entries, key)) records.push(JSON.stringify({ schema: RESULT_SCHEMA, epoch: cache.epoch, key, value: cache.entries[key] } satisfies CacheDelta));
    }
    if (records.length) appendFileSync(cacheLogFile(root), `${records.join('\n')}\n`);
  } catch { /* best effort */ }
}

const dirtyCaches = new Map<string, DirtyCache>();
let persistTimer: NodeJS.Timeout | null = null;
function flushCaches(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  for (const [root, dirty] of dirtyCaches) persistCache(root, dirty);
  dirtyCaches.clear();
}
function schedulePersist(root: string, key: string, reset: boolean): void {
  let dirty = dirtyCaches.get(root);
  if (!dirty) {
    dirty = { reset, keys: new Set() };
    dirtyCaches.set(root, dirty);
  } else if (reset) {
    dirty.reset = true;
    dirty.keys.clear();
  }
  if (!dirty.reset) dirty.keys.add(key);
  if (persistTimer) return;
  // Coalesce a burst of checker queries. Same-epoch answers append only their
  // delta, so Q distinct queries serialize O(total answer bytes), not O(Q²).
  persistTimer = setTimeout(flushCaches, 5000);
  persistTimer.unref();
}

const LINE_CACHE_MAX = 256;
type SourceIndex = { token: string; text: string; starts: number[] };
const lineCache = new Map<string, SourceIndex>();
function sourceLine(file: string, line0: number, token: string): string {
  let cached = lineCache.get(file);
  if (!cached || cached.token !== token) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { /* unreadable preview */ }
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    cached = { token, text, starts };
    lineCache.delete(file);
    lineCache.set(file, cached);
    if (lineCache.size > LINE_CACHE_MAX) lineCache.delete(lineCache.keys().next().value!);
  }
  const start = cached.starts[line0];
  if (start === undefined) return '';
  const end = cached.starts[line0 + 1] ?? cached.text.length;
  return cached.text.slice(start, end).trim().slice(0, 160);
}

const METHOD = {
  callers: 'textDocument/references',
  definition: 'textDocument/definition',
  implementations: 'textDocument/implementation',
} as const;
type ToolName = keyof typeof METHOD;
const queryFlights = new Map<string, Promise<unknown>>();
// `ENGINE` is substituted with the actual backend (tsgo for TS/JS, ty for Python) per query.
const NOTE: Record<ToolName, string> = {
  callers: 'Type-aware callers via ENGINE references (checker grade; resolves through interfaces / standard DI). Truly dynamic dispatch (Proxy, obj[k](), token-only DI) stays invisible — a residual for the agent to read.',
  definition: 'Type-aware definition(s) via ENGINE — where this symbol/expression actually resolves (the precise callee), not a name guess.',
  implementations: 'Implementations via ENGINE (type-aware CHA) — results remain the sound over-approximate blast-radius set. Static construction hints rank likely entries but never remove possible ones and are not runtime observations.',
};

/** Cross-platform path bridge: accept BOTH WSL (`/mnt/c/...`) and Windows
 * (`C:\...`) paths no matter which OS this server runs on, so ONE server (e.g. a
 * fast win32 tsgo) can serve a Windows IDE and WSL agents (over interop) alike —
 * same files on disk, different path spelling. */
function toHostPath(p: string): string {
  if (process.platform === 'win32') {
    const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(p);
    return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p;
  }
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
}

type Position = { line: number; character: number };
type ParsedQueryArgs = {
  fileInput: string;
  rootInput: string | null;
  name: string | null;
  explicit: Position | null;
  evidence: boolean | undefined;
};
type LocatedResult = {
  absoluteFile: string;
  line0: number;
  character: number;
  file: string;
  line: number;
  preview: string;
};

function parseQueryArgs(tool: ToolName, args: Record<string, unknown>): ParsedQueryArgs | { error: string } {
  if (typeof args.file !== 'string' || !args.file.trim()) {
    return { error: `${tool} needs \`file\` as a non-empty string (and \`name\` or line/character).` };
  }
  const fileInput = toHostPath(args.file.trim());
  let rootInput: string | null = null;
  if (args.root !== undefined) {
    if (typeof args.root !== 'string' || !args.root.trim()) return { error: '`root` must be a non-empty string when provided.' };
    rootInput = toHostPath(args.root.trim());
  }
  let name: string | null = null;
  if (args.name !== undefined) {
    if (typeof args.name !== 'string' || !args.name.trim()) return { error: '`name` must be a non-empty string when provided.' };
    name = args.name.trim();
  }
  if (args.evidence !== undefined && typeof args.evidence !== 'boolean') {
    return { error: '`evidence` must be a boolean when provided.' };
  }
  const hasLine = args.line !== undefined;
  const hasCharacter = args.character !== undefined;
  if (hasLine !== hasCharacter) return { error: '`line` and `character` must be provided together.' };
  let explicit: Position | null = null;
  if (hasLine && hasCharacter) {
    const line = args.line;
    const character = args.character;
    if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0 ||
        typeof character !== 'number' || !Number.isSafeInteger(character) || character < 0) {
      return { error: '`line` and `character` must be non-negative safe integers.' };
    }
    explicit = { line, character };
  }
  if (!explicit && !name) return { error: `${tool} needs \`name\` or line/character.` };
  return { fileInput, rootInput, name, explicit, evidence: args.evidence };
}

async function resolveQueryPosition(
  session: LspSession,
  file: string,
  relFile: string,
  name: string | null,
  explicit: Position | null,
): Promise<{ position: Position } | { error: string; candidates?: { name: string; line: number; character: number }[] }> {
  if (explicit) return { position: explicit };
  if (!name) return { error: `could not locate an unnamed symbol in ${relFile}; pass line/character.` };
  const resolved = await session.documentSymbolPosition(file, name);
  if (resolved && 'ambiguous' in resolved) {
    const candidates = resolved.ambiguous.map((candidate) => ({
      name: candidate.container ? `${candidate.container}.${candidate.name}` : candidate.name,
      line: candidate.line,
      character: candidate.character,
    }));
    return {
      error: `"${name}" matches ${candidates.length} declarations in ${relFile}. Re-query with a qualified name (Container.name) or line/character (0-based).`,
      candidates,
    };
  }
  const position = resolved ?? findPosition(file, name);
  return position ? { position } : { error: `could not locate symbol "${name}" in ${relFile}; pass line/character.` };
}

async function collectLocations(
  session: LspSession,
  method: string,
  file: string,
  position: Position,
  root: string,
  snapshot: ProjectSnapshot,
  epoch: Epoch,
): Promise<LocatedResult[]> {
  const locations = await session.locate(method, file, position.line, position.character);
  const seen = new Set<string>();
  const located: LocatedResult[] = [];
  for (const location of locations) {
    let absoluteFile: string;
    try { absoluteFile = fileURLToPath(location.uri); } catch { continue; }
    const dedupeKey = `${absoluteFile}\t${location.line}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const previewToken = snapshot.files.get(absoluteFile)?.signature ?? epoch;
    located.push({
      absoluteFile,
      line0: location.line,
      character: location.character,
      file: relative(root, absoluteFile).replace(/\\/g, '/'),
      line: location.line + 1,
      preview: sourceLine(absoluteFile, location.line, previewToken),
    });
  }
  located.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character);
  return located;
}

async function formatQueryResults(
  tool: ToolName,
  lang: Lang,
  session: LspSession,
  located: LocatedResult[],
  name: string | null,
  instantiationPromise: Promise<InstantiationIndex> | null,
): Promise<{ out: Record<string, unknown>[]; implementationEvidence?: Record<string, unknown> }> {
  if (instantiationPromise) {
    const files = [...new Set(located.map((result) => result.absoluteFile))];
    const [symbolsByFile, instantiations] = await Promise.all([
      documentSymbolsByFile(session, files),
      instantiationPromise,
    ]);
    let likelyCount = 0;
    const out = located.map((result) => {
      const container = implementationOwner(
        symbolsByFile.get(result.absoluteFile) ?? [],
        result.line0,
        result.character,
        name ?? undefined,
      );
      const signals = container ? instantiations.get(container) ?? [] : [];
      const likelihood = signals.length ? 'likely' : 'possible';
      if (likelihood === 'likely') likelyCount++;
      return {
        file: result.file,
        line: result.line,
        preview: result.preview,
        container,
        likelihood,
        ...(signals.length ? {
          staticEvidence: signals.map((signal) => ({
            kind: signal.kind,
            file: signal.file,
            line: signal.line,
            preview: signal.preview,
          })),
        } : {}),
      };
    });
    return {
      out,
      implementationEvidence: {
        basis: 'static-source-hints',
        runtimeObserved: false,
        possibleCount: out.length,
        likelyCount,
        caveat: 'Ranking only: lexical `new`/`useClass` source hints can be false positives, occur in dead code, or collide by class name. Every checker result remains in `results`.',
      },
    };
  }

  const out = located.map((result) => ({ file: result.file, line: result.line, preview: result.preview }));
  if (tool !== 'implementations') return { out };
  return {
    out,
    implementationEvidence: {
      basis: lang === 'py' ? 'unavailable-for-lower-bound-backend' : 'not-requested',
      runtimeObserved: false,
      possibleCount: out.length,
      likelyCount: 0,
      caveat: 'No implementation was filtered; `results` is the possible set.',
    },
  };
}

/** One query path for all three tools: resolve a position, gate on the cache, else
 * ask the warm tsgo session (references / definition / implementation), format. */
async function query(tool: ToolName, args: Record<string, unknown>): Promise<unknown> {
  const parsed = parseQueryArgs(tool, args);
  if ('error' in parsed) return parsed;
  const { fileInput, rootInput, name, explicit, evidence } = parsed;
  const file = isAbsolute(fileInput) ? fileInput : resolve(rootInput ?? process.cwd(), fileInput);
  if (!existsSync(file)) return { error: `file not found: ${file}` };
  const lang = langOf(file);
  if (!lang) return { error: `unsupported file type: ${file} (expected TS/JS or Python).` };
  const be = backend(lang);
  if (!be) return { error: lang === 'ts' ? 'tsgo not found — set TSGO_BIN or `npm install` in code-oracle/.' : 'ty not found — install ty or uvx, or set TY_CMD.' };

  const root = rootInput ? resolve(rootInput) : projectRoot(file, lang);
  const relFile = relative(root, file).replace(/\\/g, '/');
  const includeImplementationEvidence = tool === 'implementations' && lang === 'ts' && evidence !== false;
  const evidenceVariant = tool === 'implementations' ? `:${includeImplementationEvidence ? 'e1' : 'e0'}` : '';
  const cacheKey = `v${RESULT_SCHEMA}:${tool}:${relFile}#${name ?? `${explicit!.line}:${explicit!.character}`}${evidenceVariant}`;

  // Cache gate: serve instantly (no LSP warmup) when the project hasn't changed.
  const snapshot = await projectSnapshot(root);
  const epoch = snapshot.epoch;
  const cache = loadCache(root);
  if (cache.epoch === epoch && cache.entries[cacheKey]) {
    return { ...(cache.entries[cacheKey] as object), cached: true };
  }

  const flightKey = `${root}\0${epoch}\0${cacheKey}`;
  const active = queryFlights.get(flightKey);
  if (active) return active;

  // Resolve the symbol position. Explicit coords win; otherwise anchor on the DECLARATION
  // via the LSP's documentSymbol (skips comments/strings/imports), falling back to the
  // comment-skipping text scan only if the LSP doesn't know the name.
  const run = async (): Promise<unknown> => {
    const lease = await acquireSession(root, lang, be, snapshot);
    try {
      const sess = lease.session;
      const positionResult = await resolveQueryPosition(sess, file, relFile, name, explicit);
      if ('error' in positionResult) return positionResult;
      const pos = positionResult.position;

      // The optional evidence scan is pure filesystem work; overlap it with the
      // checker request so it does not add another serial warmup phase.
      const instantiationPromise = includeImplementationEvidence ? instantiationIndexFor(root, snapshot) : null;
      const located = await collectLocations(sess, METHOD[tool], file, pos, root, snapshot, epoch);
      const { out, implementationEvidence } = await formatQueryResults(
        tool,
        lang,
        sess,
        located,
        name,
        instantiationPromise,
      );
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
      const result = {
        tool,
        symbol: { file: relFile, name, position: pos },
        root,
        results: out,
        count: out.length,
        cached: false,
        coverage: coverageFor(tool, lang),
        note,
        ...(implementationEvidence ? { implementationEvidence } : {}),
        ...(pyRefsCaveat ? { incomplete: true } : {}),
      };
      const reset = cache.epoch !== epoch;
      if (reset) { cache.epoch = epoch; cache.entries = {}; } // project changed → drop stale, re-seed
      cache.entries[cacheKey] = result;
      schedulePersist(root, cacheKey, reset);
      return result;
    } finally {
      lease.release();
    }
  };

  let flight!: Promise<unknown>;
  flight = run().finally(() => {
    if (queryFlights.get(flightKey) === flight) queryFlights.delete(flightKey);
  });
  queryFlights.set(flightKey, flight);
  return flight;
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
    evidence: { type: 'boolean', description: 'For TypeScript/JavaScript implementations, attach bounded static instantiation hints and likely/possible ranking. Defaults to true; false skips that optional project scan. Results are never filtered.' },
  },
  required: ['file'],
} as const;

const TOOLS = [
  {
    name: 'callers',
    description:
      'Type-aware callers of a symbol — "who calls this", at checker grade via a warm LSP session (tsgo for TS/JS, ty for Python; picked by file extension). Resolves calls through interfaces and standard DI (declaration types) that a structural call graph cannot. Structured `coverage` names dynamic-dispatch residuals and flags Python references as an intra-file lower bound. First call per project warms it (~seconds); the session stays warm and answers are cached.',
    inputSchema: INPUT,
  },
  {
    name: 'definition',
    description: 'Type-aware definition(s) of the symbol/expression at a location — where `obj.m()` actually resolves (the precise callee). Not a name guess. (tsgo for TS/JS, ty for Python.)',
    inputSchema: INPUT,
  },
  {
    name: 'implementations',
    description: 'Implementations of an interface/abstract method — the concrete classes/methods behind it (type-aware Class Hierarchy Analysis). `results` always remains the sound over-approximate blast-radius set. For TS/JS, bounded static `new`/`useClass` hints rank entries as likely/possible without filtering; `implementationEvidence.runtimeObserved` stays false. Python is explicitly a lower bound. (tsgo for TS/JS, ty for Python.)',
    inputSchema: INPUT,
  },
];

let sendTail = Promise.resolve();
function send(msg: unknown): Promise<void> {
  const queued = sendTail.then(async () => {
    if (stopping || process.stdout.destroyed) return;
    const line = `${JSON.stringify(msg)}\n`;
    if (process.stdout.write(line)) return;
    const resumeInput = !process.stdin.isPaused();
    process.stdin.pause(); // natural stream backpressure, not an arbitrary request cap
    try {
      await new Promise<void>((resolveDrain, rejectDrain) => {
        const cleanup = (): void => {
          process.stdout.off('drain', onDrain);
          process.stdout.off('error', onError);
        };
        const onDrain = (): void => { cleanup(); resolveDrain(); };
        const onError = (error: Error): void => { cleanup(); rejectDrain(error); };
        process.stdout.once('drain', onDrain);
        process.stdout.once('error', onError);
      });
    } finally {
      if (resumeInput && !stopping) process.stdin.resume();
    }
  });
  // Keep later responses ordered even if the consumer closes its pipe.
  sendTail = queued.catch(() => undefined);
  return queued;
}

async function handle(req: UnknownRecord): Promise<void> {
  if (stopping) return;
  const rawId = req.id;
  const id: RpcId | undefined = rawId === null || typeof rawId === 'string' || typeof rawId === 'number' ? rawId : undefined;
  const method = typeof req.method === 'string' ? req.method : undefined;
  const params = isObjectRecord(req.params) ? req.params : null;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'code-oracle', version: '0.1.0' } } });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const tool = params?.name;
        if (typeof tool !== 'string' || !(tool in METHOD)) throw new Error(`unknown tool: ${String(tool)}`);
        const argumentsValue = params?.arguments;
        if (argumentsValue !== undefined && !isObjectRecord(argumentsValue)) throw new Error('tool `arguments` must be an object.');
        const result = await query(tool as ToolName, argumentsValue ?? {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
      }
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      default:
        if (isRequest) await send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown internal error';
    if (isRequest) await send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
  }
}

// ── opt-in pre-warm: lazy startup avoids spawning an unused checker per MCP client ──
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

/** Optionally pre-warm the working project at startup. Lazy startup is the safe
 * default; set CODE_ORACLE_PREWARM=1 when paying the memory cost up front is useful. */
async function prewarm(): Promise<void> {
  if (process.env.CODE_ORACLE_PREWARM !== '1' || stopping) return;
  const root = process.env.CODE_ORACLE_ROOT ? resolve(process.env.CODE_ORACLE_ROOT) : process.cwd();
  const langs: Lang[] = [];
  if (existsSync(join(root, 'tsconfig.json'))) langs.push('ts');
  if (['pyproject.toml', 'setup.py', 'setup.cfg'].some((m) => existsSync(join(root, m)))) langs.push('py');
  for (const lang of langs) {
    if (stopping) return;
    const be = backend(lang);
    if (!be) { process.stderr.write(`code-oracle: ${lang} project at ${root} but its tool isn't installed — pre-warm skipped\n`); continue; }
    const seed = await firstSourceFile(root, lang);
    if (!seed || stopping) continue;
    process.stderr.write(`code-oracle: warming the ${lang} oracle for ${root} (~10-20s; queries wait until ready)…\n`);
    const started = Date.now();
    const snapshot = await projectSnapshot(root);
    if (stopping) return;
    const lease = await acquireSession(root, lang, be, snapshot);
    try {
      await lease.session.prewarm(seed);
      if (!stopping) process.stderr.write(`code-oracle: ${lang} oracle ready in ${Math.round((Date.now() - started) / 1000)}s\n`);
    } finally {
      lease.release();
    }
  }
}

function main(): void {
  if (!backend('ts')) process.stderr.write('code-oracle: tsgo not found — set TSGO_BIN or `npm install` in code-oracle/. (Python uses ty via uvx / TY_CMD.) Tools error per-language until present.\n');
  const rl = createInterface({ input: process.stdin });
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    rl.close();
    process.stdin.pause();
    disposeAll();
    process.exitCode = 0;
  };
  rl.on('line', (line) => {
    if (stopping) return;
    const t = line.trim();
    if (!t) return;
    let req: unknown;
    try { req = JSON.parse(t); } catch { return; }
    if (isObjectRecord(req)) void handle(req);
  });
  rl.once('close', shutdown); // stdin EOF is the MCP client's lifecycle boundary
  process.stdout.once('error', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.once('exit', disposeAll);
  void prewarm().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : 'unknown error';
    if (!stopping) process.stderr.write(`code-oracle: pre-warm failed: ${detail}\n`);
  });
}

let isEntry = false;
try { isEntry = !!process.argv[1] && (await import('node:fs')).realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* imported */ }
if (isEntry) main();

/** Kill every warm LSP session — tests must call this or the live tsgo/ty child
 * keeps the process alive. */
export function disposeAll(): void {
  flushCaches();
  for (const [key, entry] of sessions) disposeSession(key, entry);
  sessions.clear();
  sessionQueues.clear();
  epochCache.clear();
  epochFlights.clear();
  instantiationCache.clear();
  instantiationFlights.clear();
  queryFlights.clear();
  lineCache.clear();
  caches.clear();
}

export { query, TOOLS };
