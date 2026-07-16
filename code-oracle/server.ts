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
import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { backend, projectRoot } from './lsp-backend.ts';
import {
  documentSymbolsByFile,
  findPosition,
  implementationOwner,
  LspResponseError,
  type LspSession,
  type OracleLocation,
} from './lsp-session.ts';
import { LspSessionPool } from './lsp-session-pool.ts';
import { NdjsonDecoder, type NdjsonEvent } from './mcp-ndjson.ts';
import {
  type AdmissionStats,
  ByteLru,
  type ByteLruStats,
  positiveIntegerEnv,
} from './runtime-control.ts';
import {
  type CachedOracleResult,
  ResultCacheStore,
  SourceLineCache,
} from './oracle-cache.ts';
import {
  type Epoch,
  firstSourceFile,
  type Lang,
  langOf,
  type ProjectSnapshot,
  ProjectSnapshotStore,
  scanProjectEpoch,
} from './project-snapshot.ts';

export { resolveTsgoPackageBin, tsgoSpawnCommand } from './lsp-backend.ts';
export { ContentLengthDecoder, resolveNamePosition } from './lsp-session.ts';
export type { OracleSym } from './lsp-session.ts';

const PROTOCOL = '2025-06-18';
const RESULT_SCHEMA = 6;
const MINUTE_MS = 60_000;
const DEFAULT_SESSION_IDLE_MINUTES = 10;
const DEFAULT_MAX_ACTIVE_PROJECT_SCANS = 2;
const DEFAULT_MAX_INFLIGHT_REQUESTS = 32;
const CARRIAGE_RETURN_BYTE = 13;
const HASH_HEX_LENGTH = 16;
const TAB_CODE = 9;
const SPACE_CODE = 32;
const SOURCE_PREVIEW_LENGTH = 160;
const MAX_QUERY_DEGRADATION_EXAMPLES = 8;
const CACHE_PERSIST_DELAY_MS = 5000;
const PREWARM_SCAN_LIMIT = 4000;
const SECOND_MS = 1000;
const MEBIBYTE_BYTES = 1_048_576;
const DEFAULT_RESULT_CACHE_MEBIBYTES = 64;
const DEFAULT_SOURCE_LINE_CACHE_MEBIBYTES = 32;
const DEFAULT_PROJECT_SNAPSHOT_CACHE_MEBIBYTES = 64;
const DEFAULT_INSTANTIATION_CACHE_MEBIBYTES = 32;
const DEFAULT_MAX_NDJSON_MEBIBYTES = 8;
const CACHE_ENTRY_OVERHEAD_BYTES = 64;
const NUMBER_STORAGE_BYTES = 8;
const SESSION_IDLE_MS = positiveIntegerEnv(
  'CODE_ORACLE_SESSION_IDLE_MS',
  DEFAULT_SESSION_IDLE_MINUTES * MINUTE_MS,
);
const MAX_ACTIVE_PROJECT_SCANS = positiveIntegerEnv(
  'CODE_ORACLE_MAX_ACTIVE_PROJECT_SCANS',
  DEFAULT_MAX_ACTIVE_PROJECT_SCANS,
);
const MAX_INFLIGHT_REQUESTS = positiveIntegerEnv(
  'CODE_ORACLE_MAX_INFLIGHT_REQUESTS',
  DEFAULT_MAX_INFLIGHT_REQUESTS,
);
const CACHE_IDLE_MS = positiveIntegerEnv(
  'CODE_ORACLE_CACHE_IDLE_MS',
  SESSION_IDLE_MS,
);
const RESULT_CACHE_MAX_BYTES = positiveIntegerEnv(
  'CODE_ORACLE_RESULT_CACHE_MAX_BYTES',
  DEFAULT_RESULT_CACHE_MEBIBYTES * MEBIBYTE_BYTES,
);
const SOURCE_LINE_CACHE_MAX_BYTES = positiveIntegerEnv(
  'CODE_ORACLE_SOURCE_LINE_CACHE_MAX_BYTES',
  DEFAULT_SOURCE_LINE_CACHE_MEBIBYTES * MEBIBYTE_BYTES,
);
const PROJECT_SNAPSHOT_CACHE_MAX_BYTES = positiveIntegerEnv(
  'CODE_ORACLE_PROJECT_SNAPSHOT_CACHE_MAX_BYTES',
  DEFAULT_PROJECT_SNAPSHOT_CACHE_MEBIBYTES * MEBIBYTE_BYTES,
);
const INSTANTIATION_CACHE_MAX_BYTES = positiveIntegerEnv(
  'CODE_ORACLE_INSTANTIATION_CACHE_MAX_BYTES',
  DEFAULT_INSTANTIATION_CACHE_MEBIBYTES * MEBIBYTE_BYTES,
);
const MAX_NDJSON_LINE_BYTES = positiveIntegerEnv(
  'CODE_ORACLE_MAX_NDJSON_LINE_BYTES',
  DEFAULT_MAX_NDJSON_MEBIBYTES * MEBIBYTE_BYTES,
);
let activeMcpRequests = 0;
let maxObservedMcpRequests = 0;
let queuedMcpRequests = 0;
let maxObservedQueuedMcpRequests = 0;

const ORACLE_SERVER_FILE = fileURLToPath(import.meta.url);
const HERE = dirname(ORACLE_SERVER_FILE);
const ORACLE_INSTANCE_STARTED_AT = new Date().toISOString();
let stopping = false;
const checkerSessions = new LspSessionPool(() => stopping);

type UnknownRecord = Record<string, unknown>;
type RpcId = string | number | null;

function isObjectRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImportLine(line: string): boolean {
  return /^\s*import\b/.test(line) || /^\s*(export\b.*\bfrom\b)/.test(line);
}

export interface OracleCoverage {
  kind:
    | 'checker-resolved'
    | 'checker-confirmed'
    | 'checker-plus-static'
    | 'sound-overapproximation'
    | 'lower-bound';
  scope: 'project' | 'checker-visible-project' | 'intra-file';
  residuals: string[];
}

