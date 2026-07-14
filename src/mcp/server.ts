#!/usr/bin/env node
/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), zero deps.
 *
 * It exposes ONE tool — `read` — and nothing else: given a symbol id or a bare
 * name, it returns the RAW source slice (the symbol's own bytes, not the whole
 * file), drift-resistant (re-anchors when the file moved). Coordinates, never
 * meaning — the model does the interpreting. Search with your normal grep; this
 * just pulls the exact slice cheaply.
 *
 *   MAP_INDEX=/path/.map-index.json  node src/mcp/server.ts
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { changed, read, readMany } from '../core/read.ts';
import { loadIndex, prepareLookup } from '../core/store.ts';
import type { MapIndex } from '../core/types.ts';
import { VERSION } from '../version.ts';

const PROTOCOL = '2025-06-18';
const SERVER_INSTRUCTIONS = [
  'ROUTING RULES: for indexed repos, do not read known symbol bodies with shell commands. If a file:line, symbol id, or path#name is known, call code-map read for source.',
  'Pass root as the absolute current repository directory on every read so a global server can select the right index. Windows C:\\... and WSL /mnt/c/... spellings are both accepted.',
  'code-map read resolves a bare name or path#name directly — for any symbol you can already name, call read; do NOT grep first to locate a name read can resolve (grepping to find a known symbol is a redundant double-call). Use shell search only to discover a name you do not know yet, then read the body — never grep/cat it.',
  'For two or more independent known refs, make one read call with refs: [...] before answering. Split only when a later ref depends on earlier output or the batch exceeds 64 refs.',
  'Never answer from index metadata alone; answer from raw code returned by read.',
].join(' ');

/** Walk up from `start` looking for `name`; null if never found. */
function findUp(name: string, start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, name))) return join(dir, name);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Default index location: explicit env/flag, else auto-detected by walking up
// from the server cwd. Per-call `root` selection overrides this default below.
const configuredIndexPath = process.env.MAP_INDEX ?? argIndex();
const MAX_INDEX_RUNTIMES = 8;

/** Resolve an explicit index, or discover the nearest one from `start`. Kept as
 * a function because an index may be created after the long-lived server starts. */
export function resolveIndexPath(start: string, explicit = configuredIndexPath): string {
  const hostStart = toHostPath(start);
  const hostExplicit = explicit ? toHostPath(explicit) : explicit;
  return hostExplicit ? resolve(hostStart, hostExplicit) : findUp('.map-index.json', hostStart) ?? resolve(hostStart, '.map-index.json');
}

/** Accept either side's spelling when a Windows-hosted server serves WSL (or a
 * WSL-hosted server receives a Windows path). Native Linux paths pass through. */
export function toHostPath(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const wsl = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(path);
    return wsl ? `${wsl[1].toUpperCase()}:\\${wsl[2].replace(/\//g, '\\')}` : path;
  }
  if (platform === 'linux') {
    const windows = /^([a-zA-Z]):[\\/](.*)$/.exec(path);
    return windows ? `/mnt/${windows[1].toLowerCase()}/${windows[2].replace(/\\/g, '/')}` : path;
  }
  return path;
}

interface IndexRuntime {
  index: MapIndex | null;
  mtimeMs: number;
  size: number;
  ctimeMs: number;
  ino: number;
}

// A global MCP can serve several workspaces. Keep the warmed lookup tables for
// the most recent few, but bound them so arbitrary roots cannot grow memory forever.
const indexRuntimes = new Map<string, IndexRuntime>();

function runtimeFor(indexPath: string): IndexRuntime {
  const cached = indexRuntimes.get(indexPath);
  if (cached) {
    indexRuntimes.delete(indexPath);
    indexRuntimes.set(indexPath, cached);
    return cached;
  }
  const runtime: IndexRuntime = { index: null, mtimeMs: 0, size: -1, ctimeMs: 0, ino: -1 };
  indexRuntimes.set(indexPath, runtime);
  if (indexRuntimes.size > MAX_INDEX_RUNTIMES) {
    const oldest = indexRuntimes.keys().next().value as string | undefined;
    if (oldest !== undefined) indexRuntimes.delete(oldest);
  }
  return runtime;
}

