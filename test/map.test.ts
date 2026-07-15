import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/core/build-index.ts';
import { locate } from '../src/core/locate.ts';
import { changed, read } from '../src/core/read.ts';
import { getPreparedLookup, loadIndex, saveIndex } from '../src/core/store.ts';
import { callTool, dispatch, resolveIndexPath, toHostPath, TOOLS } from '../src/mcp/server.ts';
import { applySetup, setupPlan } from '../src/cli/setup.ts';
import { VERSION } from '../src/version.ts';

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

test('CLI and MCP expose the package version from one source', () => {
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli/main.ts', import.meta.url)), '--version'], {
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), VERSION);
});

test('setup plans wire both routing and MCP without mutating by default', () => {
  const root = join('tmp', 'code map');
  const codex = setupPlan('codex', root);
  assert.deepEqual(codex.steps.map((step) => step.args), [
    ['plugin', 'marketplace', 'add', root],
    ['plugin', 'add', 'code-map@code-map'],
    ['mcp', 'add', 'code-map', '--', 'map-mcp'],
  ]);
  const claude = setupPlan('claude', root);
  assert.ok(claude.steps.some((step) => step.args.includes('code-map@code-map')));
  assert.ok(claude.steps.some((step) => step.args.includes('map-mcp')));
  const gemini = setupPlan('gemini', root, join('home', 'user'));
  assert.equal(gemini.steps.length, 0);
  assert.equal(gemini.files?.length, 2);
});