const DYNAMIC_RESIDUALS = [
  'proxy-dispatch',
  'computed-property-call',
  'token-only-di',
];

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

interface RuntimeFileIdentity {
  mtimeMs: number;
  size: number;
  ctimeMs: number;
  ino: number;
}

interface RuntimeSourceManifest {
  digest: string | null;
  files: string[];
}

function runtimeFileIdentity(path: string): RuntimeFileIdentity | null {
  try {
    const info = statSync(path);
    return {
      mtimeMs: info.mtimeMs,
      size: info.size,
      ctimeMs: info.ctimeMs,
      ino: info.ino,
    };
  } catch {
    return null;
  }
}

function runtimeSourceManifest(directory: string): RuntimeSourceManifest {
  try {
    const files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
    const hash = createHash('sha256');
    for (const file of files) {
      hash
        .update(file)
        .update('\0')
        .update(readFileSync(join(directory, file)));
      hash.update('\0');
    }
    return { digest: hash.digest('hex'), files };
  } catch {
    return { digest: null, files: [] };
  }
}

function oraclePackageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(HERE, 'package.json'), 'utf8'),
    );
    return isObjectRecord(parsed) && typeof parsed.version === 'string'
      ? parsed.version
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const ORACLE_VERSION = oraclePackageVersion();
const ORACLE_SOURCE_AT_START = runtimeFileIdentity(ORACLE_SERVER_FILE);
const ORACLE_RUNTIME_AT_START = runtimeSourceManifest(HERE);
const ORACLE_SOURCE_DIGEST_AT_START = ORACLE_RUNTIME_AT_START.digest;

export function oracleRuntimeDiagnostics(): {
  version: string;
  buildId: string;
  instanceId: string;
  pid: number;
  startedAt: string;
  cwd: string;
  execPath: string;
  entrypoint: string | null;
  serverFile: string;
  sourceAtStart: RuntimeFileIdentity | null;
  sourceNow: RuntimeFileIdentity | null;
  sourceDigestAtStart: string | null;
  sourceDigestNow: string | null;
  runtimeSourcesAtStart: string[];
  runtimeSourcesNow: string[];
  maxInflightRequests: number;
  activeMcpRequests: number;
  maxObservedMcpRequests: number;
  queuedMcpRequests: number;
  maxObservedQueuedMcpRequests: number;
  sessionAdmission: AdmissionStats;
  projectScanAdmission: AdmissionStats;
  caches: {
    results: ByteLruStats;
    sourceLines: ByteLruStats;
    projectSnapshots: ByteLruStats;
    instantiations: ByteLruStats;
  };
  restartRequired: boolean;
  warning?: string;
} {
  const sourceNow = runtimeFileIdentity(ORACLE_SERVER_FILE);
  const runtimeNow = runtimeSourceManifest(HERE);
  const sourceDigestNow = runtimeNow.digest;
  const restartRequired =
    ORACLE_SOURCE_DIGEST_AT_START !== sourceDigestNow ||
    JSON.stringify(ORACLE_SOURCE_AT_START) !== JSON.stringify(sourceNow);
  const projectStats = projectSnapshots.stats();
  return {
    version: ORACLE_VERSION,
    buildId: `${ORACLE_VERSION}:${ORACLE_SOURCE_DIGEST_AT_START?.slice(0, HASH_HEX_LENGTH) ?? 'missing'}`,
    instanceId: `${process.pid}:${ORACLE_INSTANCE_STARTED_AT}`,
    pid: process.pid,
    startedAt: ORACLE_INSTANCE_STARTED_AT,
    cwd: process.cwd(),
    execPath: process.execPath,
    entrypoint: process.argv[1] ?? null,
    serverFile: ORACLE_SERVER_FILE,
    sourceAtStart: ORACLE_SOURCE_AT_START,
    sourceNow,
    sourceDigestAtStart: ORACLE_SOURCE_DIGEST_AT_START,
    sourceDigestNow,
    runtimeSourcesAtStart: ORACLE_RUNTIME_AT_START.files,
    runtimeSourcesNow: runtimeNow.files,
    maxInflightRequests: MAX_INFLIGHT_REQUESTS,
    activeMcpRequests,
    maxObservedMcpRequests,
    queuedMcpRequests,
    maxObservedQueuedMcpRequests,
    sessionAdmission: checkerSessions.stats(),
    projectScanAdmission: projectStats.admission,
    caches: {
      results: resultCache.stats(),
      sourceLines: sourceLines.stats(),
      projectSnapshots: projectStats.cache,
      instantiations: instantiationCache.stats(),
    },
    restartRequired,
    ...(restartRequired
      ? {
          warning:
            'Oracle runtime source files changed after the process started. Start a new MCP session before treating its results as evidence.',
        }
      : {}),
  };
}

interface AbortableFlight<T> {
  controller: AbortController;
  promise: Promise<T>;
}

export interface StaticInstantiationHint {
  name: string;
  kind: 'constructor' | 'di-use-class';
  file: string;
  line: number;
  preview: string;
}

const projectSnapshots = new ProjectSnapshotStore({
  maxActiveScans: MAX_ACTIVE_PROJECT_SCANS,
  cacheMaxBytes: PROJECT_SNAPSHOT_CACHE_MAX_BYTES,
  cacheIdleMs: CACHE_IDLE_MS,
  ttlMs: Number(process.env.CODE_ORACLE_EPOCH_TTL_MS ?? 0),
});

export async function projectSnapshot(root: string): Promise<ProjectSnapshot> {
  return projectSnapshots.snapshot(root);
}

export { scanProjectEpoch };
type LexState =
  | 'code'
  | 'line-comment'
  | 'block-comment'
  | 'single-quote'
  | 'double-quote'
  | 'template';

