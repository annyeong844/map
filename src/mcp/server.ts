#!/usr/bin/env node
/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), zero deps.
 *
 * It exposes four tools and nothing else — locate, read, grep, graph — so a
 * model consuming this server gets coordinates, raw bytes, and call-graph
 * navigation, and does the interpreting itself. The server never summarizes; it
 * routes and quotes.
 *
 *   MAP_INDEX=/path/.map-index.json  node src/mcp/server.ts
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { graph } from '../core/call-graph.ts';
import { grep } from '../core/grep.ts';
import { locate } from '../core/locate.ts';
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

ensureFresh();
if (!index) process.stderr.write(`code-map MCP: no index at ${indexPath} yet — run \`map index\`; tools will pick it up on the next call.\n`);

const TOOLS = [
  {
    name: 'locate',
    description:
      'Route a query (symbol name, path-scoped name like "alias-map#buildAliasMap", or path fragment) to ranked candidate coordinates. Returns ids, kinds, file:line, and the signature line. This does not interpret code — it only points.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name, "path#name", or "path#".' },
        kind: { type: 'string', description: 'Filter by AST kind substring, e.g. "function", "method", "class".' },
        file: { type: 'string', description: 'Filter by file path substring.' },
        limit: { type: 'number', description: 'Max hits (default 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read',
    description:
      'Return the RAW source at a routed location — the evidence to interpret yourself. Pass an id from locate, or a bare name. If the file changed since indexing, it re-anchors on the signature line and flags the result; if the anchor is lost, it returns grep matches instead. Optionally pass `snippet` (text you quote from inside the symbol) to also get its exact char range(s) within the symbol — `aim.status:"ambiguous"` means the snippet occurs more than once, so do not target blindly. Read the raw and judge it fresh.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'An id from locate, or a symbol name.' },
        snippet: { type: 'string', description: 'Optional: verbatim text from inside the symbol — resolved to exact char range(s).' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'grep',
    description: 'Fallback search over the source tree (ripgrep). Use when locate/read cannot route you, or to confirm where something lives.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        fixed: { type: 'boolean', description: 'Treat pattern as a literal string, not a regex.' },
        file: { type: 'string', description: 'Restrict to files whose path contains this substring.' },
        caseInsensitive: { type: 'boolean' },
        limit: { type: 'number', description: 'Max matches (default 100).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'graph',
    description:
      'Walk the call graph from a symbol. direction="callers" (default) = who depends on it — the blast radius; "callees" = what it calls. depth=1 (default) is direct neighbours, depth>1 is transitive. For callers the result includes a `floor`: a LOWER BOUND, because `obj.method()` dispatch is not in the graph — never treat a small/empty result as "safe".',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'An id from locate, or a symbol name.' },
        direction: { type: 'string', enum: ['callers', 'callees'], description: 'callers (default) or callees.' },
        depth: { type: 'number', description: 'Traversal depth; 1 = direct (default), >1 = transitive.' },
      },
      required: ['ref'],
    },
  },
];

function callTool(name: string, args: Record<string, any>): string {
  ensureFresh();
  if (!index) {
    return JSON.stringify({ error: `No code-map index found at ${indexPath}. Run \`map index --root <repo>\` to build one; it will be picked up automatically.` }, null, 2);
  }
  switch (name) {
    case 'locate':
      return JSON.stringify(locate(index, String(args.query), { kind: args.kind, file: args.file, limit: args.limit }), null, 2);
    case 'read':
      return JSON.stringify(read(index, String(args.ref), { snippet: args.snippet ? String(args.snippet) : undefined }), null, 2);
    case 'grep':
      return JSON.stringify(
        grep(index.meta.root, String(args.pattern), { fixed: !!args.fixed, file: args.file, caseInsensitive: !!args.caseInsensitive, limit: args.limit }),
        null,
        2,
      );
    case 'graph': {
      const direction = args.direction === 'callees' ? 'callees' : 'callers';
      const g = graph(index, String(args.ref), { direction, depth: args.depth });
      return JSON.stringify(g.symbol ? g : { error: `no symbol matches "${args.ref}"` }, null, 2);
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

function argIndex(): string | undefined {
  const i = process.argv.indexOf('--index');
  return i !== -1 ? process.argv[i + 1] : undefined;
}
