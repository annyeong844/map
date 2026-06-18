import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { computeSymbolHistory } from '../src/core/git-history.ts';
import { buildIndex } from '../src/core/build-index.ts';
import { graph } from '../src/core/call-graph.ts';
import { grep } from '../src/core/grep.ts';
import { hotspots } from '../src/core/hotspots.ts';
import { locate } from '../src/core/locate.ts';
import { stripJsonc } from '../src/core/public-surface.ts';
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

test('hotspots: static-only mode (no git) ranks by coupling/size, carries evidence, gives no verdict', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/core.ts': `export function bigHub(): number {\n${'  let q = 0;\n'.repeat(40)}  return q;\n}\nexport function tiny(): number { return 1; }\n`,
      'src/a.ts': "import { bigHub } from './core.js';\nexport function ua(): number { return bigHub(); }\n",
      'src/b.ts': "import { bigHub } from './core.js';\nexport function ub(): number { return bigHub(); }\n",
    }),
  });
  const r = hotspots(index, { nowMs: 0 }); // a temp dir is not a git repo → static-only
  assert.equal(r.historyAvailable, false);
  assert.match(r.note, /STATIC/);
  const big = r.hotspots.findIndex((h) => h.name === 'bigHub');
  const tiny = r.hotspots.findIndex((h) => h.name === 'tiny');
  assert.ok(big !== -1 && (tiny === -1 || big < tiny), 'large, high-fan-in hub outranks the tiny unused fn');
  assert.ok(r.hotspots[big].evidence.fanIn >= 2 && r.hotspots[big].evidence.fixes === 0 && r.hotspots[big].evidence.scope === 'file', 'evidence carries fan-in; no fix data and file-scope without history');
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

test('mcp server: tool list is the five primitives; dispatch routes each over a given index', async () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['graph', 'grep', 'hotspots', 'locate', 'read']);
  const { index } = await buildIndex({
    root: repo({
      'src/u.ts': 'export function helper(): number { return 1; }\n',
      'src/m.ts': "import { helper } from './u.js';\nexport function run(): number { return helper(); }\n",
    }),
  });
  const loc = JSON.parse(dispatch(index, 'locate', { query: 'helper' }));
  assert.ok(Array.isArray(loc) && loc.some((h: { name: string }) => h.name === 'helper'));
  assert.match(JSON.parse(dispatch(index, 'read', { ref: 'helper' })).raw ?? '', /function helper/);
  const g = JSON.parse(dispatch(index, 'graph', { ref: 'helper', direction: 'callers' }));
  assert.ok(g.nodes.some((n: { id: string }) => n.id.includes('run')) && typeof g.floor === 'string');
  assert.ok(Array.isArray(JSON.parse(dispatch(index, 'hotspots', { limit: 3 })).hotspots));
  assert.throws(() => dispatch(index, 'nope', {}), /unknown tool/);
});

test('symbol-level history isolates a helper extracted in the same commit (no cross-symbol bleed)', () => {
  // The realistic extract-function shape: one commit BOTH edits the churned `risky`
  // AND adds a fresh `helper`. The new helper must NOT inherit risky's fix history.
  const root = mkdtempSync(join(tmpdir(), 'cm-git-'));
  const f = join(root, 'hot.ts');
  const g = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  const commit = (content: string, msg: string) => {
    writeFileSync(f, content);
    g('add', 'hot.ts');
    g('commit', '-q', '-m', msg);
  };
  commit('export function risky(): number {\n  const a = base();\n  return a;\n}\n', 'init risky');
  commit('export function risky(): number {\n  const a = base() + 1;\n  return a;\n}\n', 'fix risky base');
  commit('export function risky(): number {\n  const a = base() + 1;\n  return a + 5;\n}\n', 'fix risky scaling');
  // extract: edit risky's body AND append a helper with NOVEL logic, in ONE non-fix
  // commit. `git log -L` bleeds risky's history onto the new lines here; blame won't.
  commit('export function risky(): number {\n  const a = base() + 1;\n  return wrap(a);\n}\nexport function helper(a: number): number {\n  return a - 99;\n}\n', 'extract helper from risky');

  const risky = computeSymbolHistory(root, 'hot.ts', 1, 3, Date.now());
  const helper = computeSymbolHistory(root, 'hot.ts', 5, 6, Date.now()); // signature + novel body (skip the shared `}`)
  assert.ok(risky && risky.commits >= 2 && risky.fixes >= 1, 'risky retains its multi-commit fix history');
  assert.equal(helper?.commits, 1, 'helper is touched by exactly its extract commit — no bleed');
  assert.equal(helper?.fixes, 0, 'freshly extracted helper must NOT inherit risky fixes');
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
