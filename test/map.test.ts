import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildIndex } from '../src/core/build-index.ts';
import { locate } from '../src/core/locate.ts';
import { read } from '../src/core/read.ts';
import { dispatch, TOOLS } from '../src/mcp/server.ts';

/** A throwaway source tree (not a git repo, so the walker fallback enumerates it). */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'map-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

const SRC = `export function alpha(x: number): number {
  return x + 1;
}

function helper(): number {
  return 2;
}
`;

test('index extracts coordinates + an anchor from real source, no meaning, no external graph', async () => {
  const { index } = await buildIndex({ root: repo({ 'src/m.ts': SRC }) });
  const alpha = index.entries.find((e) => e.name === 'alpha')!;
  assert.ok(alpha, 'exported fn indexed');
  assert.equal(typeof alpha.charStart, 'number');
  assert.equal(typeof alpha.charEnd, 'number');
  assert.match(alpha.searchText, /function alpha/);
  assert.equal((alpha as unknown as Record<string, unknown>).summary, undefined);
  // The private helper is covered too — the map parsed it itself.
  const helper = index.entries.find((e) => e.name === 'helper')!;
  assert.ok(helper, 'private fn indexed');
  assert.equal(helper.visibility, 'module-private');
});

test('locate ranks exact above fuzzy', async () => {
  const { index } = await buildIndex({ root: repo({ 'src/m.ts': SRC }) });
  const hits = locate(index, 'alpha');
  assert.equal(hits[0].name, 'alpha');
  assert.equal(hits[0].match, 'exact');
});

test('read returns the exact source when the file is unchanged', async () => {
  const { index } = await buildIndex({ root: repo({ 'src/m.ts': SRC }) });
  const r = read(index, index.entries.find((e) => e.name === 'alpha')!.id);
  assert.equal(r.status, 'exact');
  assert.equal(r.raw, 'function alpha(x: number): number {\n  return x + 1;\n}');
});

test('class methods are indexed with exact coordinates', async () => {
  const { index } = await buildIndex({ root: repo({ 'src/c.ts': 'export class Foo {\n  bar(n: number): number {\n    return n * 2;\n  }\n}\n' }) });
  const bar = index.entries.find((e) => e.name === 'bar')!;
  assert.ok(bar, 'method indexed');
  assert.equal(bar.kind, 'ClassMethod');
  assert.equal(bar.className, 'Foo');
  const r = read(index, bar.id);
  assert.equal(r.status, 'exact');
  assert.match(r.raw ?? '', /bar\(n: number\): number/);
});

test('read re-anchors via searchText after the file drifts', async () => {
  const root = repo({ 'src/m.ts': SRC });
  const { index } = await buildIndex({ root });
  const alpha = index.entries.find((e) => e.name === 'alpha')!;
  writeFileSync(join(root, 'src/m.ts'), '// A\n// B\n// C\n' + SRC);
  const r = read(index, alpha.id);
  assert.equal(r.status, 'relocated');
  assert.match(r.raw ?? '', /function alpha/);
  assert.equal(r.line, alpha.line + 3);
});

test('read reports anchor-lost when the signature anchor is destroyed', async () => {
  const root = repo({ 'src/m.ts': SRC });
  const { index } = await buildIndex({ root });
  const alpha = index.entries.find((e) => e.name === 'alpha')!;
  // Rewrite the file so alpha's signature line no longer exists anywhere — the
  // searchText anchor can't re-anchor, so read must confess it lost the symbol.
  writeFileSync(join(root, 'src/m.ts'), '// alpha was rewritten elsewhere\nexport const z = 1;\n');
  const r = read(index, alpha.id);
  assert.equal(r.status, 'anchor-lost');
  assert.equal(r.raw, null);
});

