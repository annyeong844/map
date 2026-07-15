/**
 * One warm checker process and its LSP protocol lifecycle.
 *
 * Framing, requests, document sync, readiness, failure and disposal share one
 * process state, so splitting them further would create fake boundaries.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { type LspBackendSpec, lspLanguageId } from './lsp-backend.ts';
import type {
  Epoch,
  Lang,
  ProjectFile,
  ProjectSnapshot,
} from './project-snapshot.ts';
import {
  StaticImportSupplement,
  type StaticSupplementDegradation,
} from './static-import-supplement.ts';

const DEFAULT_QUIET_MS = 1500;
const DEFAULT_MIN_MS = 1500;
const DEFAULT_WARMUP_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 40_000;
const QUIET_MS = Number(process.env.TS_ORACLE_QUIET_MS ?? DEFAULT_QUIET_MS);
const MIN_MS = Number(process.env.TS_ORACLE_MIN_MS ?? DEFAULT_MIN_MS);
const MAX_MS = Number(process.env.TS_ORACLE_WARMUP_MS ?? DEFAULT_WARMUP_MS);
const REQ_TIMEOUT_MS = Number(
  process.env.TS_ORACLE_REQ_TIMEOUT_MS ?? DEFAULT_REQUEST_TIMEOUT_MS,
);
const INIT_TIMEOUT_MS = Number(
  process.env.TS_ORACLE_INIT_TIMEOUT_MS ?? REQ_TIMEOUT_MS,
);
const MAX_BACKEND_STDERR_BYTES = 32 * 1024;
const CARRIAGE_RETURN_BYTE = 13;
const LINE_FEED_BYTE = 10;
const HEADER_TERMINATOR_LENGTH = 4;
const MAX_LSP_HEADER_BYTES = 16_384;
const MAX_LSP_BODY_BYTES = 268_435_456;
const READY_POLL_MS = 200;
const DOCUMENT_SYMBOL_CONCURRENCY = 8;
const SYMBOL_NAME_MISMATCH_PENALTY = 1000;

export type OracleLocation = {
  uri: string;
  line: number;
  character: number;
  basis?: 'static-import-call';
};
type UnknownRecord = Record<string, unknown>;

function isObjectRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordAt(value: unknown, key: string): UnknownRecord | null {
  if (!isObjectRecord(value)) return null;
  const nested = value[key];
  return isObjectRecord(nested) ? nested : null;
}

function finiteNumberAt(
  value: UnknownRecord | null,
  key: string,
  fallback = 0,
): number {
  const candidate = value?.[key];
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : fallback;
}

function relevantProjectFiles(
  projectFiles: Map<string, ProjectFile>,
  lang: Lang,
): Map<string, ProjectFile> {
  const configKind = `${lang}-config` as const;
  const relevant = new Map<string, ProjectFile>();
  for (const [path, file] of projectFiles) {
    if (file.kind === lang || file.kind === configKind) {
      relevant.set(path, file);
    }
  }
  return relevant;
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
        if (n > MAX_LSP_HEADER_BYTES) {
          this.headerBytes = [];
          continue;
        }
        if (
          n < HEADER_TERMINATOR_LENGTH ||
          this.headerBytes[n - HEADER_TERMINATOR_LENGTH] !==
            CARRIAGE_RETURN_BYTE ||
          this.headerBytes[n - (HEADER_TERMINATOR_LENGTH - 1)] !==
            LINE_FEED_BYTE ||
          this.headerBytes[n - 2] !== CARRIAGE_RETURN_BYTE ||
          this.headerBytes[n - 1] !== LINE_FEED_BYTE
        ) {
          continue;
        }
        const header = Buffer.from(this.headerBytes).toString();
        this.headerBytes = [];
        const match = /Content-Length: (\d+)/i.exec(header);
        const length = match ? Number(match[1]) : -1;
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > MAX_LSP_BODY_BYTES
        ) {
          continue;
        }
        this.bodyLength = length;
        this.bodyBytes = 0;
        this.bodyChunks = [];
        if (length === 0) {
          this.bodyLength = null;
          messages.push(Buffer.alloc(0));
        }
        continue;
      }

      const take = Math.min(
        this.bodyLength - this.bodyBytes,
        chunk.length - offset,
      );
      if (take > 0) this.bodyChunks.push(chunk.subarray(offset, offset + take));
      this.bodyBytes += take;
      offset += take;
      if (this.bodyBytes !== this.bodyLength) continue;
      messages.push(
        this.bodyChunks.length === 1
          ? this.bodyChunks[0]
          : Buffer.concat(this.bodyChunks, this.bodyLength),
      );
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
export class LspResponseError extends Error {
  readonly code: number | null;
  readonly data: unknown;

  constructor(value: unknown) {
    const response = isObjectRecord(value) ? value : null;
    const code =
      response && typeof response.code === 'number' ? response.code : null;
    const detail =
      response && typeof response.message === 'string' && response.message
        ? response.message
        : 'unknown checker error';
    super(`LSP request failed${code === null ? '' : ` (${code})`}: ${detail}`, {
      cause: value,
    });
    this.name = 'LspResponseError';
    this.code = code;
    this.data = response?.data;
  }
}

export class LspSession {
  private proc: ChildProcess;
  private decoder = new ContentLengthDecoder();
  private pending = new Map<
    number,
    {
      resolve: (r: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private failure: Error | null = null;
  private nextId = 1;
  private opened = new Map<
    string,
    {
      version: number;
      mtimeMs: number;
      ctimeMs: number;
      size: number;
      ino: number;
    }
  >();
  private initDone: Promise<void>;
  private warmed = false;
  private lastMsgAt = Date.now();
  private languageId: string;
  private readonly lang: Lang;
  private projectFiles: Map<string, ProjectFile>;
  private projectEpoch: Epoch;
  private readonly projectRoot: string;
  private staticSupplement: StaticImportSupplement;
  private readonly lifecycle = new AbortController();
  private stderrTail = Buffer.alloc(0);
  private diagnosedErrors = new WeakSet<Error>();

  constructor(
    spec: LspBackendSpec,
    root: string,
    snapshot: ProjectSnapshot,
    lang: Lang,
  ) {
    this.languageId = spec.languageId;
    this.lang = lang;
    this.projectFiles = relevantProjectFiles(snapshot.files, lang);
    this.projectEpoch = snapshot.epoch;
    this.projectRoot = root;
    this.staticSupplement = new StaticImportSupplement(root, this.projectFiles);
    this.proc = spawn(spec.cmd, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (d: Buffer) => {
      this.onData(d);
    });
    this.proc.stderr!.on('data', (d: Buffer) => {
      this.captureStderr(d);
    });
    this.proc.on('error', (error) => {
      this.fail(error);
    });
    this.proc.on('close', (code, signal) => {
      this.fail(
        new Error(
          `LSP backend exited before replying (${signal ?? `code ${code}`}).`,
        ),
      );
    });
    this.initDone = this.initialize(root);
  }

  private captureStderr(chunk: Buffer): void {
    if (chunk.length >= MAX_BACKEND_STDERR_BYTES) {
      this.stderrTail = Buffer.from(
        chunk.subarray(chunk.length - MAX_BACKEND_STDERR_BYTES),
      );
      return;
    }
    const retainedBytes = MAX_BACKEND_STDERR_BYTES - chunk.length;
    const retained =
      this.stderrTail.length <= retainedBytes
        ? this.stderrTail
        : this.stderrTail.subarray(this.stderrTail.length - retainedBytes);
    this.stderrTail = Buffer.concat(
      [retained, chunk],
      retained.length + chunk.length,
    );
  }

  private withBackendDiagnostics(error: Error): Error {
    if (this.diagnosedErrors.has(error) || this.stderrTail.length === 0) {
      return error;
    }
    this.diagnosedErrors.add(error);
    const detail = this.stderrTail.toString('utf8').trimEnd();
    if (detail) error.message += `\nBackend stderr tail:\n${detail}`;
    return error;
  }

  private fail(error: Error): void {
    if (this.failure) return;
    const diagnosed = this.withBackendDiagnostics(error);
    this.failure = diagnosed;
    this.lifecycle.abort(diagnosed);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(diagnosed);
    }
    this.pending.clear();
  }

  private terminateBackend(): void {
    try {
      this.proc.stdin?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
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
    try {
      parsed = JSON.parse(body.toString());
    } catch {
      return;
    }
    if (!isObjectRecord(parsed)) return;
    const id = parsed.id;
    if (typeof id === 'number' && this.pending.has(id)) {
      const pending = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (parsed.error !== undefined && parsed.error !== null) {
        pending.reject(
          this.withBackendDiagnostics(new LspResponseError(parsed.error)),
        );
      } else {
        pending.resolve(parsed.result);
      }
    } else if (
      (typeof id === 'string' || typeof id === 'number') &&
      typeof parsed.method === 'string'
    ) {
      // server→client request: must answer or the server stalls (watcher/config).
      const params = isObjectRecord(parsed.params) ? parsed.params : null;
      const items = params && Array.isArray(params.items) ? params.items : [];
      const result =
        parsed.method === 'workspace/configuration'
          ? items.map(() => ({}))
          : null;
      this.write({ jsonrpc: '2.0', id, result });
    }
  }

  private write(msg: unknown): void {
    if (this.failure) throw this.failure;
    if (!this.proc.stdin?.writable) {
      throw new Error('LSP backend stdin is closed.');
    }
    const s = JSON.stringify(msg);
    this.proc.stdin.write(
      `Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`,
    );
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = REQ_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextId++;
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((fulfill, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        const error = new Error(
          `LSP request timed out after ${timeoutMs}ms: ${method}`,
        );
        this.fail(error);
        this.terminateBackend();
      }, timeoutMs);
      this.pending.set(id, { resolve: fulfill, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new Error('Writing the LSP request failed.', { cause: error }),
        );
      }
    });
  }

  private async initialize(root: string): Promise<void> {
    const uri = pathToFileURL(root).href;
    await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: uri,
        capabilities: {
          workspace: {
            configuration: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
        },
        workspaceFolders: [{ uri, name: 'root' }],
      },
      INIT_TIMEOUT_MS,
    );
    this.notify('initialized', {});
  }

  /** Sync a file's current content into the session (didOpen first time, didChange after). */
  private syncFile(file: string): string {
    const uri = pathToFileURL(file).href;
    const info = statSync(file);
    const prior = this.opened.get(uri);
    if (
      prior &&
      prior.mtimeMs === info.mtimeMs &&
      prior.ctimeMs === info.ctimeMs &&
      prior.size === info.size &&
      prior.ino === info.ino
    ) {
      return uri;
    }
    const text = readFileSync(file, 'utf8');
    const version = (prior?.version ?? 0) + 1;
    this.opened.set(uri, {
      version,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      size: info.size,
      ino: info.ino,
    });
    if (version === 1) {
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: lspLanguageId(file, this.languageId),
          version,
          text,
        },
      });
    } else {
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }

  async inferredStaticCallers(
    queriedFile: string,
    name: string | null,
  ): Promise<{
    applied: boolean;
    locations: OracleLocation[];
    degradation: StaticSupplementDegradation | null;
  }> {
    if (this.languageId !== 'typescript') {
      return { applied: false, locations: [], degradation: null };
    }
    await this.initDone;
    return this.staticSupplement.callers(
      queriedFile,
      name,
      this.lifecycle.signal,
    );
  }

  /** Bring files changed outside the queried document into the warm project.
   * Added/modified sources can be overlaid cheaply. Deletions and project-config
   * changes require a fresh language-server project graph, so the caller restarts. */
  async reconcileProject(snapshot: ProjectSnapshot): Promise<boolean> {
    this.throwIfFailed();
    if (this.projectEpoch === snapshot.epoch) return true;
    const projectFiles = snapshot.files;
    const configKind = `${this.lang}-config` as const;
    const changed: string[] = [];
    let relevantCount = 0;
    for (const [path, current] of projectFiles) {
      if (current.kind !== this.lang && current.kind !== configKind) continue;
      relevantCount++;
      const prior = this.projectFiles.get(path);
      if (
        current.kind === configKind &&
        (!prior || prior.signature !== current.signature)
      ) {
        return false;
      }
      if (
        current.kind === this.lang &&
        prior?.signature !== current.signature
      ) {
        changed.push(path);
      }
    }
    // Deletions require a project restart. Check the old, already language-filtered
    // map directly; unchanged projects avoid allocating a replacement Map entirely.
    for (const path of this.projectFiles.keys()) {
      if (!projectFiles.has(path)) return false;
    }
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
    this.projectFiles = relevantProjectFiles(projectFiles, this.lang);
    this.staticSupplement = new StaticImportSupplement(
      this.projectRoot,
      this.projectFiles,
    );
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
      if (
        (Date.now() - this.lastMsgAt > QUIET_MS && elapsed > MIN_MS) ||
        elapsed > MAX_MS
      ) {
        break;
      }
      await new Promise<void>((ready) => {
        setTimeout(ready, READY_POLL_MS);
      });
    }
    this.throwIfFailed();
    this.warmed = true;
  }

  /** Run an LSP location query (`references` / `definition` / `implementation`) at a
   * position; return target locations. Handles both Location and LocationLink shapes. */
  async locate(
    method: string,
    file: string,
    line: number,
    character: number,
  ): Promise<OracleLocation[]> {
    await this.initDone;
    const uri = this.syncFile(file);
    await this.waitReady();
    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: { line, character },
    };
    if (method === 'textDocument/references') {
      params.context = { includeDeclaration: false };
    }
    const response = await this.request(method, params);
    let values: unknown[] = [];
    if (Array.isArray(response)) values = response;
    else if (isObjectRecord(response)) values = [response];
    const locations: OracleLocation[] = [];
    for (const value of values) {
      if (!isObjectRecord(value)) continue;
      let target: string | null = null;
      if (typeof value.uri === 'string') target = value.uri;
      else if (typeof value.targetUri === 'string') target = value.targetUri;
      const range =
        [value.range, value.targetSelectionRange, value.targetRange].find(
          isObjectRecord,
        ) ?? null;
      const start = recordAt(range, 'start');
      if (target) {
        locations.push({
          uri: target,
          line: finiteNumberAt(start, 'line'),
          character: finiteNumberAt(start, 'character'),
        });
      }
    }
    return locations;
  }

  /** Flatten the LSP documentSymbol tree while preserving each symbol's
   * immediate container. Selection ranges anchor on real declarations rather
   * than comments, strings, or imports. */
  async documentSymbols(
    file: string,
    syncDocument = true,
  ): Promise<OracleSym[]> {
    await this.initDone;
    // Result files are already part of the checker's project graph. Avoid
    // didOpen-ing every implementation file merely to rank it: open documents
    // stay resident in the LSP and a wide hierarchy could otherwise grow memory
    // with its fan-out. Name resolution still syncs the actively queried file.
    const uri = syncDocument ? this.syncFile(file) : pathToFileURL(file).href;
    await this.waitReady();
    const response = await this.request('textDocument/documentSymbol', {
      textDocument: { uri },
    });
    if (!Array.isArray(response)) return [];
    let fileLines: string[] | null = null;
    const lineText = (ln: number): string => {
      if (!fileLines) {
        try {
          fileLines = readFileSync(file, 'utf8').split('\n');
        } catch {
          fileLines = [];
        }
      }
      return fileLines[ln] ?? '';
    };
    const out: OracleSym[] = [];
    const walk = (nodes: unknown[], container: string | null): void => {
      for (const value of nodes) {
        if (!isObjectRecord(value)) continue;
        const name =
          typeof value.name === 'string' && value.name ? value.name : null;
        if (name) {
          const selectionStart = recordAt(
            recordAt(value, 'selectionRange'),
            'start',
          );
          if (selectionStart) {
            out.push({
              name,
              container,
              line: finiteNumberAt(selectionStart, 'line'),
              character: finiteNumberAt(selectionStart, 'character'),
              kind: finiteNumberAt(value, 'kind'),
            });
          } else {
            const locationStart = recordAt(
              recordAt(recordAt(value, 'location'), 'range'),
              'start',
            );
            if (locationStart) {
              // SymbolInformation: refine column to the identifier
              const line = finiteNumberAt(locationStart, 'line');
              const column = lineText(line).indexOf(name);
              out.push({
                name,
                container:
                  typeof value.containerName === 'string'
                    ? value.containerName
                    : container,
                line,
                character:
                  column >= 0
                    ? column
                    : finiteNumberAt(locationStart, 'character'),
                kind: finiteNumberAt(value, 'kind'),
              });
            }
          }
        }
        if (Array.isArray(value.children)) {
          walk(value.children, name ?? container);
        }
      }
    };
    walk(response, null);
    return out;
  }

  /** Resolve one declared name; ambiguous containers are surfaced to the caller. */
  async documentSymbolPosition(
    file: string,
    name: string,
  ): Promise<
    { line: number; character: number } | { ambiguous: OracleSym[] } | null
  > {
    return resolveNamePosition(await this.documentSymbols(file), name);
  }

  /** Eagerly load the project (open a seed file + wait for quiescence) so the first
   * real query doesn't pay the cold warmup. Fire-and-forget at startup. */
  async prewarm(seedFile: string): Promise<void> {
    await this.initDone;
    this.syncFile(seedFile);
    await this.waitReady();
  }

  get ready(): boolean {
    return this.warmed;
  }

  dispose(): void {
    this.fail(new Error('LSP session disposed.'));
    this.terminateBackend();
  }
}

