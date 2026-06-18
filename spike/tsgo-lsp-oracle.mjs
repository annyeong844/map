// SPIKE (validated): tsgo as a type oracle over LSP — resolves obj.method()/this.method()
// dispatch that code-map's structural graph leaves as the floor. On NestJS nest-factory.ts:
// 20/20 member-call sites resolved to file:line. Needs @typescript/native-preview installed.
// Gotchas learned: launch `tsgo --lsp --stdio` (NOT `lsp` subcommand); the client MUST reply
// to server→client requests (registerCapability/configuration) or the server stalls; a big
// monorepo needs ~12s to load before definitions resolve (warmup cost vs code-map's 2s).
// Set TSGO_BIN to the bin/tsgo.js path. Run: node tsgo-lsp-oracle.mjs <root> <file>

// SPIKE: drive tsgo's LSP as a type oracle. For member-call sites (obj.m()) that
// code-map's structural graph leaves unresolved, ask tsgo `textDocument/definition`
// and see how many resolve to a real definition (file:line).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = process.argv[2];
const FILE = process.argv[3]; // absolute path
const src = readFileSync(FILE, 'utf8');

// char offset -> {line, character} (0-based) for LSP
const starts = [0];
for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
function pos(off) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; }
  return { line: lo, character: off - starts[lo] };
}

// member-call sites: `.m(` → position of the property name `m` (regex; spike-grade)
const sites = [];
const re = /\.([A-Za-z_$][\w$]*)\s*\(/g;
let m;
while ((m = re.exec(src))) {
  const name = m[1];
  if (['then', 'catch', 'map', 'forEach', 'filter', 'push', 'bind', 'call', 'apply'].includes(name)) continue;
  sites.push({ name, off: m.index + 1 }); // +1 to skip the dot
}

const child = spawn(process.execPath, ['process.env.TSGO_BIN', '--lsp', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0); const pending = new Map(); let nextId = 1;
child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf('\r\n\r\n'); if (h < 0) break;
    const m = /Content-Length: (\d+)/i.exec(buf.slice(0, h).toString()); if (!m) { buf = buf.slice(h + 4); continue; }
    const len = +m[1]; const start = h + 4; if (buf.length < start + len) break;
    const msg = JSON.parse(buf.slice(start, start + len).toString()); buf = buf.slice(start + len);
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); continue; }
    // server→client REQUEST (has method + id): must reply or the server stalls.
    if (msg.id != null && msg.method) {
      const result = msg.method === 'workspace/configuration' ? (msg.params?.items ?? []).map(() => ({})) : null;
      const r = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(r)}\r\n\r\n${r}`);
    }
  }
});
function send(method, params) { const s = JSON.stringify({ jsonrpc: '2.0', method, params }); child.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); }
function req(method, params) { const id = nextId++; const s = JSON.stringify({ jsonrpc: '2.0', id, method, params }); child.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); return new Promise((res) => pending.set(id, res)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const uri = pathToFileURL(FILE).href;
await req('initialize', { processId: process.pid, rootUri: pathToFileURL(ROOT).href, capabilities: {}, workspaceFolders: [{ uri: pathToFileURL(ROOT).href, name: 'root' }] });
send('initialized', {});
send('textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 1, text: src } });
await sleep(12000); // let the monorepo project load (big NestJS tsconfig graph)

let resolved = 0; const examples = [];
const probe = sites.slice(0, 20);
for (const s of probe) {
  const p = pos(s.off);
  const r = await Promise.race([req('textDocument/definition', { textDocument: { uri }, position: p }), sleep(5000).then(() => null)]);
  const locs = Array.isArray(r) ? r : r ? [r] : [];
  if (locs.length) {
    resolved++;
    if (examples.length < 6) {
      const l = locs[0]; const tgt = (l.uri || l.targetUri || '').replace(pathToFileURL(ROOT).href + '/', '');
      const ln = (l.range || l.targetRange)?.start?.line;
      examples.push(`  .${s.name}()  →  ${tgt}:${ln + 1}`);
    }
  }
}
console.log(`member-call sites probed: ${probe.length}  |  tsgo resolved to a definition: ${resolved}`);
console.log('examples (obj.method() → tsgo-resolved target — code-map leaves these as floor):');
for (const e of examples) console.log(e);
child.kill();
process.exit(0);