test('incremental rebuild reuses unchanged files, re-reads changed ones', async () => {
  const root = repo({
    'src/a.ts': 'function helperA(){ return 1; }\nexport function aaa(){ return helperA(); }\n',
    'src/b.ts': 'export function bbb(){ return 2; }\n',
  });
  const first = await buildIndex({ root });
  assert.equal(first.changed, 2);
  assert.equal(first.reused, 0);

  const second = await buildIndex({ root, previous: first.index });
  assert.equal(second.reused, 2);
  assert.equal(second.changed, 0);
  assert.equal(second.unchanged, true);

  writeFileSync(join(root, 'src/a.ts'), 'function helperA(){ return 1; }\nfunction helperA2(){ return 3; }\nexport function aaa(){ return helperA() + helperA2(); }\n');
  const third = await buildIndex({ root, previous: second.index });
  assert.equal(third.reused, 1);
  assert.equal(third.changed, 1);
  assert.ok(locate(third.index, 'helperA2').some((h) => h.file === 'src/a.ts'));

  const forced = await buildIndex({ root, previous: third.index, force: true });
  assert.equal(forced.reused, 0);
  assert.equal(forced.changed, 2);
});

test('native fan-in counts cross-file importers and breaks ranking ties', async () => {
  const { index } = await buildIndex({
    root: repo({
      'pkg/dup.ts': 'export function dup(): number { return 1; }\nexport function lonely(): number { return 9; }\n',
      'vendor/dup.ts': 'export function dup(): number { return 1; }\n',
      // Two files import the canonical pkg/dup; none import the vendored copy.
      'src/x.ts': "import { dup } from '../pkg/dup.ts';\nexport function x() { return dup(); }\n",
      'src/y.ts': "import { dup } from '../pkg/dup';\nexport function y() { return dup(); }\n",
    }),
  });
  const canonical = index.entries.find((e) => e.file === 'pkg/dup.ts' && e.name === 'dup')!;
  const vendored = index.entries.find((e) => e.file === 'vendor/dup.ts' && e.name === 'dup')!;
  const lonely = index.entries.find((e) => e.name === 'lonely')!;
  assert.equal(canonical.fanIn, 2, 'imported by x.ts and y.ts (incl. extensionless specifier)');
  assert.equal(vendored.fanIn, 0);
  assert.equal(lonely.fanIn, 0, 'exported but never imported');
  // Ranking: same exact-match tier, so fan-in decides — canonical floats up.
  const hits = locate(index, 'dup');
  assert.equal(hits[0].file, 'pkg/dup.ts');
  assert.equal(hits[0].fanIn, 2);
});

test('fan-in resolves TS ESM .js→.ts specifiers', async () => {
  // Modern TS writes the .js extension on the import; the file on disk is .ts.
  const { index } = await buildIndex({
    root: repo({
      'src/dep.ts': 'export function shared(): number { return 1; }\n',
      'src/a.ts': "import { shared } from './dep.js';\nexport function a() { return shared(); }\n",
      'src/sub/b.mts': "import { shared } from '../dep.js';\nexport function b() { return shared(); }\n",
    }),
  });
  const shared = index.entries.find((e) => e.name === 'shared' && e.file === 'src/dep.ts')!;
  assert.equal(shared.fanIn, 2, "'./dep.js' and '../dep.js' both resolve to dep.ts");
});

test('concept query ranks the acting function over a same-keyword type', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/diff.ts': [
        'export interface DiffResult { changed: boolean; }',
        'export interface DiffSymbol { name: string; }',
        'export function computeDiff(a: string, b: string): DiffResult { return { changed: a !== b }; }',
      ].join('\n') + '\n',
    }),
  });
  // Multi-word concept: "compute diff" covers both subwords of computeDiff;
  // the verb "compute" prefers the function over the DiffResult/DiffSymbol types.
  const hits = locate(index, 'compute the diff');
  assert.equal(hits[0].name, 'computeDiff');
  // A bare single keyword stays ambiguous — both types and the fn match "diff".
  assert.ok(locate(index, 'diff').length >= 3);
});

test('intraRefs distinguishes dead code from a merely-dead export', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/m.ts': [
        'export function impl(x: number): number { return x * 2; }', // exported, used intra-file, not imported
        'export const api = { run: impl };', // api references impl
        'export function reallyDead(): void {}', // exported, referenced nowhere at all
      ].join('\n') + '\n',
      'src/use.ts': "import { api } from './m.js';\nexport function u() { return api.run(2); }\n",
    }),
  });
  const impl = index.entries.find((e) => e.name === 'impl')!;
  const reallyDead = index.entries.find((e) => e.name === 'reallyDead')!;
  const api = index.entries.find((e) => e.name === 'api')!;
  assert.equal(api.fanIn, 1, 'api is imported by use.ts → alive');
  // dead EXPORT: nobody imports impl, but it is used in its own file → code alive.
  assert.equal(impl.fanIn, 0);
  assert.ok((impl.intraRefs ?? 0) >= 2, 'impl referenced intra-file');
  // dead CODE: no importer AND no intra-file use → removable.
  assert.equal(reallyDead.fanIn, 0);
  assert.ok((reallyDead.intraRefs ?? 0) <= 1, 'reallyDead used nowhere');
});

