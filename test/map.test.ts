import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildIndex } from '../src/core/build-index.ts';
import { graph } from '../src/core/call-graph.ts';
import { grep } from '../src/core/grep.ts';
import { locate } from '../src/core/locate.ts';
import { stripJsonc } from '../src/core/public-surface.ts';
import { read } from '../src/core/read.ts';

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
  assert.equal((alpha as Record<string, unknown>).summary, undefined);
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

test('read falls back to grep when the anchor is destroyed', async () => {
  const root = repo({ 'src/m.ts': SRC });
  const { index } = await buildIndex({ root });
  const alpha = index.entries.find((e) => e.name === 'alpha')!;
  writeFileSync(join(root, 'src/m.ts'), '// alpha was rewritten elsewhere\nexport const z = 1;\n');
  const r = read(index, alpha.id);
  assert.equal(r.status, 'grep-fallback');
  assert.ok((r.candidates ?? []).some((c) => /alpha/.test(c.preview)));
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

test('public surface (package.json → tsconfig src map → re-export closure) spares entry exports', async () => {
  const { index } = await buildIndex({
    root: repo({
      'package.json': JSON.stringify({ name: 'pkg', exports: { '.': './dist/index.js' }, bin: { pkg: 'dist/index.js' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist', rootDir: 'src' } }),
      // The entry file's OWN export: no internal importer, only public-surface saves it.
      'src/index.ts': "export function main(): void {}\nexport { publicThing } from './api.js';\n",
      'src/api.ts': 'export function publicThing(): number { return 1; }\n',
      'src/internal.ts': 'export function deadOne(): void {}\n', // not on the public surface
    }),
  });
  // dist/index.js → src/index.ts (via tsconfig), then re-export closure → src/api.ts.
  assert.ok(index.publicFiles.includes('src/index.ts'), 'entry mapped from package.json');
  assert.ok(index.publicFiles.includes('src/api.ts'), 're-export closure');
  assert.ok(!index.publicFiles.includes('src/internal.ts'));
  // `main` has zero importers but lives in the public entry file → spared (not dead).
  const main = index.entries.find((e) => e.name === 'main')!;
  assert.equal(main.fanIn, 0);
  assert.ok(index.publicFiles.includes(main.file), 'main spared by public surface despite fan-in 0');
  // deadOne is genuinely dead (not public, no importer).
  const deadOne = index.entries.find((e) => e.name === 'deadOne')!;
  assert.equal(deadOne.fanIn, 0);
  assert.ok(!index.publicFiles.includes(deadOne.file));
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

test('call graph: direct calls become caller→callee edges; method dispatch is omitted', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/util.ts': 'export function helper(): number { return 1; }\n',
      'src/main.ts': [
        "import { helper } from './util.js';",
        'export function run(): number { return helper() + same(); }', // imported + same-file calls
        'function same(): number { return 2; }',
        'export function viaMethod(o: { go(): number }): number { return o.go(); }', // member call
      ].join('\n') + '\n',
    }),
  });
  const id = (name: string, file: string) => index.entries.find((e) => e.name === name && e.file === file)!.id;
  const has = (from: string, to: string) => index.callEdges.some(([f, t]) => f === from && t === to);
  assert.ok(has(id('run', 'src/main.ts'), id('helper', 'src/util.ts')), 'run → helper (cross-file import)');
  assert.ok(has(id('run', 'src/main.ts'), id('same', 'src/main.ts')), 'run → same (same file)');
  // o.go() is a member call — not type-resolvable, so no edge.
  const viaMethod = id('viaMethod', 'src/main.ts');
  assert.ok(!index.callEdges.some(([f]) => f === viaMethod), 'method dispatch not edged');
});

test('graph: callers depth>1 = transitive blast radius; callees walks outward; floor confesses uncounted dispatch', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/a.ts': "import { mid } from './b.js';\nexport function top(): number { return mid(); }\n",
      'src/b.ts': "import { leaf } from './c.js';\nexport function mid(): number { return leaf(); }\n",
      'src/c.ts': 'export function leaf(): number { return 1; }\n',
      'src/d.ts': 'export function viaDispatch(o: { leaf(): number }): number { return o.leaf(); }\n',
    }),
  });
  const nm = (id: string) => index.entries.find((e) => e.id === id)!.name;
  const leafId = index.entries.find((e) => e.name === 'leaf')!.id;

  const transitive = graph(index, leafId, { direction: 'callers', depth: 6 });
  const callerNames = new Set(transitive.nodes.map((n) => nm(n.id)));
  assert.ok(callerNames.has('mid') && callerNames.has('top'), 'transitive callers of leaf = mid (d1) + top (d2)');
  // floor surfaces the o.leaf() method-dispatch caller it cannot resolve, and refuses "clear".
  assert.match(transitive.floor!, /1 possible caller/);
  assert.match(transitive.floor!, /never "clear"/);

  // depth 1 = direct neighbours only.
  assert.deepEqual(
    graph(index, leafId, { direction: 'callers', depth: 1 }).nodes.map((n) => nm(n.id)),
    ['mid'],
  );
  // callees walks the other way.
  assert.ok(graph(index, index.entries.find((e) => e.name === 'mid')!.id, { direction: 'callees' }).nodes.some((n) => nm(n.id) === 'leaf'));
});

test('JSONC stripper removes comments but preserves // and /* inside strings', () => {
  const src = '{\n  // line comment\n  "url": "https://x//y",\n  "glob": "a/*b*/c", /* block */\n  "n": 1,\n}';
  const parsed = JSON.parse(stripJsonc(src).replace(/,(\s*[}\]])/g, '$1'));
  assert.equal(parsed.url, 'https://x//y', 'double-slash inside a string is not a comment');
  assert.equal(parsed.glob, 'a/*b*/c', 'slash-star inside a string is not a comment');
  assert.equal(parsed.n, 1);
});

test('grep parses matches on CRLF files', async () => {
  const root = repo({ 'src/m.ts': SRC.replace(/\n/g, '\r\n') });
  const matches = grep(root, 'function alpha', { fixed: true });
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].file, 'src/m.ts');
});