type StaticHintVisitor = (
  name: string,
  kind: StaticInstantiationHint['kind'],
  line: number,
  previewStart: number,
  previewEnd: number,
) => void;

function visitStaticInstantiationHints(
  text: string,
  visit: StaticHintVisitor,
): void {
  const qualifiedName = '[A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)*';
  const pattern = new RegExp(
    `\\b(?:new\\s+(${qualifiedName})|useClass\\s*:\\s*(${qualifiedName}))`,
    'g',
  );
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
        if (char === '/' && next === '/') {
          state = 'line-comment';
          cursor += 2;
          continue;
        }
        if (char === '/' && next === '*') {
          state = 'block-comment';
          cursor += 2;
          continue;
        }
        if (char === "'") state = 'single-quote';
        else if (char === '"') state = 'double-quote';
        else if (char === '`') state = 'template';
      } else if (state === 'line-comment') {
        if (char === '\n') state = 'code';
      } else if (state === 'block-comment') {
        if (char === '*' && next === '/') {
          state = 'code';
          cursor += 2;
          continue;
        }
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
        if (
          (state === 'single-quote' && char === "'") ||
          (state === 'double-quote' && char === '"') ||
          (state === 'template' && char === '`')
        ) {
          state = 'code';
        }
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
        if (
          code !== TAB_CODE &&
          code !== CARRIAGE_RETURN_BYTE &&
          code !== SPACE_CODE
        ) {
          break;
        }
        linePreviewStart++;
      }
    }
    visit(
      qualified.slice(qualified.lastIndexOf('.') + 1),
      match[1] ? 'constructor' : 'di-use-class',
      line,
      linePreviewStart,
      Math.min(lineEnd, linePreviewStart + SOURCE_PREVIEW_LENGTH),
    );
  }
}

/** Cheap, conservative source hints for implementation ranking. These are not
 * runtime observations: dead code and same-name classes can still produce a
 * hint, so callers must never use them to remove possible implementations. */
export function scanStaticInstantiationHints(
  text: string,
  file: string,
): StaticInstantiationHint[] {
  const hints: StaticInstantiationHint[] = [];
  visitStaticInstantiationHints(
    text,
    (name, kind, line, previewStart, previewEnd) => {
      hints.push({
        name,
        kind,
        file,
        line,
        preview: text.slice(previewStart, previewEnd).trimEnd(),
      });
    },
  );
  return hints;
}

type InstantiationIndex = Map<string, StaticInstantiationHint[]>;
const STATIC_HINTS_PER_NAME = 3;
// Bounds simultaneously resident source buffers, not files scanned or results.
const INSTANTIATION_SCAN_WORKERS = 8;
const instantiationCache = new ByteLru<
  string,
  { epoch: Epoch; index: InstantiationIndex }
>(INSTANTIATION_CACHE_MAX_BYTES, CACHE_IDLE_MS);
const instantiationFlights = new Map<
  string,
  AbortableFlight<InstantiationIndex>
>();

async function scanInstantiationIndex(
  root: string,
  snapshot: ProjectSnapshot,
  signal?: AbortSignal,
): Promise<InstantiationIndex> {
  signal?.throwIfAborted();
  const files = [...snapshot.files]
    .filter(([, info]) => info.kind === 'ts')
    .map(([path]) => path);
  const index: InstantiationIndex = new Map();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      signal?.throwIfAborted();
      const path = files[cursor++];
      let text: string;
      try {
        text = await readFileAsync(path, { encoding: 'utf8', signal });
      } catch {
        signal?.throwIfAborted();
        continue;
      }
      const rel = relative(root, path).replace(/\\/g, '/');
      visitStaticInstantiationHints(
        text,
        (name, kind, line, previewStart, previewEnd) => {
          const signals = index.get(name);
          if (signals && signals.length >= STATIC_HINTS_PER_NAME) return;
          const hint = {
            name,
            kind,
            file: rel,
            line,
            preview: text.slice(previewStart, previewEnd).trimEnd(),
          };
          if (!signals) index.set(name, [hint]);
          else signals.push(hint);
        },
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(INSTANTIATION_SCAN_WORKERS, files.length) },
      worker,
    ),
  );
  signal?.throwIfAborted();
  return index;
}

function instantiationIndexBytes(
  root: string,
  index: InstantiationIndex,
): number {
  let bytes = Buffer.byteLength(root) + CACHE_ENTRY_OVERHEAD_BYTES;
  for (const [name, hints] of index) {
    bytes += Buffer.byteLength(name) + CACHE_ENTRY_OVERHEAD_BYTES;
    for (const hint of hints) {
      bytes +=
        Buffer.byteLength(hint.file) +
        Buffer.byteLength(hint.kind) +
        Buffer.byteLength(hint.preview) +
        NUMBER_STORAGE_BYTES +
        CACHE_ENTRY_OVERHEAD_BYTES;
    }
  }
  return bytes;
}

function instantiationIndexFor(
  root: string,
  snapshot: ProjectSnapshot,
): Promise<InstantiationIndex> {
  const cached = instantiationCache.get(root);
  if (cached?.epoch === snapshot.epoch) {
    return Promise.resolve(cached.index);
  }
  const flightKey = `${root}\0${snapshot.epoch}`;
  const active = instantiationFlights.get(flightKey);
  if (active) return active.promise;
  const controller = new AbortController();
  const flight = scanInstantiationIndex(root, snapshot, controller.signal)
    .then((index) => {
      controller.signal.throwIfAborted();
      if (!stopping) {
        instantiationCache.set(
          root,
          { epoch: snapshot.epoch, index },
          instantiationIndexBytes(root, index),
        );
      }
      return index;
    })
    .finally(() => {
      if (instantiationFlights.get(flightKey)?.promise === flight) {
        instantiationFlights.delete(flightKey);
      }
    });
  instantiationFlights.set(flightKey, { controller, promise: flight });
  return flight;
}