test('default-exported function/class keeps real kind; default class methods are indexed', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/w.ts': 'export default function widget(): number { return 1; }\n',
      'src/c.ts': 'export default class Bar {\n  greet(): string { return "hi"; }\n}\n',
      'src/anon.ts': 'export default function (): void {}\n',
    }),
  });
  // #2: real AST kind, not 'default' (so --kind filters work); locatable by name.
  assert.equal(index.entries.find((e) => e.name === 'widget')?.kind, 'FunctionDeclaration');
  assert.equal(index.entries.find((e) => e.name === 'Bar')?.kind, 'ClassDeclaration');
  // #1: methods of a default-exported class are extracted.
  const greet = index.entries.find((e) => e.name === 'greet');
  assert.ok(greet && greet.className === 'Bar', 'default class method indexed');
  // Anonymous default still recorded as 'default'.
  assert.ok(index.entries.some((e) => e.name === 'default' && e.kind === 'default'));
});

test('read --snippet designates a sub-symbol char range and flags intra-symbol ambiguity', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/f.ts': 'export function f(): number {\n  const x = 1;\n  return x + 1;\n}\nexport function g(): void {\n  a();\n  a();\n}\nfunction a(): void {}\n',
    }),
  });
  const fId = index.entries.find((e) => e.name === 'f')!.id;
  const hit = read(index, fId, { snippet: 'const x = 1' });
  assert.equal(hit.aim?.status, 'hit');
  assert.equal(hit.aim?.matches.length, 1);
  assert.ok(hit.raw?.includes('const x = 1'), 'still returns the raw too');
  // snippet that occurs twice inside g → ambiguous (another "classroom" in the building)
  const amb = read(index, index.entries.find((e) => e.name === 'g')!.id, { snippet: 'a();' });
  assert.equal(amb.aim?.status, 'ambiguous');
  assert.equal(amb.aim?.matches.length, 2);
  // snippet from g must NOT match inside f — search is scoped to the symbol
  assert.equal(read(index, fId, { snippet: 'a();' }).aim?.status, 'not-in-symbol');
});

test('read flags ambiguous relocation when the signature anchor matches multiple sites', async () => {
  const root = repo({ 'src/m.ts': 'export function widget(): number {\n  return 1;\n}\n' });
  const { index } = await buildIndex({ root });
  const widget = index.entries.find((e) => e.name === 'widget')!;
  // Change the file (token differs → re-anchor path) AND make the signature line
  // occur twice, so the anchor is ambiguous.
  writeFileSync(join(root, 'src/m.ts'), '// export function widget(): number {   (old, duplicated)\nexport function widget(): number {\n  return 2;\n}\n');
  const r = read(index, widget.id);
  assert.equal(r.status, 'ambiguous');
  assert.ok((r.candidates ?? []).length >= 2, 'returns the multiple candidate anchor sites');
});

test('mcp server: the only tool is read; dispatch routes it over a given index', async () => {
  assert.equal(TOOLS.length, 1);
  assert.equal(TOOLS[0].name, 'read');
  const { index } = await buildIndex({
    root: repo({
      'src/u.ts': 'export function helper(): number { return 1; }\n',
      'src/m.ts': "import { helper } from './u.js';\nexport function run(): number { return helper(); }\n",
    }),
  });
  assert.match(JSON.parse(dispatch(index, 'read', { ref: 'helper' })).raw ?? '', /function helper/);
  assert.throws(() => dispatch(index, 'nope', {}), /unknown tool/);
});

