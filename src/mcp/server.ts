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
import { read } from '../core/read.ts';
import { loadIndex } from '../core/store.ts';
import type { MapIndex } from '../core/types.ts';

const PROTOCOL = '2025-06-18';

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
      'Return the RAW source slice of a symbol — its own bytes (a function/method/class body), NOT the whole file, so it is token-efficient. Pass a symbol id or a bare name / path-scoped name ("alias-map#buildAliasMap"); it resolves the name to one symbol internally. **Batch: pass `refs` (an array) to read MANY symbols in ONE call** — same cheap slices, but one round-trip instead of N (read everything you need up front). Drift-resistant: if the file changed since indexing it re-anchors on the signature line and flags the result; if the anchor is lost it says so (re-index to refresh). Optionally pass `snippet` (text you quote from inside the symbol) to also get its exact char range(s) within the symbol — `aim.status:"ambiguous"` means the snippet occurs more than once, so do not target blindly. Coordinates, not meaning: read the raw and judge it yourself. (Search with your normal grep; use this to pull the slice(s) cheaply.)',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A symbol id, or a bare name / "path#name".' },
        refs: { type: 'array', items: { type: 'string' }, description: 'Read several symbols in one call (ids or names). Returns one result per ref — prefer this over many single reads.' },
        snippet: { type: 'string', description: 'Optional: verbatim text from inside the symbol — resolved to exact char range(s). Applies when reading a single `ref`.' },
      },
    },
  },
];

function callTool(name: string, args: Record<string, any>): string {
  ensureFresh();
  if (!index) {
    return JSON.stringify({ error: `No code-map index found at ${indexPath}. Run \`map index --root <repo>\` to build one; it will be picked up automatically.` }, null, 2);
  }
  return dispatch(index, name, args);
}

/** Pure tool dispatch over a given index — exported so the protocol layer can be
 * exercised in tests without a live stdio process. */
export function dispatch(index: MapIndex, name: string, args: Record<string, any>): string {
  switch (name) {
    case 'read': {
      if (Array.isArray(args.refs)) {
        // Batch: one round-trip for many symbols — same cheap slices, far fewer turns.
        const results = args.refs.map((r: unknown) => read(index, String(r), {}));
        return JSON.stringify({ results }, null, 2);
      }
      return JSON.stringify(read(index, String(args.ref), { snippet: args.snippet ? String(args.snippet) : undefined }), null, 2);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(req: any): void {
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
          },
        });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'tools/call': {
        const text = callTool(params.name, params.arguments ?? {});
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
    let req: any;
    try {
      req = JSON.parse(trimmed);
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