const resultCache = new ResultCacheStore({
  directory: join(HERE, '.cache'),
  schema: RESULT_SCHEMA,
  maxBytes: RESULT_CACHE_MAX_BYTES,
  idleMs: CACHE_IDLE_MS,
  persistDelayMs: CACHE_PERSIST_DELAY_MS,
});

function invalidateCallerZerosProvedByDefinition(
  root: string,
  epoch: string,
  result: CachedOracleResult,
): void {
  if (result.tool !== 'definition' || result.count === 0) return;
  const targets = new Set<string>();
  for (const target of result.results) {
    if (typeof target.file !== 'string' || typeof target.line !== 'number') {
      continue;
    }
    const targetLine = target.line - 1;
    if (
      target.file === result.symbol.file &&
      targetLine === result.symbol.position.line
    ) {
      continue;
    }
    targets.add(`${target.file}\0${targetLine}`);
  }
  if (targets.size === 0) return;
  resultCache.invalidateWhere(
    root,
    epoch,
    (cached) =>
      cached.tool === 'callers' &&
      cached.count === 0 &&
      targets.has(`${cached.symbol.file}\0${cached.symbol.position.line}`),
  );
}
const sourceLines = new SourceLineCache(
  SOURCE_LINE_CACHE_MAX_BYTES,
  CACHE_IDLE_MS,
  SOURCE_PREVIEW_LENGTH,
);
const METHOD = {
  callers: 'textDocument/references',
  definition: 'textDocument/definition',
  implementations: 'textDocument/implementation',
} as const;
type ToolName = keyof typeof METHOD;
function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && Object.hasOwn(METHOD, value);
}
const queryFlights = new Map<string, Promise<unknown>>();
// `ENGINE` is substituted with the actual backend (tsgo for TS/JS, ty for Python) per query.
const NOTE: Record<ToolName, string> = {
  callers:
    'Type-aware callers via ENGINE references (checker grade; resolves through interfaces / standard DI). Truly dynamic dispatch (Proxy, obj[k](), token-only DI) stays invisible — a residual for the agent to read.',
  definition:
    'Type-aware definition(s) via ENGINE — where this symbol/expression actually resolves (the precise callee), not a name guess.',
  implementations:
    'Implementations via ENGINE (type-aware CHA) — results remain the sound over-approximate blast-radius set. Static construction hints rank likely entries but never remove possible ones and are not runtime observations.',
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
  basis?: 'static-import-call';
};

function parseQueryArgs(
  tool: ToolName,
  args: Record<string, unknown>,
): ParsedQueryArgs | { error: string } {
  if (typeof args.file !== 'string' || !args.file.trim()) {
    return {
      error: `${tool} needs \`file\` as a non-empty string (and \`name\` or line/character).`,
    };
  }
  const fileInput = toHostPath(args.file.trim());
  let rootInput: string | null = null;
  if (args.root !== undefined) {
    if (typeof args.root !== 'string' || !args.root.trim()) {
      return { error: '`root` must be a non-empty string when provided.' };
    }
    rootInput = toHostPath(args.root.trim());
  }
  let name: string | null = null;
  if (args.name !== undefined) {
    if (typeof args.name !== 'string' || !args.name.trim()) {
      return { error: '`name` must be a non-empty string when provided.' };
    }
    name = args.name.trim();
  }
  if (args.evidence !== undefined && typeof args.evidence !== 'boolean') {
    return { error: '`evidence` must be a boolean when provided.' };
  }
  const hasLine = args.line !== undefined;
  const hasCharacter = args.character !== undefined;
  if (hasLine !== hasCharacter) {
    return { error: '`line` and `character` must be provided together.' };
  }
  let explicit: Position | null = null;
  if (hasLine && hasCharacter) {
    const line = args.line;
    const character = args.character;
    if (
      typeof line !== 'number' ||
      !Number.isSafeInteger(line) ||
      line < 0 ||
      typeof character !== 'number' ||
      !Number.isSafeInteger(character) ||
      character < 0
    ) {
      return {
        error: '`line` and `character` must be non-negative safe integers.',
      };
    }
    explicit = { line, character };
  }
  if (!explicit && !name) {
    return { error: `${tool} needs \`name\` or line/character.` };
  }
  return { fileInput, rootInput, name, explicit, evidence: args.evidence };
}

interface QueryScope {
  file: string;
  root: string;
  relFile: string;
}

function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isContainedPath(root: string, file: string): boolean {
  const path = relative(root, file);
  return !(
    path === '..' ||
    path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(path)
  );
}

function resolveQueryScope(
  fileInput: string,
  rootInput: string | null,
  lang: Lang,
): QueryScope | { error: string } {
  if (rootInput !== null && !isAbsolute(rootInput)) {
    return { error: '`root` must be an absolute path.' };
  }
  if (!isAbsolute(fileInput) && rootInput === null) {
    return { error: '`file` must be absolute when `root` is omitted.' };
  }
  const requestedRoot = rootInput === null ? null : resolve(rootInput);
  const requestedFile = isAbsolute(fileInput)
    ? resolve(fileInput)
    : resolve(requestedRoot!, fileInput);
  let file: string;
  let root: string;
  try {
    file = realpathSync(requestedFile);
    if (!statSync(file).isFile()) return { error: `not a file: ${file}` };
    root = realpathSync(requestedRoot ?? projectRoot(file, lang));
    if (!statSync(root).isDirectory()) {
      return { error: `not a directory: ${root}` };
    }
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : 'unknown path error';
    return { error: `could not resolve Oracle file/root: ${detail}` };
  }
  if (!isContainedPath(root, file)) {
    return { error: `file escapes root after realpath resolution: ${file}` };
  }
  if (process.env.CODE_ORACLE_ALLOW_BROAD_ROOT !== '1') {
    let home: string | null = null;
    try {
      home = comparablePath(realpathSync(homedir()));
    } catch {
      /* an unavailable home path cannot be selected as a root */
    }
    const rootKey = comparablePath(root);
    const volumeRoot = comparablePath(parsePath(root).root);
    if (rootKey === volumeRoot || (home !== null && rootKey === home)) {
      return {
        error:
          'refusing a volume/home root; set CODE_ORACLE_ALLOW_BROAD_ROOT=1 only for an intentional broad scan.',
      };
    }
  }
  return {
    file,
    root,
    relFile: relative(root, file).replace(/\\/g, '/'),
  };
}

