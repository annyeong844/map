import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { disposeAll, query, resolveNamePosition, TOOLS, type OracleSym } from '../server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const hasTsgo = !!process.env.TSGO_BIN || existsSync(join(HERE, '../node_modules/@typescript/native-preview/bin/tsgo.js'));

after(() => disposeAll());

test('the three tools are exposed', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['callers', 'definition', 'implementations']);
});

// Pure resolver, no LSP: the name→declaration decision behind the interface-vs-class
// footgun. A bare name that lives in two containers must surface both, never silently
// anchor on the first (the earlier interface method), and a qualified Container.name
// must pin the exact declaration.
test('resolveNamePosition: bare ambiguity is surfaced; qualified name disambiguates (no LSP)', () => {
  const syms: OracleSym[] = [
    { name: 'WebSocketLike', container: null, line: 0, character: 17, kind: 11 },     // interface
    { name: 'send', container: 'WebSocketLike', line: 1, character: 2, kind: 6 },     // earlier same-name decl
    { name: 'RunChannelClient', container: null, line: 3, character: 13, kind: 5 },   // class
    { name: 'send', container: 'RunChannelClient', line: 5, character: 2, kind: 6 },  // later same-name decl
    { name: 'open', container: 'RunChannelClient', line: 8, character: 2, kind: 6 },
  ];

  // bare `send` matches two containers → ambiguous, not silently the first (interface)
  const amb = resolveNamePosition(syms, 'send');
  assert.ok(amb && 'ambiguous' in amb, `expected ambiguous, got ${JSON.stringify(amb)}`);
  assert.deepEqual(amb.ambiguous.map((c) => c.container).sort(), ['RunChannelClient', 'WebSocketLike']);

  // qualified names anchor the exact declaration (the reported fix)
  assert.deepEqual(resolveNamePosition(syms, 'RunChannelClient.send'), { line: 5, character: 2 });
  assert.deepEqual(resolveNamePosition(syms, 'WebSocketLike.send'), { line: 1, character: 2 });

  // a bare name unique to one container resolves cleanly
  assert.deepEqual(resolveNamePosition(syms, 'open'), { line: 8, character: 2 });
  assert.deepEqual(resolveNamePosition(syms, 'RunChannelClient'), { line: 3, character: 13 });

  // overload signatures share one container → collapse to the first, NOT ambiguous
  const overloads: OracleSym[] = [
    { name: 'foo', container: 'C', line: 10, character: 2, kind: 6 },
    { name: 'foo', container: 'C', line: 12, character: 2, kind: 6 },
  ];
  assert.deepEqual(resolveNamePosition(overloads, 'foo'), { line: 10, character: 2 });

  // prefer a declaration kind (Function) over a non-decl (Variable) of the same name
  const mixed: OracleSym[] = [
    { name: 'bar', container: null, line: 20, character: 6, kind: 13 }, // Variable
    { name: 'bar', container: null, line: 22, character: 9, kind: 12 }, // Function
  ];
  assert.deepEqual(resolveNamePosition(mixed, 'bar'), { line: 22, character: 9 });

  // unknown name → null → caller then does the comment/import-skipping text scan
  assert.equal(resolveNamePosition(syms, 'nope'), null);
});

// The interface-dispatch case, as a real fixture (was only a comment + a buggy spike):
// `implementations` must resolve an interface method to its concrete impls — the
// type-aware CHA that a structural call graph cannot draw.
test('implementations resolves an interface method to every concrete impl (type-aware CHA)', { skip: hasTsgo ? false : 'tsgo not installed (npm install in code-oracle/)', timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext' }, include: ['*.ts'] }));
  writeFileSync(
    join(root, 'shapes.ts'),
    [
      'export interface Shape {',
      '  area(): number;',
      '}',
      'export class Circle implements Shape {',
      '  area() { return 3.14; }',
      '}',
      'export class Square implements Shape {',
      '  area() { return 4; }',
      '}',
      '',
    ].join('\n'),
  );

  // Point at the interface method's declaration (line 1, the `area` token at col 2).
  const r = (await query('implementations', { file: join(root, 'shapes.ts'), line: 1, character: 2, root })) as {
    tool: string;
    count: number;
    results: { file: string; line: number }[];
  };
  assert.equal(r.tool, 'implementations');
  assert.ok(r.count >= 2, `expected >= 2 concrete impls, got ${r.count}: ${JSON.stringify(r.results)}`);
});

// Real footgun (firsthand 2026-07): asking callers by the bare name `send` silently
// anchored on the EARLIER same-name declaration — interface WebSocketLike.send — and
// returned socket.send() sites, not the intended class method RunChannelClient.send.
// A bare name that matches two declarations in different containers must NOT be picked
// silently: surface the ambiguity, and let a qualified `Container.name` disambiguate.
test('bare name flags same-file same-name ambiguity; qualified name anchors the right declaration', { skip: hasTsgo ? false : 'tsgo not installed (npm install in code-oracle/)', timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext' }, include: ['*.ts'] }));
  writeFileSync(
    join(root, 'chan.ts'),
    [
      'export interface WebSocketLike {',
      '  send(data: string): void;',              // WebSocketLike.send — the EARLIER decl
      '}',
      'export class RunChannelClient {',
      '  constructor(private socket: WebSocketLike) {}',
      '  send(data: string): void {',             // RunChannelClient.send — the LATER decl
      '    this.socket.send(data);',              // caller of WebSocketLike.send (through the interface)
      '  }',
      '  open()  { this.send("o"); }',            // caller of RunChannelClient.send
      '  close() { this.send("c"); }',            // caller of RunChannelClient.send
      '  ping()  { this.send("p"); }',            // caller of RunChannelClient.send
      '}',
      '',
    ].join('\n'),
  );
  const file = join(root, 'chan.ts');

  // 1) bare `send` is ambiguous across two containers → surfaced, not silently picked.
  const amb = (await query('callers', { file, name: 'send', root })) as { error?: string; candidates?: { name: string }[] };
  assert.ok(amb.error && Array.isArray(amb.candidates), `expected ambiguity, got ${JSON.stringify(amb)}`);
  assert.deepEqual(amb.candidates!.map((c) => c.name).sort(), ['RunChannelClient.send', 'WebSocketLike.send']);

  // 2) qualified name anchors the class method → only the this.send() sites, never socket.send.
  const cls = (await query('callers', { file, name: 'RunChannelClient.send', root })) as { count: number; results: { preview: string }[] };
  const previews = cls.results.map((r) => r.preview).join('\n');
  assert.ok(cls.count >= 3, `expected the 3 this.send() callers, got ${cls.count}: ${JSON.stringify(cls.results)}`);
  assert.ok(!/socket\.send/.test(previews), `socket.send must not be a caller of RunChannelClient.send: ${previews}`);

  // 3) the interface method resolves to the socket.send() site, not the this.send() ones.
  const iface = (await query('callers', { file, name: 'WebSocketLike.send', root })) as { count: number; results: { preview: string }[] };
  assert.ok(iface.results.some((r) => /this\.socket\.send/.test(r.preview)), `expected socket.send caller, got ${JSON.stringify(iface.results)}`);
});