// ── name → declaration position, from the LSP's documentSymbol tree ──
// A flattened documentSymbol entry: the symbol's name, its immediate container
// (parent symbol name, e.g. the class/interface holding a method), and the position
// of the name token itself.
export interface OracleSym {
  name: string;
  container: string | null;
  line: number;
  character: number;
  kind: number;
}

// LSP SymbolKind values that name a real DECLARATION we'd want to anchor a query on.
const LSP_SYMBOL_KIND = {
  Class: 5,
  Method: 6,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Struct: 23,
} as const;
const DECL_KINDS = new Set<number>([
  LSP_SYMBOL_KIND.Class,
  LSP_SYMBOL_KIND.Method,
  LSP_SYMBOL_KIND.Constructor,
  LSP_SYMBOL_KIND.Enum,
  LSP_SYMBOL_KIND.Interface,
  LSP_SYMBOL_KIND.Function,
  LSP_SYMBOL_KIND.Struct,
]);

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
    if (
      symbol.name !== wantName ||
      (wantContainer != null && symbol.container !== wantContainer)
    ) {
      continue;
    }
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

export function implementationOwner(
  symbols: OracleSym[],
  line: number,
  character: number,
  queriedName: string | undefined,
): string | null {
  const simpleName = queriedName
    ? queriedName.slice(queriedName.lastIndexOf('.') + 1)
    : null;
  let best: { owner: string; score: number } | null = null;
  for (const symbol of symbols) {
    if (symbol.line !== line) continue;
    const owner =
      symbol.container ??
      (symbol.kind === LSP_SYMBOL_KIND.Class ? symbol.name : null);
    if (!owner) continue;
    const score =
      Math.abs(symbol.character - character) +
      (simpleName && symbol.name !== simpleName
        ? SYMBOL_NAME_MISMATCH_PENALTY
        : 0);
    if (!best || score < best.score) best = { owner, score };
  }
  return best?.owner ?? null;
}