async function resolveQueryPosition(
  session: LspSession,
  file: string,
  relFile: string,
  name: string | null,
  explicit: Position | null,
): Promise<
  | { position: Position }
  | {
      error: string;
      candidates?: { name: string; line: number; character: number }[];
    }
> {
  if (explicit) return { position: explicit };
  if (!name) {
    return {
      error: `could not locate an unnamed symbol in ${relFile}; pass line/character.`,
    };
  }
  const resolved = await session.documentSymbolPosition(file, name);
  if (resolved && 'ambiguous' in resolved) {
    const candidates = resolved.ambiguous.map((candidate) => ({
      name: candidate.container
        ? `${candidate.container}.${candidate.name}`
        : candidate.name,
      line: candidate.line,
      character: candidate.character,
    }));
    return {
      error: `"${name}" matches ${candidates.length} declarations in ${relFile}. Re-query with a qualified name (Container.name) or line/character (0-based).`,
      candidates,
    };
  }
  const position = resolved ?? findPosition(file, name);
  return position
    ? { position }
    : {
        error: `could not locate symbol "${name}" in ${relFile}; pass line/character.`,
      };
}

async function collectLocations(
  session: LspSession,
  method: string,
  file: string,
  position: Position,
  name: string | null,
  root: string,
  snapshot: ProjectSnapshot,
  epoch: Epoch,
): Promise<{
  located: LocatedResult[];
  staticFallbackApplied: boolean;
  staticSupplementCount: number;
  staticDegradation: { failureCount: number; examples: string[] } | null;
  invalidLocationCount: number;
  invalidLocationExamples: string[];
  previewFailureCount: number;
  previewFailureExamples: string[];
}> {
  const staticPromise: Promise<{
    applied: boolean;
    locations: OracleLocation[];
    degradation: { failureCount: number; examples: string[] } | null;
  }> =
    method === 'textDocument/references'
      ? session.inferredStaticCallers(file, name)
      : Promise.resolve({
          applied: false,
          locations: [],
          degradation: null,
        });
  const [checkerLocations, staticCallers] = await Promise.all([
    session.locate(method, file, position.line, position.character),
    staticPromise,
  ]);
  const locations = [...checkerLocations, ...staticCallers.locations];
  const seen = new Set<string>();
  const located: LocatedResult[] = [];
  let staticSupplementCount = 0;
  let invalidLocationCount = 0;
  const invalidLocationExamples: string[] = [];
  let previewFailureCount = 0;
  const previewFailureExamples: string[] = [];
  for (const location of locations) {
    let absoluteFile: string;
    try {
      absoluteFile = fileURLToPath(location.uri);
    } catch {
      invalidLocationCount++;
      if (invalidLocationExamples.length < MAX_QUERY_DEGRADATION_EXAMPLES) {
        invalidLocationExamples.push(location.uri);
      }
      continue;
    }
    const dedupeKey = `${absoluteFile}\t${location.line}\t${location.character}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (location.basis) staticSupplementCount++;
    const previewToken = snapshot.files.get(absoluteFile)?.signature ?? epoch;
    const preview = sourceLines.lineResult(
      absoluteFile,
      location.line,
      previewToken,
    );
    if (preview.readError) {
      previewFailureCount++;
      if (previewFailureExamples.length < MAX_QUERY_DEGRADATION_EXAMPLES) {
        previewFailureExamples.push(`${absoluteFile}: ${preview.readError}`);
      }
    }
    located.push({
      absoluteFile,
      line0: location.line,
      character: location.character,
      file: relative(root, absoluteFile).replace(/\\/g, '/'),
      line: location.line + 1,
      preview: preview.preview,
      ...(location.basis ? { basis: location.basis } : {}),
    });
  }
  located.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.character - b.character,
  );
  return {
    located,
    staticFallbackApplied: staticCallers.applied,
    staticSupplementCount,
    staticDegradation: staticCallers.degradation,
    invalidLocationCount,
    invalidLocationExamples,
    previewFailureCount,
    previewFailureExamples,
  };
}

async function formatQueryResults(
  tool: ToolName,
  lang: Lang,
  session: LspSession,
  located: LocatedResult[],
  name: string | null,
  instantiationPromise: Promise<InstantiationIndex> | null,
): Promise<{
  out: Record<string, unknown>[];
  implementationEvidence?: Record<string, unknown>;
}> {
  const relevantLocations =
    tool === 'callers'
      ? located.filter((result) => !isImportLine(result.preview))
      : located;
  const sharesSourceLine = (index: number): boolean => {
    const current = relevantLocations[index];
    const previous = relevantLocations[index - 1];
    const next = relevantLocations[index + 1];
    return (
      (previous?.file === current.file && previous.line === current.line) ||
      (next?.file === current.file && next.line === current.line)
    );
  };
  if (instantiationPromise) {
    const files = [
      ...new Set(relevantLocations.map((result) => result.absoluteFile)),
    ];
    const [symbolsByFile, instantiations] = await Promise.all([
      documentSymbolsByFile(session, files),
      instantiationPromise,
    ]);
    let likelyCount = 0;
    const out = relevantLocations.map((result, index) => {
      const container = implementationOwner(
        symbolsByFile.get(result.absoluteFile) ?? [],
        result.line0,
        result.character,
        name ?? undefined,
      );
      const signals = container ? (instantiations.get(container) ?? []) : [];
      const likelihood = signals.length ? 'likely' : 'possible';
      if (likelihood === 'likely') likelyCount++;
      const formatted: Record<string, unknown> = {
        file: result.file,
        line: result.line,
        preview: result.preview,
        container,
        likelihood,
      };
      if (sharesSourceLine(index)) formatted.character = result.character;
      if (result.basis) formatted.basis = result.basis;
      if (signals.length) {
        formatted.staticEvidence = signals.map((signal) => ({
          kind: signal.kind,
          file: signal.file,
          line: signal.line,
          preview: signal.preview,
        }));
      }
      return formatted;
    });
    return {
      out,
      implementationEvidence: {
        basis: 'static-source-hints',
        runtimeObserved: false,
        possibleCount: out.length,
        likelyCount,
        caveat:
          'Ranking only: lexical `new`/`useClass` source hints can be false positives, occur in dead code, or collide by class name. Every checker result remains in `results`.',
      },
    };
  }

  const out = relevantLocations.map((result, index) => {
    const formatted: Record<string, unknown> = {
      file: result.file,
      line: result.line,
      preview: result.preview,
    };
    if (sharesSourceLine(index)) formatted.character = result.character;
    if (result.basis) formatted.basis = result.basis;
    return formatted;
  });
  if (tool !== 'implementations') return { out };
  return {
    out,
    implementationEvidence: {
      basis:
        lang === 'py' ? 'unavailable-for-lower-bound-backend' : 'not-requested',
      runtimeObserved: false,
      possibleCount: out.length,
      likelyCount: 0,
      caveat: 'No implementation was filtered; `results` is the possible set.',
    },
  };
}

/** One query path for all three tools: resolve a position, gate on the cache, else
 * ask the warm tsgo session (references / definition / implementation), format. */
async function query(
  tool: ToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  const parsed = parseQueryArgs(tool, args);
  if ('error' in parsed) return parsed;
  const { fileInput, rootInput, name, explicit, evidence } = parsed;
  const requestedFile = isAbsolute(fileInput)
    ? fileInput
    : resolve(rootInput ?? process.cwd(), fileInput);
  const lang = langOf(requestedFile);
  if (!lang) {
    return {
      error: `unsupported file type: ${requestedFile} (expected TS/JS or Python).`,
    };
  }
  const scope = resolveQueryScope(fileInput, rootInput, lang);
  if ('error' in scope) return scope;
  const { file, root, relFile } = scope;
  const be = backend(lang);
  if (!be) {
    return {
      error:
        lang === 'ts'
          ? 'tsgo not found — set TSGO_BIN or `npm install` in code-oracle/.'
          : 'ty not found — install ty or uvx, or set TY_CMD.',
    };
  }

  const includeImplementationEvidence =
    tool === 'implementations' && lang === 'ts' && evidence !== false;
  const evidenceVariant =
    tool === 'implementations'
      ? `:${includeImplementationEvidence ? 'e1' : 'e0'}`
      : '';
  const cacheKey = `v${RESULT_SCHEMA}:${tool}:${relFile}#${name ?? `${explicit!.line}:${explicit!.character}`}${evidenceVariant}`;

  // Cache gate: serve instantly (no LSP warmup) when the project hasn't changed.
  const snapshot = await projectSnapshot(root);
  const epoch = snapshot.epoch;
  if (!snapshot.degradation) {
    resultCache.promoteStaged(root, epoch, snapshot.scanSerial);
    const cached = resultCache.lookup(root, epoch, cacheKey);
    if (cached.hit) {
      invalidateCallerZerosProvedByDefinition(root, epoch, cached.value);
      return { ...cached.value, cached: true };
    }
  }

  const scanHealth = snapshot.degradation
    ? `degraded:${snapshot.degradation.failureCount}`
    : 'clean';
  const flightKey = `${root}\0${epoch}\0${scanHealth}\0${cacheKey}`;
  const active = queryFlights.get(flightKey);
  if (active) return active;

  // Resolve the symbol position. Explicit coords win; otherwise anchor on the DECLARATION
  // via the LSP's documentSymbol (skips comments/strings/imports), falling back to the
  // comment-skipping text scan only if the LSP doesn't know the name.
  const run = async (): Promise<unknown> => {
    const lease = await checkerSessions.acquire(root, lang, be, snapshot);
    let document: { release: () => void } | null = null;
    try {
      const sess = lease.session;
      document = await sess.openDocument(file);
      const positionResult = await resolveQueryPosition(
        sess,
        file,
        relFile,
        name,
        explicit,
      );
      if ('error' in positionResult) return positionResult;
      const pos = positionResult.position;

      // The optional evidence scan is pure filesystem work; overlap it with the
      // checker request so it does not add another serial warmup phase.
      const instantiationPromise = includeImplementationEvidence
        ? instantiationIndexFor(root, snapshot)
        : null;
      const collected = await collectLocations(
        sess,
        METHOD[tool],
        file,
        pos,
        name,
        root,
        snapshot,
        epoch,
      );
      const { out, implementationEvidence } = await formatQueryResults(
        tool,
        lang,
        sess,
        collected.located,
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
      const pyRefsCaveat =
        lang === 'py' && (tool === 'callers' || tool === 'implementations');
      const staticFallback = collected.staticFallbackApplied;
      const hasDegradation =
        snapshot.degradation !== null ||
        collected.staticDegradation !== null ||
        collected.invalidLocationCount > 0 ||
        collected.previewFailureCount > 0;
      const degradation = {
        ...(snapshot.degradation ? { projectScan: snapshot.degradation } : {}),
        ...(collected.staticDegradation
          ? { staticSupplement: collected.staticDegradation }
          : {}),
        ...(collected.invalidLocationCount
          ? {
              invalidLocations: {
                failureCount: collected.invalidLocationCount,
                examples: collected.invalidLocationExamples,
              },
            }
          : {}),
        ...(collected.previewFailureCount
          ? {
              sourcePreviews: {
                failureCount: collected.previewFailureCount,
                examples: collected.previewFailureExamples,
              },
            }
          : {}),
      };
      let note = base;
      if (pyRefsCaveat) {
        note +=
          ' ⚠ Python (ty 0.0.50): find-references is INTRA-FILE ONLY here — cross-file callers are NOT found (verified). Treat as a LOWER BOUND / intra-file screen, NOT a complete blast radius. `definition` does resolve cross-file.';
      } else if (staticFallback) {
        note +=
          ' This config-less TS/JS project also uses a literal reverse-import scan so unopened static import/call sites are not silently lost. Those sites are labeled `basis: static-import-call`; lexical shadowing can over-approximate, while computed imports, workspace package aliases, and nonstandard CommonJS aliasing remain residuals.';
      }
      if (hasDegradation) {
        note +=
          ' ⚠ One or more project evidence reads failed. Treat project-scoped absence and counts as incomplete; inspect `degradation` for bounded examples.';
      }
      const coverage: OracleCoverage = staticFallback
        ? {
            kind: 'checker-plus-static',
            scope: 'project',
            residuals: [
              'lexical-shadowing',
              'workspace-package-aliasing',
              'nonstandard-commonjs-aliasing',
              ...DYNAMIC_RESIDUALS,
            ],
          }
        : coverageFor(tool, lang);
      const result: CachedOracleResult = {
        tool,
        symbol: { file: relFile, name, position: pos },
        root,
        results: out,
        count: out.length,
        cached: false,
        coverage,
        note,
        ...(staticFallback
          ? {
              staticSupplement: {
                basis: 'literal-reverse-import-call-scan',
                count: collected.staticSupplementCount,
              },
            }
          : {}),
        ...(implementationEvidence ? { implementationEvidence } : {}),
        ...(hasDegradation ? { degradation } : {}),
        ...(pyRefsCaveat || hasDegradation ? { incomplete: true } : {}),
      };
      invalidateCallerZerosProvedByDefinition(root, epoch, result);
      // A checker zero can mean "not indexed yet", not "proven absent".
      // Empty responses are therefore not cacheable evidence.
      if (!hasDegradation && result.count > 0) {
        resultCache.stage(
          root,
          epoch,
          cacheKey,
          result,
          projectSnapshots.nextValidationSerial(root),
        );
      }
      return result;
    } finally {
      document?.release();
      lease.release();
    }
  };

  const flight: Promise<unknown> = run().finally(() => {
    if (queryFlights.get(flightKey) === flight) queryFlights.delete(flightKey);
  });
  queryFlights.set(flightKey, flight);
  return flight;
}

// ── MCP server (newline-delimited JSON-RPC over stdio, like code-map) ──
const INPUT = {
  type: 'object',
  properties: {
    file: {
      type: 'string',
      description: 'Source file (absolute, or relative to root/cwd).',
    },
    name: {
      type: 'string',
      description:
        'Symbol name, resolved to its DECLARATION via the language server (comments/strings/imports are skipped). Accepts a qualified "Container.name" (e.g. "RunChannelClient.send"). If a bare name matches declarations in more than one container (e.g. an interface method and a same-named class method), the tool returns the candidates instead of guessing — re-query with the qualified name or line/character.',
    },
    line: {
      type: 'number',
      description: 'Optional 0-based line of the symbol (use with character).',
    },
    character: {
      type: 'number',
      description: 'Optional 0-based column of the symbol.',
    },
    root: {
      type: 'string',
      description:
        'Optional project root; default = nearest ancestor tsconfig.json.',
    },
    evidence: {
      type: 'boolean',
      description:
        'For TypeScript/JavaScript implementations, attach bounded static instantiation hints and likely/possible ranking. Defaults to true; false skips that optional project scan. Results are never filtered.',
    },
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
    description:
      'Type-aware definition(s) of the symbol/expression at a location — where `obj.m()` actually resolves (the precise callee). Not a name guess. (tsgo for TS/JS, ty for Python.)',
    inputSchema: INPUT,
  },
  {
    name: 'implementations',
    description:
      'Implementations of an interface/abstract method — the concrete classes/methods behind it (type-aware Class Hierarchy Analysis). `results` always remains the sound over-approximate blast-radius set. For TS/JS, bounded static `new`/`useClass` hints rank entries as likely/possible without filtering; `implementationEvidence.runtimeObserved` stays false. Python is explicitly a lower bound. (tsgo for TS/JS, ty for Python.)',
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
        const onDrain = (): void => {
          cleanup();
          resolveDrain();
        };
        const onError = (error: Error): void => {
          cleanup();
          rejectDrain(error);
        };
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
  const id: RpcId | undefined =
    rawId === null || typeof rawId === 'string' || typeof rawId === 'number'
      ? rawId
      : undefined;
  const method = typeof req.method === 'string' ? req.method : undefined;
  const params = isObjectRecord(req.params) ? req.params : null;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': {
        await send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'code-oracle', version: ORACLE_VERSION },
            runtime: oracleRuntimeDiagnostics(),
          },
        });
        return;
      }
      case 'tools/list':
        await send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        return;
      case 'tools/call': {
        const tool = params?.name;
        if (!isToolName(tool)) throw new Error(`unknown tool: ${String(tool)}`);
        const argumentsValue = params?.arguments;
        if (argumentsValue !== undefined && !isObjectRecord(argumentsValue)) {
          throw new Error('tool `arguments` must be an object.');
        }
        const result = await query(tool, argumentsValue ?? {});
        await send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        });
        return;
      }
      case 'ping':
        await send({
          jsonrpc: '2.0',
          id,
          result: { runtime: oracleRuntimeDiagnostics() },
        });
        return;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case undefined:
        if (isRequest) {
          await send({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32600,
              message: 'invalid request: method is required',
            },
          });
        }
        return;
      default:
        if (isRequest) {
          await send({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `method not found: ${method}` },
          });
        }
        return;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown internal error';
    if (isRequest) {
      await send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message,
          ...(e instanceof LspResponseError
            ? { data: { lspCode: e.code, lspData: e.data } }
            : {}),
        },
      });
    }
  }
}