/**
 * (Re)load the index when its file appears or changes. Called before every tool
 * call, so a `map index` rebuild — or the first build in a fresh project — is
 * picked up with no client reconnect. A missing/half-written index is non-fatal:
 * the server stays up and retries on the next call.
 */
function ensureFresh(indexPath: string): IndexRuntime {
  const runtime = runtimeFor(indexPath);
  let mtimeMs: number;
  let size: number;
  let ctimeMs: number;
  let ino: number;
  try {
    const s = statSync(indexPath);
    mtimeMs = s.mtimeMs;
    size = s.size;
    ctimeMs = s.ctimeMs;
    ino = s.ino;
  } catch {
    return runtime; // no index yet (or mid-write) — keep the prior good copy, if any
  }
  // ctime/inode catch same-size rewrites with a restored/coarse mtime.
  if (runtime.index && mtimeMs === runtime.mtimeMs && size === runtime.size && ctimeMs === runtime.ctimeMs && ino === runtime.ino) return runtime;
  try {
    const loaded = loadIndex(indexPath);
    // The server is long-lived, so one O(entries) lookup build is amortized over
    // every later read. One-shot CLI commands deliberately skip this warm-up.
    prepareLookup(loaded);
    runtime.index = loaded;
    runtime.mtimeMs = mtimeMs;
    runtime.size = size;
    runtime.ctimeMs = ctimeMs;
    runtime.ino = ino;
    process.stderr.write(`code-map MCP: loaded index (${loaded.meta.entryCount} symbols) from ${indexPath}\n`);
  } catch {
    // half-written index — keep the prior good copy, retry on the next call
  }
  return runtime;
}

export const TOOLS = [
  {
    name: 'read',
    description:
      'Return the RAW source slice of a symbol — its own bytes (a function/method/class body), NOT the whole file, so it is token-efficient. Pass `root` as the indexed repository\'s absolute directory so one global MCP can serve multiple workspaces; Windows and WSL spellings are interchangeable. Pass a symbol id or a bare name / path-scoped name ("alias-map#buildAliasMap"); it resolves the name to one symbol internally. **Batch: pass `refs` (an array) to read several symbols in ONE call** — one round-trip instead of N, which cuts agent turns/latency. Batch only INDEPENDENT symbols whose refs you already know; use a single `ref` when a later read depends on what an earlier one shows (sequential reads preserve your chance to course-correct, and cost fewer tokens than loading everything at once). Pass `ref` OR `refs`, not both. Drift-resistant: if the file changed since indexing it re-anchors on the signature line and flags the result; if the anchor is lost it says so (re-index to refresh). Optionally pass `snippet` (text you quote from inside the symbol) to also get its exact char range(s) within the symbol — `aim.status:"ambiguous"` means the snippet occurs more than once, so do not target blindly. Coordinates, not meaning: read the raw and judge it yourself. (Search with your normal grep; use this to pull the slice(s) cheaply.)',
    annotations: {
      title: 'Read symbol source',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A symbol id, or a bare name / "path#name".' },
        refs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64, uniqueItems: true, description: 'Read several INDEPENDENT, already-known symbols in one call (ids or names). One result per ref. Use sequential single reads when later reads depend on earlier ones.' },
        changedOnly: { type: 'boolean', description: 'With `refs`: a working-set DELTA — return current slices only for symbols whose file changed since indexing, plus an `unchanged` id list. Refresh what you read earlier without re-paying tokens for the stable parts (a "git status" for your reads).' },
        snippet: { type: 'string', description: 'Optional: verbatim text from inside the symbol — resolved to exact char range(s). Applies when reading a single `ref`.' },
        root: { type: 'string', description: 'Absolute path to the indexed repository. Pass this on every call when the MCP server is global or starts outside the repo. Accepts native Windows/Linux paths and Windows↔WSL spellings.' },
      },
    },
  },
];