test('Gemini setup merges config and routing rules idempotently', () => {
  const home = repo({
    '.gemini/config/mcp_config.json': JSON.stringify({ mcpServers: { existing: { command: 'keep-me' } } }),
    '.gemini/GEMINI.md': '# Personal rules\n',
  });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const plan = setupPlan('gemini', root, home);
  applySetup(plan);
  applySetup(plan);

  const config = JSON.parse(readFileSync(join(home, '.gemini/config/mcp_config.json'), 'utf8'));
  assert.equal(config.mcpServers.existing.command, 'keep-me');
  assert.ok(config.mcpServers['code-map']);
  const rules = readFileSync(join(home, '.gemini/GEMINI.md'), 'utf8');
  assert.equal(rules.match(/<!-- code-map setup:start -->/gu)?.length, 1);
  assert.match(rules, /# Personal rules/);
});

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

test('a local declaration exported by list stays one real, unambiguous symbol', async () => {
  const { index } = await buildIndex({ root: repo({ 'src/m.ts': 'function local(): number { return 1; }\nexport { local };\n' }) });
  const locals = index.entries.filter((e) => e.name === 'local');
  assert.equal(locals.length, 1);
  assert.equal(locals[0].kind, 'FunctionDeclaration');
  assert.equal(locals[0].visibility, undefined);
  assert.equal(read(index, 'local').status, 'exact');
});

test('saved indexes rebase their root portably, including legacy conventional indexes', async () => {
  const root = repo({ 'src/m.ts': SRC });
  const path = join(root, '.map-index.json');
  const { index } = await buildIndex({ root });
  saveIndex(index, path);
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(persisted.meta.rootRelativeToIndex, '.');
  persisted.meta.root = 'Z:\\a-root-that-does-not-exist';
  writeFileSync(path, JSON.stringify(persisted));
  const portable = loadIndex(path);
  assert.equal(getPreparedLookup(portable), undefined, 'one-shot loads stay allocation-light until a long-lived caller opts in');
  assert.equal(portable.meta.root, root);
  assert.equal(read(portable, 'alpha').status, 'exact');

  delete persisted.meta.rootRelativeToIndex;
  writeFileSync(path, JSON.stringify(persisted));
  const legacy = loadIndex(path);
  assert.equal(legacy.meta.root, root);
  assert.equal(read(legacy, 'alpha').status, 'exact');
});

test('MCP index discovery sees an index created later in a deep parent', () => {
  const root = repo({});
  let nested = root;
  for (let i = 0; i < 10; i++) nested = join(nested, `d${i}`);
  mkdirSync(nested, { recursive: true });
  assert.equal(resolveIndexPath(nested, ''), join(nested, '.map-index.json'));
  writeFileSync(join(root, '.map-index.json'), '{}');
  assert.equal(resolveIndexPath(nested, ''), join(root, '.map-index.json'));
});

test('MCP path bridge accepts Windows and WSL spellings on either host', () => {
  assert.equal(toHostPath('/mnt/c/Users/endof/repo', 'win32'), 'C:\\Users\\endof\\repo');
  assert.equal(toHostPath('C:\\Users\\endof\\repo', 'linux'), '/mnt/c/Users/endof/repo');
  assert.equal(toHostPath('/home/endof/repo', 'linux'), '/home/endof/repo');
});

test('a global MCP routes reads across child repositories by absolute root', async () => {
  const container = repo({});
  const firstRoot = join(container, 'first');
  const secondRoot = join(container, 'second');
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  writeFileSync(join(firstRoot, 'a.ts'), 'export function alpha(): number { return 1; }\n');
  writeFileSync(join(secondRoot, 'b.ts'), 'export function beta(): number { return 2; }\n');
  const first = await buildIndex({ root: firstRoot });
  const second = await buildIndex({ root: secondRoot });
  saveIndex(first.index, join(firstRoot, '.map-index.json'));
  saveIndex(second.index, join(secondRoot, '.map-index.json'));

  const alpha = JSON.parse(callTool('read', { root: firstRoot, ref: 'alpha' }));
  const beta = JSON.parse(callTool('read', { root: secondRoot, ref: 'beta' }));
  assert.equal(alpha.status, 'exact');
  assert.match(alpha.raw ?? '', /function alpha/);
  assert.equal(beta.status, 'exact');
  assert.match(beta.raw ?? '', /function beta/);
  assert.match(JSON.parse(callTool('read', { root: 'relative/repo', ref: 'alpha' })).error ?? '', /must be absolute/);
});

test('MCP changedOnly compares with the prior read even after an index refresh', async () => {
  const root = repo({
    'src/a.ts': 'export function alpha(): number { return 1; }\n',
    'src/b.ts': 'export function beta(): number { return 2; }\n',
  });
  let built = await buildIndex({ root });
  const indexPath = join(root, '.map-index.json');
  saveIndex(built.index, indexPath);

  const cold = JSON.parse(callTool('read', { root, refs: ['alpha', 'beta'], changedOnly: true }));
  assert.deepEqual(cold.unchanged, []);
  assert.deepEqual(cold.changed.map((result: { id: string }) => result.id), ['src/a.ts#alpha', 'src/b.ts#beta']);

  const initial = JSON.parse(callTool('read', { root, refs: ['alpha', 'beta'] }));
  assert.deepEqual(initial.results.map((result: { status: string }) => result.status), ['exact', 'exact']);

  writeFileSync(join(root, 'src/a.ts'), 'export function alpha(): number { return 10; }\n');
  built = await buildIndex({ root, previous: built.index });
  saveIndex(built.index, indexPath);

  const delta = JSON.parse(callTool('read', { root, refs: ['alpha', 'beta'], changedOnly: true }));
  assert.deepEqual(delta.unchanged, ['src/b.ts#beta']);
  assert.equal(delta.changed.length, 1);
  assert.equal(delta.changed[0].id, 'src/a.ts#alpha');
  assert.match(delta.changed[0].raw ?? '', /return 10/);

  const stable = JSON.parse(callTool('read', { root, refs: ['alpha', 'beta'], changedOnly: true }));
  assert.deepEqual(stable.unchanged, ['src/a.ts#alpha', 'src/b.ts#beta']);
  assert.deepEqual(stable.changed, []);
});

test('the global MCP bounds warmed repository runtimes', async () => {
  const container = repo({});
  const roots: string[] = [];
  for (let i = 0; i < 9; i++) {
    const root = join(container, `repo-${i}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'm.ts'), `export function symbol${i}(): number { return ${i}; }\n`);
    const { index } = await buildIndex({ root });
    saveIndex(index, join(root, '.map-index.json'));
    roots.push(root);
    assert.equal(JSON.parse(callTool('read', { root, ref: `symbol${i}` })).status, 'exact');
  }
  unlinkSync(join(roots[0], '.map-index.json'));
  assert.match(JSON.parse(callTool('read', { root: roots[0], ref: 'symbol0' })).error ?? '', /No code-map index/);
});

test('a running MCP server loads an index created later in a parent', { timeout: 10_000 }, async () => {
  const root = repo({ 'src/m.ts': SRC });
  const nested = join(root, 'one', 'two');
  mkdirSync(nested, { recursive: true });
  const { index } = await buildIndex({ root });
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.MAP_INDEX;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url))], {
    cwd: nested,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  let id = 0;
  const pending = new Map<number, (response: Record<string, unknown>) => void>();
  lines.on('line', (line) => {
    const response = JSON.parse(line) as { id?: number } & Record<string, unknown>;
    if (response.id !== undefined) pending.get(response.id)?.(response);
  });
  const rpc = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 3_000);
      pending.set(requestId, (response) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(response);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  };
  try {
    const before = await rpc('tools/call', { name: 'read', arguments: { ref: 'alpha' } });
    const beforeText = ((before.result as { content: { text: string }[] }).content[0].text);
    assert.match(JSON.parse(beforeText).error ?? '', /No code-map index/);
    saveIndex(index, join(root, '.map-index.json'));
    const after = await rpc('tools/call', { name: 'read', arguments: { ref: 'alpha' } });
    const afterText = ((after.result as { content: { text: string }[] }).content[0].text);
    assert.equal(JSON.parse(afterText).status, 'exact');
  } finally {
    lines.close();
    child.kill();
  }
});

test('changed: working-set delta — symbols in untouched files are unchanged, churned files re-anchor', async () => {
  const root = repo({ 'src/m.ts': SRC, 'src/other.ts': 'export function beta(): number {\n  return 9;\n}\n' });
  const { index } = await buildIndex({ root });
  // Churn ONLY m.ts (shift alpha down); leave other.ts untouched.
  writeFileSync(join(root, 'src/m.ts'), '// pushed down\n// by two lines\n' + SRC);
  const d = changed(index, ['alpha', 'beta']);
  assert.equal(d.filesChanged, 1, 'one file (m.ts) changed');
  assert.deepEqual(d.unchanged, ['src/other.ts#beta'], 'beta in the untouched file → unchanged, no slice');
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].id, 'src/m.ts#alpha');
  assert.equal(d.changed[0].status, 'relocated');
  assert.match(d.changed[0].raw ?? '', /function alpha/, 'changed symbol carries its current slice');
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
  assert.ok(TOOLS[0].inputSchema.properties.root, 'global clients can select the active repository per call');
  const { index } = await buildIndex({
    root: repo({
      'src/u.ts': 'export function helper(): number { return 1; }\n',
      'src/m.ts': "import { helper } from './u.js';\nexport function run(): number { return helper(); }\n",
    }),
  });
  assert.match(JSON.parse(dispatch(index, 'read', { ref: 'helper' })).raw ?? '', /function helper/);
  assert.throws(() => dispatch(index, 'nope', {}), /unknown tool/);
});

test('mcp read batch: refs reads many in one call; validates, dedupes, caps', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/u.ts': 'export function helper(): number { return 1; }\nexport function other(): number { return 2; }\n',
    }),
  });
  // batch: one call, one result per ref, order preserved
  const batch = JSON.parse(dispatch(index, 'read', { refs: ['helper', 'other'] }));
  assert.equal(batch.results.length, 2);
  assert.match(batch.results[0].raw ?? '', /function helper/);
  assert.match(batch.results[1].raw ?? '', /function other/);
  // a missing ref in a batch is reported per-result, not a thrown error
  const withMiss = JSON.parse(dispatch(index, 'read', { refs: ['helper', 'nonexistent_xyz'] }));
  assert.equal(withMiss.results.length, 2);
  assert.notEqual(withMiss.results[1].status, 'exact');
  // dedupe: duplicate refs collapse to one result
  assert.equal(JSON.parse(dispatch(index, 'read', { refs: ['helper', 'helper'] })).results.length, 1);
  // invalid input: both ref and refs, empty refs, neither → error object (no "undefined" symbol search)
  assert.match(JSON.parse(dispatch(index, 'read', { ref: 'helper', refs: ['other'] })).error ?? '', /not both/);
  assert.match(JSON.parse(dispatch(index, 'read', { refs: [] })).error ?? '', /non-empty/);
  assert.match(JSON.parse(dispatch(index, 'read', {})).error ?? '', /Pass `ref`/);
  // cap: >64 refs reads the first 64 and notes the rest
  const many = Array.from({ length: 70 }, (_, i) => `s${i}`);
  const capped = JSON.parse(dispatch(index, 'read', { refs: many }));
  assert.equal(capped.results.length, 64);
  assert.match(capped.note ?? '', /first 64 of 70/);
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