export async function documentSymbolsByFile(
  session: LspSession,
  files: string[],
): Promise<Map<string, OracleSym[]>> {
  const symbols = new Map<string, OracleSym[]>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      const file = files[cursor++];
      symbols.set(file, await session.documentSymbols(file, false));
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(DOCUMENT_SYMBOL_CONCURRENCY, files.length) },
      worker,
    ),
  );
  return symbols;
}

// ── symbol → position, TEXT fallback (used only when the LSP can't resolve the name).
// Prefer the first occurrence on a line that is NOT a comment or an import — a raw
// first-hit scan anchored on the word inside a doc comment and returned 0 callers
// (firsthand 2026-06). Keep the first raw hit as a last resort so we never regress to null. ──
function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*|#)/.test(line);
}

function isImportLine(line: string): boolean {
  return /^\s*import\b/.test(line) || /^\s*(export\b.*\bfrom\b)/.test(line);
}

export function findPosition(
  file: string,
  name?: string,
  line?: number,
  character?: number,
): { line: number; character: number } | null {
  if (line != null && character != null) return { line, character };
  if (!name) return null;
  const lines = readFileSync(file, 'utf8').split('\n');
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  let firstHit: { line: number; character: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i].search(re);
    if (c < 0) continue;
    if (firstHit == null) firstHit = { line: i, character: c };
    if (isCommentLine(lines[i]) || isImportLine(lines[i])) continue;
    return { line: i, character: c }; // first non-comment, non-import occurrence
  }
  return firstHit; // everything was comment/import — better than nothing
}