export function callTool(name: string, args: Record<string, unknown>): string {
  let indexPath: string;
  if (args.root !== undefined) {
    if (typeof args.root !== 'string' || !args.root.trim()) {
      return JSON.stringify({ error: '`root` must be a non-empty absolute repository path.' }, null, 2);
    }
    const root = toHostPath(args.root);
    if (!isAbsolute(root)) {
      return JSON.stringify({ error: '`root` must be absolute so a global MCP server does not resolve it against its own working directory.' }, null, 2);
    }
    indexPath = resolveIndexPath(root, '');
  } else {
    indexPath = resolveIndexPath(process.cwd());
  }
  const runtime = ensureFresh(indexPath);
  if (!runtime.index) {
    return JSON.stringify({ error: `No code-map index found at ${indexPath}. Run \`map index --root <repo>\`, then pass \`root\` as that repository's absolute path.` }, null, 2);
  }
  return dispatch(runtime.index, name, args);
}

function uniqueRefs(values: unknown[], max = 64): { refs: string[]; total: number } {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const value of values) {
    const ref = String(value);
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (refs.length < max) refs.push(ref);
  }
  return { refs, total: seen.size };
}

/** Pure tool dispatch over a given index — exported so the protocol layer can be
 * exercised in tests without a live stdio process. */
export function dispatch(index: MapIndex, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read': {
      const hasRefs = args.refs !== undefined;
      const hasRef = args.ref !== undefined;
      if (hasRefs && hasRef) return JSON.stringify({ error: 'Pass `ref` (single) OR `refs` (batch), not both.' }, null, 2);
      if (hasRefs) {
        if (!Array.isArray(args.refs) || args.refs.length === 0) return JSON.stringify({ error: '`refs` must be a non-empty array of symbol ids or names.' }, null, 2);
        // Working-set drift delta: of a set you read earlier, return current slices only for
        // the ones whose file changed since indexing — refresh the delta, not the whole set.
        if (args.changedOnly) {
          const { refs } = uniqueRefs(args.refs);
          return JSON.stringify(changed(index, refs));
        }
        // Batch: one round-trip for many symbols — same slices, fewer turns. Dedupe (keep
        // first occurrence) and cap so a stray huge array can't blow up the context window.
        const MAX = 64;
        const { refs, total } = uniqueRefs(args.refs, MAX);
        const out: Record<string, unknown> = { results: readMany(index, refs) };
        if (total > MAX) out.note = `Read first ${MAX} of ${total} refs; split the rest into another call.`;
        // Compact (no pretty-print indentation) — leaner in context than N single pretty reads.
        return JSON.stringify(out);
      }
      if (!hasRef) return JSON.stringify({ error: 'Pass `ref` (a symbol id or name) or `refs` (an array).' }, null, 2);
      return JSON.stringify(read(index, String(args.ref), { snippet: args.snippet ? String(args.snippet) : undefined }), null, 2);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown>; [k: string]: unknown };
}

function handle(req: JsonRpcRequest): void {
  const { id, method, params } = req;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'code-map', version: VERSION },
            instructions: SERVER_INSTRUCTIONS,
          },
        });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const text = callTool(String(params?.name ?? ''), params?.arguments ?? {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      }
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // notifications: no reply
      default:
        if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } });
  }
}

/** Start the stdio JSON-RPC loop — only when run as the entry point, so importing
 * this module (e.g. from tests) never consumes stdin or eagerly loads an index. */
function main(): void {
  const indexPath = resolveIndexPath(process.cwd());
  const runtime = ensureFresh(indexPath);
  if (!runtime.index) process.stderr.write(`code-map MCP: no index at ${indexPath} yet — pass \`root\` on read or run \`map index\`; tools will pick it up on the next call.\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      return;
    }
    handle(req);
  });
}

let isEntry = false;
try {
  isEntry = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  /* not resolvable (e.g. imported) — stay dormant */
}
if (isEntry) main();

function argIndex(): string | undefined {
  const i = process.argv.indexOf('--index');
  return i !== -1 ? process.argv[i + 1] : undefined;
}
