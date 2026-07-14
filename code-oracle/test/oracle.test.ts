import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { ContentLengthDecoder, disposeAll, query, resolveNamePosition, scanProjectEpoch, TOOLS, tsgoSpawnCommand, type OracleSym } from '../server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const installedTsgo = ['tsgo', 'tsgo.js']
  .map((name) => join(HERE, '../node_modules/@typescript/native-preview/bin', name))
  .some((candidate) => existsSync(candidate));
const hasTsgo =
  (!!process.env.TSGO_BIN && existsSync(process.env.TSGO_BIN)) ||
  (installedTsgo &&
    existsSync(join(HERE, '../node_modules/@typescript', `native-preview-${process.platform}-${process.arch}`)));

after(() => disposeAll());

test('the three tools are exposed', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['callers', 'definition', 'implementations']);
});

test('tsgo spawn accepts the new extensionless Node launcher and legacy/native binaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-tsgo-'));
  try {
    const extensionless = join(root, 'tsgo');
    const legacy = join(root, 'tsgo.js');
    const native = join(root, 'tsgo-native');
    writeFileSync(extensionless, '#!/usr/bin/env node\n');
    writeFileSync(legacy, '/* legacy Node launcher */\n');
    writeFileSync(native, 'native executable placeholder\n');

    const args = ['--lsp', '--stdio'];
    assert.deepEqual(tsgoSpawnCommand(extensionless), { cmd: process.execPath, args: [extensionless, ...args] });
    assert.deepEqual(tsgoSpawnCommand(legacy), { cmd: process.execPath, args: [legacy, ...args] });
    assert.deepEqual(tsgoSpawnCommand(native), { cmd: native, args });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Content-Length decoding is linear-safe across byte splits and packed frames', () => {
  const frame = (value: unknown): Buffer => {
    const body = Buffer.from(JSON.stringify(value));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  };
  const first = { jsonrpc: '2.0', id: 1, result: '한글🙂' };
  const second = { jsonrpc: '2.0', id: 2, result: [1, 2, 3] };
  const bytes = Buffer.concat([frame(first), frame(second)]);
  const decoder = new ContentLengthDecoder();
  const messages: Buffer[] = [];
  // Worst fragmentation: one byte per chunk. The former Buffer.concat loop
  // repeatedly copied the entire accumulated body here.
  for (const byte of bytes) messages.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(messages.map((body) => JSON.parse(body.toString())), [first, second]);

  const packed = new ContentLengthDecoder().push(bytes);
  assert.deepEqual(packed.map((body) => JSON.parse(body.toString())), [first, second]);
});

test('project fingerprint catches additions, deletions, and restored-mtime edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-epoch-'));
  const source = join(root, 'a.ts');
  const config = join(root, 'tsconfig.json');
  writeFileSync(config, JSON.stringify({ include: ['*.ts'] }));
  writeFileSync(source, 'export const a = 1\n');
  const first = await scanProjectEpoch(root);

  const added = join(root, 'b.ts');
  writeFileSync(added, 'export const b = 2\n');
  const withAddition = await scanProjectEpoch(root);
  assert.notEqual(withAddition, first);
  unlinkSync(added);
  assert.equal(await scanProjectEpoch(root), first, 'deleting the added source restores the original fingerprint');

  const before = statSync(source);
  writeFileSync(source, 'export const z = 1\n'); // equal size
  utimesSync(source, before.atime, before.mtime);
  const afterSourceEdit = await scanProjectEpoch(root);
  assert.notEqual(afterSourceEdit, first, 'ctime catches an equal-size edit with restored mtime');

  writeFileSync(config, JSON.stringify({ include: ['src/*.ts'] }));
  assert.notEqual(await scanProjectEpoch(root), afterSourceEdit, 'project configuration participates in the fingerprint');
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

test('callers reconciles added, modified, and deleted sibling files after warmup', { skip: hasTsgo ? false : 'tsgo not installed (npm install in code-oracle/)', timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-dirty-callers-'));
  const definitionFile = join(root, 'definition.ts');
  const callerFile = join(root, 'caller.ts');

  try {
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext' }, include: ['*.ts'] }));
    writeFileSync(definitionFile, 'export function target(): number { return 1; }\n');

    const before = (await query('callers', { file: definitionFile, name: 'target', root })) as { count: number };
    assert.equal(before.count, 0);

    writeFileSync(callerFile, "import { target } from './definition.js';\nexport const run = () => target();\n");
    const afterAddition = (await query('callers', { file: definitionFile, name: 'target', root })) as { count: number; results: { file: string }[] };
    assert.equal(afterAddition.count, 1, `new sibling caller must enter the warm project: ${JSON.stringify(afterAddition)}`);
    assert.equal(afterAddition.results[0]?.file, 'caller.ts');

    writeFileSync(callerFile, "import { target } from './definition.js';\nexport const first = () => target();\nexport const second = () => target();\n");
    const afterModification = (await query('callers', { file: definitionFile, name: 'target', root })) as { count: number };
    assert.equal(afterModification.count, 2, `modified sibling content must replace the warm overlay: ${JSON.stringify(afterModification)}`);

    unlinkSync(callerFile);
    const afterDeletion = (await query('callers', { file: definitionFile, name: 'target', root })) as { count: number };
    assert.equal(afterDeletion.count, 0, `deleted sibling must leave the project graph: ${JSON.stringify(afterDeletion)}`);
  } finally {
    disposeAll();
    rmSync(root, { recursive: true, force: true });
  }
});