test('re-exported imports are not indexed as barrel symbols', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/parser.ts': 'export function isResetIntent(): boolean {\n  return true;\n}\n',
      'src/pipeline.ts': "import { isResetIntent } from './parser.js';\nexport { isResetIntent };\nexport function run(): boolean {\n  return isResetIntent();\n}\n",
      'src/barrel.ts': "export { isResetIntent } from './parser.js';\n",
    }),
  });
  // isResetIntent has ONE definition — parser.ts. The barrel/re-export sites must
  // not be indexed as their own symbols (that shadows the real definition).
  const files = [...new Set(index.entries.filter((e) => e.name === 'isResetIntent').map((e) => e.file))];
  assert.deepEqual(files, ['src/parser.ts'], 'isResetIntent indexed only at its real definition');
});

test('snippet aim never escapes the symbol: a stale file does not match another symbol', async () => {
  const root = repo({
    'm.ts': 'export function foo() {\n  return 1\n}\n\nexport function bar() {\n  const SECRET = 2\n  return SECRET\n}\n',
  });
  const { index } = await buildIndex({ root });
  const foo = index.entries.find((e) => e.name === 'foo')!;
  // Change the file so the token goes stale, but leave foo's signature line intact.
  writeFileSync(join(root, 'm.ts'), 'export function foo() {\n  return 1\n}\n\nexport function bar() {\n  const SECRET = 2 // touched\n  return SECRET\n}\n// trailing change\n');
  // `SECRET` lives only in bar. Aiming it while reading foo must NOT report `hit`.
  const r = read(index, foo.id, { snippet: 'SECRET' });
  assert.notEqual(r.aim?.status, 'hit', 'a snippet from another symbol must not be an in-symbol hit');
  assert.ok(r.aim && (r.aim.status === 'not-in-symbol' || r.aim.status === 'unanchored'), `expected not-in-symbol/unanchored, got ${r.aim?.status}`);
});

test('incremental detects a same-size edit with a restored mtime (ctime/ino guard)', async () => {
  const root = repo({ 'src/m.ts': 'export function alpha(){ return 1 }\n' });
  const first = await buildIndex({ root });
  const p = join(root, 'src/m.ts');
  const before = statSync(p);
  // alpha -> bravo is the same length; restoring mtime makes (mtime,size) identical.
  writeFileSync(p, 'export function bravo(){ return 1 }\n');
  utimesSync(p, before.atime, before.mtime);
  const second = await buildIndex({ root, previous: first.index });
  assert.ok(locate(second.index, 'bravo').some((h) => h.file === 'src/m.ts'), 'same-size mtime-restored edit detected');
  assert.equal(locate(second.index, 'alpha').filter((h) => h.file === 'src/m.ts').length, 0, 'stale alpha entry dropped');
});

test('read refuses a path that escapes the index root (traversal / untrusted index)', async () => {
  const root = repo({ 'src/m.ts': SRC });
  const { index } = await buildIndex({ root });
  // A malicious or corrupted index entry pointing outside the project root.
  const evil = { ...index.entries[0], id: 'evil#x', file: '../../../../../../etc/hostname', name: 'x', charStart: 0, charEnd: 8 };
  const r = read({ ...index, entries: [...index.entries, evil] }, 'evil#x');
  assert.notEqual(r.status, 'exact', 'must not read a file outside the index root');
  assert.equal(r.raw, null);
});

test('default-exported function gets fan-in from default imports', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/dep.ts': 'export default function widget() { return 1 }\n',
      'src/a.ts': "import widget from './dep.ts'\nexport function a() { return widget() }\n",
      'src/b.ts': "import w from './dep.js'\nexport function b() { return w() }\n",
    }),
  });
  const widget = index.entries.find((e) => e.name === 'widget' && e.file === 'src/dep.ts')!;
  assert.ok(widget, 'default export indexed by its real name');
  assert.ok(widget.default, 'marked as the module default export');
  assert.equal(widget.fanIn, 2, 'two files default-import it (counted via the `default` bucket)');
});

test('fan-in propagates through a barrel re-export to the real definition', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/real.ts': 'export function gizmo() { return 1 }\n',
      'src/index.ts': "export { gizmo } from './real.ts'\n", // barrel forwards it
      'src/a.ts': "import { gizmo } from './index.ts'\nexport function a() { return gizmo() }\n",
      'src/b.ts': "import { gizmo } from './index.ts'\nexport function b() { return gizmo() }\n",
    }),
  });
  const gizmo = index.entries.find((e) => e.name === 'gizmo' && e.file === 'src/real.ts')!;
  assert.equal(gizmo.fanIn, 2, 'two consumers importing via the barrel credit the real definition');
});