// ── opt-in pre-warm: lazy startup avoids spawning an unused checker per MCP client ──
/** Optionally pre-warm the working project at startup. Lazy startup is the safe
 * default; set CODE_ORACLE_PREWARM=1 when paying the memory cost up front is useful. */
async function prewarm(): Promise<void> {
  if (process.env.CODE_ORACLE_PREWARM !== '1' || stopping) return;
  const root = process.env.CODE_ORACLE_ROOT
    ? resolve(process.env.CODE_ORACLE_ROOT)
    : process.cwd();
  const langs: Lang[] = [];
  if (existsSync(join(root, 'tsconfig.json'))) langs.push('ts');
  if (
    ['pyproject.toml', 'setup.py', 'setup.cfg'].some((m) =>
      existsSync(join(root, m)),
    )
  ) {
    langs.push('py');
  }
  for (const lang of langs) {
    if (stopping) return;
    const be = backend(lang);
    if (!be) {
      process.stderr.write(
        `code-oracle: ${lang} project at ${root} but its tool isn't installed — pre-warm skipped\n`,
      );
      continue;
    }
    const seed = await firstSourceFile(root, lang, PREWARM_SCAN_LIMIT);
    if (!seed || stopping) continue;
    process.stderr.write(
      `code-oracle: warming the ${lang} oracle for ${root} (~10-20s; queries wait until ready)…\n`,
    );
    const started = Date.now();
    const snapshot = await projectSnapshot(root);
    if (stopping) return;
    const lease = await checkerSessions.acquire(root, lang, be, snapshot);
    try {
      await lease.session.prewarm(seed);
      if (!stopping) {
        process.stderr.write(
          `code-oracle: ${lang} oracle ready in ${Math.round((Date.now() - started) / SECOND_MS)}s\n`,
        );
      }
    } finally {
      lease.release();
    }
  }
}

