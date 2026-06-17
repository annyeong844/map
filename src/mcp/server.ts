#!/usr/bin/env node
/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), zero deps.
 *
 * It exposes the three primitives and nothing else — locate, read, grep — so a
 * model consuming this server gets coordinates and raw bytes, and does the
 * interpreting itself. The server never summarizes; it routes and quotes.
 *
 *   MAP_INDEX=/path/.map-index.json  node src/mcp/server.ts
 */
import { statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { grep } from '../core/grep.ts';
import { locate } from '../core/locate.ts';
import { read } from '../core/read.ts';
import { loadIndex } from '../core/store.ts';
import type { MapIndex } from '../core/types.ts';

const PROTOCOL = '2025-06-18';
const indexPath = process.env.MAP_INDEX ?? argIndex() ?? '.map-index.json';

let index: MapIndex;
let indexMtimeMs = 0;
try {
  index = loadIndex(indexPath);
  indexMtimeMs = statSync(indexPath).mtimeMs;
} catch (e) {
  process.stderr.write(`code-map MCP: cannot load index at ${indexPath}: ${(e as Error).message}\n`);
  process.exit(1);
}

/**
 * Reload the index if its file changed since we last read it. A long-lived
 * server would otherwise keep serving the snapshot it booted with — so every
 * `map index` rebuild would silently go unseen until the client reconnected.
 * One stat per tool call is far cheaper than that footgun.
 */
function ensureFresh(): void {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(indexPath).mtimeMs;
  } catch {
    return; // index momentarily missing (mid-write) — keep serving what we have
  }
  if (mtimeMs === indexMtimeMs) return;
  try {
    index = loadIndex(indexPath);
    indexMtimeMs = mtimeMs;
    process.stderr.write(`code-map MCP: reloaded index (${index.meta.entryCount} symbols)\n`);
  } catch {
    // half-written index — keep the prior good copy, retry on the next call
  }
}

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
      'Return the RAW source at a routed location — the evidence to interpret yourself. Pass an id from locate, or a bare name. If the file changed since indexing, it re-anchors on the signature line and flags the result; if the anchor is lost, it returns grep matches instead. Read the raw and judge it fresh.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'An id from locate, or a symbol name.' } },
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
];

function callTool(name: string, args: Record<string, any>): string {
  ensureFresh();
  switch (name) {
    case 'locate':
      return JSON.stringify(locate(index, String(args.query), { kind: args.kind, file: args.file, limit: args.limit }), null, 2);
    case 'read':
      return JSON.stringify(read(index, String(args.ref)), null, 2);
    case 'grep':
      return JSON.stringify(
        grep(index.meta.root, String(args.pattern), { fixed: !!args.fixed, file: args.file, caseInsensitive: !!args.caseInsensitive, limit: args.limit }),
        null,
        2,
      );
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
