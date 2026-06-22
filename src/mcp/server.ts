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
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { changed, read } from '../core/read.ts';
import { loadIndex } from '../core/store.ts';
import type { MapIndex } from '../core/types.ts';

const PROTOCOL = '2025-06-18';
const SERVER_INSTRUCTIONS = [
  'ROUTING RULES: for indexed repos, do not read known symbol bodies with shell commands. If a file:line, symbol id, or path#name is known, call code-map read for source.',
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

// Index location, in order: explicit env/flag, else auto-detected by walking up
// from the working directory — so one global server serves whatever project it is
// launched in — else the cwd default. No absolute path is baked into any config.
const indexPath = process.env.MAP_INDEX ?? argIndex() ?? findUp('.map-index.json', process.cwd()) ?? resolve('.map-index.json');

let index: MapIndex | null = null;
let indexMtimeMs = 0;
let indexSize = -1;

/**
 * (Re)load the index when its file appears or changes. Called before every tool
 * call, so a `map index` rebuild — or the first build in a fresh project — is
 * picked up with no client reconnect. A missing/half-written index is non-fatal:
 * the server stays up and retries on the next call.
 */
function ensureFresh(): void {
  let mtimeMs: number;
  let size: number;
  try {
    const s = statSync(indexPath);
    mtimeMs = s.mtimeMs;
    size = s.size;
  } catch {
    return; // no index yet (or mid-write) — keep whatever we have (possibly none)
  }
  // mtime can be coarse on some mounts; size almost always shifts too, so check both.
  if (index && mtimeMs === indexMtimeMs && size === indexSize) return;
  try {
    index = loadIndex(indexPath);
    indexMtimeMs = mtimeMs;
    indexSize = size;
    process.stderr.write(`code-map MCP: loaded index (${index.meta.entryCount} symbols) from ${indexPath}\n`);
  } catch {
    // half-written index — keep the prior good copy, retry on the next call
  }
}

export const TOOLS = [
  {
    name: 'read',
    description:
      'Return the RAW source slice of a symbol — its own bytes (a function/method/class body), NOT the whole file, so it is token-efficient. Pass a symbol id or a bare name / path-scoped name ("alias-map#buildAliasMap"); it resolves the name to one symbol internally. **Batch: pass `refs` (an array) to read several symbols in ONE call** — one round-trip instead of N, which cuts agent turns/latency. Batch only INDEPENDENT symbols whose refs you already know; use a single `ref` when a later read depends on what an earlier one shows (sequential reads preserve your chance to course-correct, and cost fewer tokens than loading everything at once). Pass `ref` OR `refs`, not both. Drift-resistant: if the file changed since indexing it re-anchors on the signature line and flags the result; if the anchor is lost it says so (re-index to refresh). Optionally pass `snippet` (text you quote from inside the symbol) to also get its exact char range(s) within the symbol — `aim.status:"ambiguous"` means the snippet occurs more than once, so do not target blindly. Coordinates, not meaning: read the raw and judge it yourself. (Search with your normal grep; use this to pull the slice(s) cheaply.)',
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
      },
    },
  },
];

function callTool(name: string, args: Record<string, unknown>): string {
  ensureFresh();
  if (!index) {
    return JSON.stringify({ error: `No code-map index found at ${indexPath}. Run \`map index --root <repo>\` to build one; it will be picked up automatically.` }, null, 2);
  }
  return dispatch(index, name, args);
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
          const refs = [...new Set(args.refs.map((r: unknown) => String(r)))].slice(0, 256);
          return JSON.stringify(changed(index, refs));
        }
        // Batch: one round-trip for many symbols — same slices, fewer turns. Dedupe (keep
        // first occurrence) and cap so a stray huge array can't blow up the context window.
        const MAX = 64;
        const seen = new Set<string>();
        const uniq = args.refs.map((r: unknown) => String(r)).filter((r) => (seen.has(r) ? false : (seen.add(r), true)));
        const capped = uniq.slice(0, MAX);
        const out: Record<string, unknown> = { results: capped.map((r) => read(index, r, {})) };
        if (uniq.length > MAX) out.note = `Read first ${MAX} of ${uniq.length} refs; split the rest into another call.`;
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
            serverInfo: { name: 'code-map', version: '0.1.0' },
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
  ensureFresh();
  if (!index) process.stderr.write(`code-map MCP: no index at ${indexPath} yet — run \`map index\`; tools will pick it up on the next call.\n`);
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