function main(): void {
  if (!backend('ts')) {
    process.stderr.write(
      'code-oracle: tsgo not found — set TSGO_BIN or `npm install` in code-oracle/. (Python uses ty via uvx / TY_CMD.) Tools error per-language until present.\n',
    );
  }
  const decoder = new NdjsonDecoder(MAX_NDJSON_LINE_BYTES);
  const input = process.stdin;
  const pendingRequests = new Map<number, UnknownRecord>();
  let nextQueuedRequestId = 1;
  const updateQueuedMetrics = (): void => {
    queuedMcpRequests = pendingRequests.size;
    maxObservedQueuedMcpRequests = Math.max(
      maxObservedQueuedMcpRequests,
      queuedMcpRequests,
    );
  };
  function settleRequest(): void {
    activeMcpRequests--;
    drainRequests();
  }
  function drainRequests(): void {
    if (stopping) return;
    while (
      !stopping &&
      activeMcpRequests < MAX_INFLIGHT_REQUESTS &&
      pendingRequests.size > 0
    ) {
      const next = pendingRequests.entries().next();
      if (next.done) break;
      const [queuedId, request] = next.value;
      pendingRequests.delete(queuedId);
      updateQueuedMetrics();
      activeMcpRequests++;
      maxObservedMcpRequests = Math.max(
        maxObservedMcpRequests,
        activeMcpRequests,
      );
      void handle(request).finally(settleRequest);
    }
    if (
      !stopping &&
      activeMcpRequests < MAX_INFLIGHT_REQUESTS &&
      pendingRequests.size === 0
    ) {
      input.resume();
    } else {
      input.pause();
    }
  }
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    input.pause();
    pendingRequests.clear();
    updateQueuedMetrics();
    disposeAll();
    process.exitCode = 0;
  };
  const sendProtocolError = (code: number, message: string): void => {
    void send({ jsonrpc: '2.0', id: null, error: { code, message } });
  };
  const acceptEvent = (event: NdjsonEvent): void => {
    if (stopping) return;
    if (event.kind === 'oversized') {
      sendProtocolError(
        -32600,
        `request line exceeds ${MAX_NDJSON_LINE_BYTES} bytes`,
      );
      return;
    }
    const t = event.text.trim();
    if (!t) return;
    let req: unknown;
    try {
      req = JSON.parse(t);
    } catch {
      sendProtocolError(-32700, 'parse error');
      return;
    }
    if (!isObjectRecord(req)) {
      sendProtocolError(-32600, 'invalid request');
      return;
    }
    pendingRequests.set(nextQueuedRequestId++, req);
    updateQueuedMetrics();
    drainRequests();
  };
  input.on('data', (chunk: Buffer) => {
    for (const event of decoder.push(chunk)) acceptEvent(event);
  });
  input.once('end', () => {
    for (const event of decoder.finish()) acceptEvent(event);
    shutdown();
  });
  input.once('close', shutdown); // stdin EOF is the MCP client's lifecycle boundary
  input.once('error', shutdown);
  process.stdout.once('error', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.once('exit', disposeAll);
  void prewarm().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : 'unknown error';
    if (!stopping) {
      process.stderr.write(`code-oracle: pre-warm failed: ${detail}\n`);
    }
  });
}

let isEntry = false;
try {
  isEntry =
    !!process.argv[1] &&
    (await import('node:fs')).realpathSync(process.argv[1]) ===
      fileURLToPath(import.meta.url);
} catch {
  /* imported */
}
if (isEntry) main();

/** Kill every warm LSP session — tests must call this or the live tsgo/ty child
 * keeps the process alive. */
export function disposeAll(): void {
  const shutdownError = new Error('code-oracle is shutting down.');
  projectSnapshots.dispose(shutdownError);
  for (const flight of instantiationFlights.values()) {
    flight.controller.abort(shutdownError);
  }
  checkerSessions.dispose(shutdownError);
  resultCache.dispose();
  instantiationCache.clear();
  instantiationFlights.clear();
  queryFlights.clear();
  sourceLines.clear();
}

export { query, TOOLS };
