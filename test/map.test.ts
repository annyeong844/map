import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/core/build-index.ts';
import { gitFileListCommand } from '../src/core/files.ts';
import { autoIndexDecision, scanIndexDrift } from '../src/core/index-drift.ts';
import { locate } from '../src/core/locate.ts';
import { changed, read } from '../src/core/read.ts';
import {
  getPreparedLookup,
  loadIndex,
  prepareLookup,
  saveIndex,
} from '../src/core/store.ts';
import {
  changedSourceFiles,
  discoverLocalModuleFiles,
  sourceIdentitySnapshot,
} from '../src/mcp/source-identity.ts';
import {
  callTool,
  callToolAsync,
  dispatch,
  disposeMcpState,
  MCP_SOURCE_FILES,
  mcpDiagnostics,
  resolveIndexPath,
  sourceIdentityChanged,
  toHostPath,
  TOOLS,
} from '../src/mcp/server.ts';
import {
  applySetup,
  codexMcpMatchesStep,
  setupPlan,
} from '../src/cli/setup.ts';
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

function wideRepo(fileCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'map-wide-'));
  const sourceDir = join(root, 'src');
  mkdirSync(sourceDir);
  for (let index = 0; index < fileCount; index++) {
    writeFileSync(
      join(sourceDir, `file-${index}.ts`),
      `export const value${index} = ${index};\n`,
    );
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

after(disposeMcpState);

test('Codex routing skill discovers a deferred read before falling back', () => {
  const rootSkill = readFileSync(
    new URL('../skills/code-map-retrieval/SKILL.md', import.meta.url),
    'utf8',
  );
  const pluginSkill = readFileSync(
    new URL(
      '../plugins/code-map/skills/code-map-retrieval/SKILL.md',
      import.meta.url,
    ),
    'utf8',
  );
  assert.equal(pluginSkill, rootSkill);
  assert.match(rootSkill, /mcp__code_map__read/);
  assert.match(rootSkill, /before declaring `read` unavailable/);
});

test('CLI and MCP expose the package version from one source', () => {
  const cli = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../src/cli/main.ts', import.meta.url)),
      '--version',
    ],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), VERSION);
});

test('setup plans wire both routing and MCP without mutating by default', () => {
  const root = join('tmp', 'code map');
  const codex = setupPlan('codex', root);
  assert.deepEqual(
    codex.steps.map((step) => step.args),
    [
      ['plugin', 'marketplace', 'add', root],
      ['plugin', 'add', 'code-map@code-map'],
      ['mcp', 'add', 'code-map', '--', 'map-mcp'],
    ],
  );
  const claude = setupPlan('claude', root);
  assert.ok(
    claude.steps.some((step) => step.args.includes('code-map@code-map')),
  );
  assert.ok(claude.steps.some((step) => step.args.includes('map-mcp')));
  const gemini = setupPlan('gemini', root, join('home', 'user'));
  assert.equal(gemini.host, 'gemini');
  assert.equal(gemini.steps.length, 0);
  assert.equal(gemini.files.length, 2);
});

test('Codex setup distinguishes a native map-mcp launcher from a stale source command', () => {
  const plan = setupPlan('codex', join('tmp', 'code-map'));
  assert.equal(plan.host, 'codex');
  if (plan.host !== 'codex') throw new Error('expected a Codex setup plan');
  const step = plan.steps[2];
  assert.equal(
    codexMcpMatchesStep(
      {
        transport: {
          type: 'stdio',
          command: '/home/user/.local/bin/map-mcp',
          args: [],
        },
      },
      step,
    ),
    true,
  );
  assert.equal(
    codexMcpMatchesStep(
      {
        transport: {
          type: 'stdio',
          command: 'cmd.exe',
          args: ['/d', '/c', 'map-mcp.cmd'],
        },
      },
      step,
    ),
    true,
  );
  assert.equal(
    codexMcpMatchesStep(
      {
        transport: {
          type: 'stdio',
          command: '/mnt/c/nvm4w/nodejs/node.exe',
          args: [
            'C:\\nvm4w\\nodejs\\node_modules\\@annyeong844\\code-map\\dist\\mcp\\server.js',
          ],
        },
      },
      step,
    ),
    true,
  );
  assert.equal(
    codexMcpMatchesStep(
      {
        transport: {
          type: 'stdio',
          command: 'node',
          args: ['/mnt/c/work/map/src/mcp/server.ts'],
        },
      },
      step,
    ),
    false,
  );
});

test('Gemini setup merges config and routing rules idempotently', () => {
  const home = repo({
    '.gemini/config/mcp_config.json': JSON.stringify({
      mcpServers: { existing: { command: 'keep-me' } },
    }),
    '.gemini/GEMINI.md': '# Personal rules\n',
  });
  const root = fileURLToPath(new URL('../', import.meta.url));
  const plan = setupPlan('gemini', root, home);
  applySetup(plan);
  applySetup(plan);

  const config = JSON.parse(
    readFileSync(join(home, '.gemini/config/mcp_config.json'), 'utf8'),
  );
  assert.equal(config.mcpServers.existing.command, 'keep-me');
  assert.ok(config.mcpServers['code-map']);
  const rules = readFileSync(join(home, '.gemini/GEMINI.md'), 'utf8');
  assert.equal(rules.match(/<!-- code-map setup:start -->/gu)?.length, 1);
  assert.match(rules, /# Personal rules/);
});

test('Gemini setup distinguishes config I/O, JSON syntax, and root shape', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const malformedHome = repo({
    '.gemini/config/mcp_config.json': '{ broken',
  });
  assert.throws(
    () => {
      applySetup(setupPlan('gemini', root, malformedHome));
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid JSON/);
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    },
  );

  const wrongShapeHome = repo({
    '.gemini/config/mcp_config.json': '[]',
  });
  assert.throws(
    () => applySetup(setupPlan('gemini', root, wrongShapeHome)),
    /root must be an object/,
  );

  const unreadableHome = mkdtempSync(join(tmpdir(), 'map-setup-io-'));
  mkdirSync(join(unreadableHome, '.gemini/config/mcp_config.json'), {
    recursive: true,
  });
  assert.throws(
    () => {
      applySetup(setupPlan('gemini', root, unreadableHome));
    },
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Could not read Gemini MCP config/);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
});

test('index extracts coordinates + an anchor from real source, no meaning, no external graph', async () => {
  const { index } = await buildIndex({ root: repo({ 'src/m.ts': SRC }) });
  const alpha = index.entries.find((e) => e.name === 'alpha')!;
  assert.ok(alpha, 'exported fn indexed');
  assert.equal(typeof alpha.charStart, 'number');
  assert.equal(typeof alpha.charEnd, 'number');
  assert.match(alpha.searchText, /function alpha/);
  assert.equal('summary' in alpha, false);
  // The private helper is covered too — the map parsed it itself.
  const helper = index.entries.find((e) => e.name === 'helper')!;
  assert.ok(helper, 'private fn indexed');
  assert.equal(helper.visibility, 'module-private');
});

test('a local declaration exported by list stays one real, unambiguous symbol', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/m.ts': 'function local(): number { return 1; }\nexport { local };\n',
    }),
  });
  const locals = index.entries.filter((e) => e.name === 'local');
  assert.equal(locals.length, 1);
  assert.equal(locals[0].kind, 'FunctionDeclaration');
  assert.equal(locals[0].visibility, undefined);
  assert.equal(read(index, 'local').status, 'exact');
});

test('export lists promote every overload and merged declaration range', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/overloads.ts': [
        'function f(value: string): string;',
        'function f(value: number): number;',
        'function f(value: string | number) { return value; }',
        'interface Merged { value: number }',
        'namespace Merged { export const tag = "merged"; }',
        'export { f, f as publicF, Merged };',
        '',
      ].join('\n'),
    }),
  });
  const overloads = index.entries.filter(
    (entry) => entry.file === 'src/overloads.ts' && entry.name === 'f',
  );
  assert.equal(overloads.length, 3);
  assert.ok(overloads.every((entry) => entry.visibility === undefined));
  const aliasOverloads = index.entries.filter(
    (entry) => entry.file === 'src/overloads.ts' && entry.name === 'publicF',
  );
  assert.equal(aliasOverloads.length, 3);
  assert.ok(aliasOverloads.every((entry) => entry.kind === 'ExportSpecifier'));
  const merged = index.entries.filter(
    (entry) => entry.file === 'src/overloads.ts' && entry.name === 'Merged',
  );
  assert.equal(merged.length, 2);
  assert.ok(merged.every((entry) => entry.visibility === undefined));
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
  assert.equal(
    getPreparedLookup(portable),
    undefined,
    'one-shot loads stay allocation-light until a long-lived caller opts in',
  );
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
  assert.equal(
    toHostPath('/mnt/c/Users/endof/repo', 'win32'),
    'C:\\Users\\endof\\repo',
  );
  assert.equal(
    toHostPath('C:\\Users\\endof\\repo', 'linux'),
    '/mnt/c/Users/endof/repo',
  );
  assert.equal(
    toHostPath(
      '\\\\wsl.localhost\\Ubuntu\\home\\endof\\repo',
      'linux',
      'Ubuntu',
    ),
    '/home/endof/repo',
  );
  assert.equal(
    toHostPath('//wsl$/Ubuntu/home/endof/repo', 'linux', 'ubuntu'),
    '/home/endof/repo',
  );
  assert.equal(
    toHostPath(
      '\\\\wsl.localhost\\Other\\home\\endof\\repo',
      'linux',
      'Ubuntu',
    ),
    '\\\\wsl.localhost\\Other\\home\\endof\\repo',
  );
  assert.equal(toHostPath('/home/endof/repo', 'linux'), '/home/endof/repo');
});

test('Windows lists a WSL UNC repository through native distro git', () => {
  assert.deepEqual(
    gitFileListCommand('\\\\wsl.localhost\\Ubuntu\\home\\endof\\repo', 'win32'),
    {
      file: 'wsl.exe',
      args: [
        '-d',
        'Ubuntu',
        '--',
        'git',
        '-C',
        '/home/endof/repo',
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ],
    },
  );
  assert.deepEqual(gitFileListCommand('C:\\work\\repo', 'win32'), {
    file: 'git',
    args: [
      '-C',
      'C:\\work\\repo',
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ],
  });
});

test('tracked working-tree deletions do not trigger an endless re-index', async () => {
  const root = repo({
    'src/current.ts': 'export const current = 1;\n',
    'src/deleted.ts': 'export const deleted = 2;\n',
  });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  assert.equal(
    spawnSync('git', ['add', 'src/current.ts', 'src/deleted.ts'], {
      cwd: root,
    }).status,
    0,
  );
  unlinkSync(join(root, 'src/deleted.ts'));

  const first = await buildIndex({ root });
  assert.equal(first.filesIndexed, 1);
  assert.deepEqual(first.filesMissing, []);
  assert.equal(first.index.meta.fileCount, 1);

  const drift = await scanIndexDrift(root, first.index);
  assert.deepEqual(drift.files, ['src/current.ts']);
  assert.equal(drift.totalChanged, 0);
  const second = await buildIndex({ root, previous: first.index });
  assert.equal(second.unchanged, true);
});

test('WSL timestamp rounding is stable without weakening the ctime guard', async () => {
  const root = repo({ 'src/current.ts': 'export const current = 1;\n' });
  const first = await buildIndex({ root });
  const prior = first.index.fileStats['src/current.ts'];
  if (!prior || prior.ctimeMs === undefined) {
    assert.fail('the current index must retain ctime evidence');
  }
  const priorCtimeMs = prior.ctimeMs;
  const withStat = (ctimeDeltaMs: number) => ({
    ...first.index,
    fileStats: {
      ...first.index.fileStats,
      'src/current.ts': {
        ...prior,
        mtimeMs: prior.mtimeMs + 0.000244140625,
        ctimeMs: priorCtimeMs + ctimeDeltaMs,
      },
    },
  });

  const rounded = await scanIndexDrift(root, withStat(0.000244140625));
  assert.equal(rounded.totalChanged, 0);
  const realIdentityChange = await scanIndexDrift(root, withStat(1));
  assert.equal(realIdentityChange.modified, 1);
});

test('a global MCP routes reads across child repositories by absolute root', async () => {
  const container = repo({});
  const firstRoot = join(container, 'first');
  const secondRoot = join(container, 'second');
  mkdirSync(firstRoot, { recursive: true });
  mkdirSync(secondRoot, { recursive: true });
  writeFileSync(
    join(firstRoot, 'a.ts'),
    'export function alpha(): number { return 1; }\n',
  );
  writeFileSync(
    join(secondRoot, 'b.ts'),
    'export function beta(): number { return 2; }\n',
  );
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
  assert.match(
    JSON.parse(callTool('read', { root: 'relative/repo', ref: 'alpha' }))
      .error ?? '',
    /must be absolute/,
  );
});

test('MCP changedOnly compares with the prior read even after an index refresh', async () => {
  const root = repo({
    'src/a.ts': 'export function alpha(): number { return 1; }\n',
    'src/b.ts': 'export function beta(): number { return 2; }\n',
  });
  let built = await buildIndex({ root });
  const indexPath = join(root, '.map-index.json');
  saveIndex(built.index, indexPath);

  const cold = JSON.parse(
    callTool('read', { root, refs: ['alpha', 'beta'], changedOnly: true }),
  );
  assert.deepEqual(cold.unchanged, []);
  assert.deepEqual(
    cold.changed.map((result: { id: string }) => result.id),
    ['src/a.ts#alpha', 'src/b.ts#beta'],
  );

  const initial = JSON.parse(
    callTool('read', { root, refs: ['alpha', 'beta'] }),
  );
  assert.deepEqual(
    initial.results.map((result: { status: string }) => result.status),
    ['exact', 'exact'],
  );

  writeFileSync(
    join(root, 'src/a.ts'),
    'export function alpha(): number { return 10; }\n',
  );
  built = await buildIndex({ root, previous: built.index });
  saveIndex(built.index, indexPath);

  const delta = JSON.parse(
    callTool('read', { root, refs: ['alpha', 'beta'], changedOnly: true }),
  );
  assert.deepEqual(delta.unchanged, ['src/b.ts#beta']);
  assert.equal(delta.changed.length, 1);
  assert.equal(delta.changed[0].id, 'src/a.ts#alpha');
  assert.match(delta.changed[0].raw ?? '', /return 10/);

  const stable = JSON.parse(
    callTool('read', { root, refs: ['alpha', 'beta'], changedOnly: true }),
  );
  assert.deepEqual(stable.unchanged, ['src/a.ts#alpha', 'src/b.ts#beta']);
  assert.deepEqual(stable.changed, []);
});

test('async MCP changedOnly reads edited bytes even when small drift is not rebuilt', async () => {
  const root = repo({
    'src/a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
    'src/b.ts': 'export function beta(): number {\n  return 2;\n}\n',
  });
  const { index } = await buildIndex({ root });
  saveIndex(index, join(root, '.map-index.json'));

  const initial = JSON.parse(
    await callToolAsync('read', {
      root,
      refs: ['alpha', 'beta'],
    }),
  );
  assert.deepEqual(
    initial.results.map((result: { status: string }) => result.status),
    ['exact', 'exact'],
  );

  writeFileSync(
    join(root, 'src/a.ts'),
    'export function alpha(): number {\n  return 9;\n}\n',
  );
  const delta = JSON.parse(
    await callToolAsync('read', {
      root,
      refs: ['alpha', 'beta'],
      changedOnly: true,
      diagnostics: true,
    }),
  );
  assert.deepEqual(delta.unchanged, ['src/b.ts#beta']);
  assert.deepEqual(
    delta.changed.map((result: { id: string }) => result.id),
    ['src/a.ts#alpha'],
  );
  assert.match(delta.changed[0].raw ?? '', /return 9/);
  assert.notEqual(delta._meta.autoIndex?.status, 'rebuilt');

  const stable = JSON.parse(
    await callToolAsync('read', {
      root,
      refs: ['alpha', 'beta'],
      changedOnly: true,
    }),
  );
  assert.deepEqual(stable.unchanged, ['src/a.ts#alpha', 'src/b.ts#beta']);
  assert.deepEqual(stable.changed, []);
});

test('MCP refuses non-string snippet input instead of stringifying objects', async () => {
  const root = repo({ 'src/m.ts': SRC });
  const { index } = await buildIndex({ root });
  const result = JSON.parse(
    dispatch(index, 'read', {
      ref: 'alpha',
      snippet: { untrusted: true },
    }),
  );
  assert.match(result.error ?? '', /snippet.*string/);
});

test('the global MCP bounds warmed repository runtimes', async () => {
  const container = repo({});
  const roots: string[] = [];
  for (let i = 0; i < 9; i++) {
    const root = join(container, `repo-${i}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'm.ts'),
      `export function symbol${i}(): number { return ${i}; }\n`,
    );
    const { index } = await buildIndex({ root });
    saveIndex(index, join(root, '.map-index.json'));
    roots.push(root);
    assert.equal(
      JSON.parse(callTool('read', { root, ref: `symbol${i}` })).status,
      'exact',
    );
  }
  unlinkSync(join(roots[0], '.map-index.json'));
  assert.match(
    JSON.parse(callTool('read', { root: roots[0], ref: 'symbol0' })).error ??
      '',
    /No code-map index/,
  );
});

test('automatic index gate is linear and uses an adaptive large-change threshold', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [
      `src/f${i}.ts`,
      `export function symbol${i}(): number { return ${i}; }\n`,
    ]),
  );
  const root = repo(files);
  const { index } = await buildIndex({ root });

  const current = await scanIndexDrift(root, index);
  assert.deepEqual(autoIndexDecision(current), {
    rebuild: false,
    reason: 'current',
    threshold: 4,
  });

  for (let i = 0; i < 4; i++) {
    writeFileSync(
      join(root, `src/f${i}.ts`),
      `// changed ${i}\nexport function symbol${i}(): number { return ${i + 100}; }\n`,
    );
  }
  const large = await scanIndexDrift(root, index);
  assert.equal(large.totalChanged, 4);
  assert.deepEqual(autoIndexDecision(large), {
    rebuild: true,
    reason: 'large-change',
    threshold: 4,
  });

  const missing = await scanIndexDrift(root, null);
  assert.equal(autoIndexDecision(missing).reason, 'missing-index');
  const incompatible = await scanIndexDrift(root, {
    ...index,
    meta: { ...index.meta, version: index.meta.version - 1 },
  });
  assert.equal(autoIndexDecision(incompatible).reason, 'incompatible-index');
});

test('an active index drift scan observes cancellation', async () => {
  const root = wideRepo(256);
  const controller = new AbortController();
  const scan = scanIndexDrift(root, null, false, controller.signal);
  setImmediate(() => {
    controller.abort(new Error('cancel active drift scan'));
  });
  await assert.rejects(scan, /cancel active drift scan/);
  assert.equal(existsSync(join(root, '.map-index.json')), false);
  rmSync(root, { recursive: true, force: true });
});

test('async MCP lazily creates a missing index and reports its live instance', async () => {
  const root = repo({ 'src/m.ts': SRC });
  const result = JSON.parse(
    await callToolAsync('read', { root, ref: 'alpha', diagnostics: true }),
  );
  assert.equal(result.status, 'exact');
  assert.equal(result._meta.autoIndex.status, 'rebuilt');
  assert.equal(result._meta.autoIndex.reason, 'missing-index');
  assert.equal(result._meta.mcp.pid, process.pid);
  assert.equal(result._meta.mcp.restartRequired, false);
  assert.equal(result._meta.index.root, root);
  assert.equal(result._meta.index.indexPath, join(root, '.map-index.json'));
  assert.match(result._meta.index.watchMode, /^(active|on-call-fallback)$/);
  assert.equal(existsSync(join(root, '.map-index.json')), true);
});

test('an explicit missing child root never overwrites a parent repository index', async () => {
  const parent = repo({
    'src/parent.ts': 'export function parentSymbol(): number { return 1; }\n',
  });
  const parentBuild = await buildIndex({ root: parent });
  const parentIndexPath = join(parent, '.map-index.json');
  saveIndex(parentBuild.index, parentIndexPath);
  const child = join(parent, 'nested-repo');
  mkdirSync(join(child, 'src'), { recursive: true });
  writeFileSync(
    join(child, 'src/child.ts'),
    'export function childSymbol(): number { return 2; }\n',
  );

  const result = JSON.parse(
    await callToolAsync('read', { root: child, ref: 'childSymbol' }),
  );
  assert.equal(result.status, 'exact');
  assert.equal(existsSync(join(child, '.map-index.json')), true);
  assert.equal(
    read(loadIndex(parentIndexPath), 'parentSymbol').status,
    'exact',
  );
  assert.equal(
    read(loadIndex(parentIndexPath), 'childSymbol').status,
    'not-found',
  );
});

test('concurrent reads share one missing-index build', async () => {
  const root = repo({
    'src/a.ts': 'export function alpha(): number { return 1; }\n',
    'src/b.ts': 'export function beta(): number { return 2; }\n',
  });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      callToolAsync('read', { root, ref: i % 2 ? 'alpha' : 'beta' }),
    ),
  );
  for (const text of results) {
    const result = JSON.parse(text);
    assert.equal(result.status, 'exact');
    assert.equal(result._meta.autoIndex.status, 'rebuilt');
    assert.equal(result._meta.autoIndex.reason, 'missing-index');
  }
  assert.equal(loadIndex(join(root, '.map-index.json')).meta.entryCount, 2);
});

test('unique-root auto-index work queues instead of multiplying active builds', async () => {
  const roots = Array.from({ length: 6 }, (_, index) =>
    repo({
      'src/m.ts': `export function symbol${index}(): number { return ${index}; }\n`,
    }),
  );
  const results = await Promise.all(
    roots.map(async (root, index) =>
      JSON.parse(
        await callToolAsync('read', {
          root,
          ref: `symbol${index}`,
          diagnostics: true,
        }),
      ),
    ),
  );
  assert.ok(results.every((result) => result.status === 'exact'));
  const admission = mcpDiagnostics().indexAdmission;
  assert.equal(admission.limit, 2);
  assert.equal(admission.active, 0);
  assert.equal(admission.queued, 0);
  assert.equal(admission.maxActive, 2);
  assert.ok(admission.maxQueued >= roots.length - admission.limit);
});

test('a requested new symbol rebuilds small drift and retries once', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [
      `src/f${i}.ts`,
      `export function symbol${i}(): number { return ${i}; }\n`,
    ]),
  );
  const root = repo(files);
  const { index } = await buildIndex({ root });
  saveIndex(index, join(root, '.map-index.json'));
  writeFileSync(
    join(root, 'src/fresh.ts'),
    'export function freshSymbol(): number { return 42; }\n',
  );

  const result = JSON.parse(
    await callToolAsync('read', { root, ref: 'freshSymbol' }),
  );
  assert.equal(result.status, 'exact');
  assert.equal(result._meta.autoIndex.status, 'rebuilt');
  assert.equal(result._meta.autoIndex.reason, 'requested-symbol-missing');
  assert.equal(result._meta.autoIndex.changed, 1);
});

test('compact reads preserve the requested-symbol retry and rebuild evidence', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [
      `src/f${i}.ts`,
      `export function symbol${i}(): number { return ${i}; }\n`,
    ]),
  );
  const root = repo(files);
  const { index } = await buildIndex({ root });
  saveIndex(index, join(root, '.map-index.json'));
  writeFileSync(
    join(root, 'src/fresh.ts'),
    'export function compactFresh(): number { return 43; }\n',
  );

  const result = await callToolAsync('read', {
    root,
    ref: 'compactFresh',
    responseFormat: 'compact',
  });
  assert.match(result, /^\[exact src\/fresh\.ts#compactFresh @1-1\]/u);
  assert.match(result, /function compactFresh/u);
  assert.match(result, /\[meta\].*"reason":"requested-symbol-missing"/u);
});

test('large drift rebuilds before an unchanged target is read', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [
      `src/f${i}.ts`,
      `export function symbol${i}(): number { return ${i}; }\n`,
    ]),
  );
  const root = repo(files);
  const { index } = await buildIndex({ root });
  saveIndex(index, join(root, '.map-index.json'));
  const primed = JSON.parse(
    await callToolAsync('read', { root, ref: 'symbol15', diagnostics: true }),
  );
  assert.equal(primed._meta.autoIndex.status, 'current');
  for (let i = 0; i < 4; i++) {
    writeFileSync(
      join(root, `src/f${i}.ts`),
      `export function symbol${i}(): number { return ${i}; }\nexport function changed${i}(): number { return ${i + 10}; }\n`,
    );
  }
  await new Promise<void>((resolve) => {
    setTimeout(
      resolve,
      primed._meta.index.watchMode === 'active' ? 100 : 2_100,
    );
  });

  const result = JSON.parse(
    await callToolAsync('read', { root, ref: 'symbol15' }),
  );
  assert.equal(result.status, 'exact');
  assert.equal(result._meta.autoIndex.reason, 'large-change');
  assert.equal(result._meta.autoIndex.changed, 4);
  assert.equal(
    read(loadIndex(join(root, '.map-index.json')), 'changed0').status,
    'exact',
  );
});

test('MCP source identity diagnostics require a restart only after change', () => {
  const identity = { mtimeMs: 1, size: 2, ctimeMs: 3, ino: 4 };
  assert.equal(sourceIdentityChanged(identity, { ...identity }), false);
  assert.equal(sourceIdentityChanged(identity, { ...identity, size: 5 }), true);
  assert.equal(sourceIdentityChanged(null, null), false);
  assert.equal(sourceIdentityChanged(identity, null), true);
});

test('MCP source identity diagnostics cover transitive local modules', () => {
  const root = repo({
    'entry.ts': "import './dep.js';\n",
    'dep.ts': "export { value } from './leaf';\n",
    'leaf.ts': 'export const value = 1;\n',
  });
  try {
    const canonicalRoot = realpathSync(root);
    const files = discoverLocalModuleFiles(join(root, 'entry.ts'));
    assert.deepEqual(
      files.map((file) => relative(canonicalRoot, file)),
      ['dep.ts', 'entry.ts', 'leaf.ts'],
    );
    const snapshot = sourceIdentitySnapshot(files);
    writeFileSync(
      join(root, 'leaf.ts'),
      'export const value = 200; // changed after startup\n',
    );
    assert.deepEqual(
      changedSourceFiles(snapshot).map((file) => relative(canonicalRoot, file)),
      ['leaf.ts'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP source identity manifest covers its complete local module graph', () => {
  const serverFile = fileURLToPath(
    new URL('../src/mcp/server.ts', import.meta.url),
  );
  assert.deepEqual(MCP_SOURCE_FILES, discoverLocalModuleFiles(serverFile));
});

test(
  'MCP initializes before repository work and exits on stdin EOF',
  { timeout: 10_000 },
  async () => {
    const root = repo({ 'src/m.ts': SRC });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODE_MAP_AUTO_INDEX: 'off',
    };
    delete env.MAP_INDEX;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url))],
      {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const lines = createInterface({ input: child.stdout });
    try {
      const response = once(lines, 'line', {
        signal: AbortSignal.timeout(3_000),
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2099-01-01',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        }) + '\n',
      );
      const [line] = await response;
      const message = JSON.parse(line as string);
      assert.equal(
        message.result.protocolVersion,
        '2025-06-18',
        'server must advertise the protocol it actually supports',
      );
      assert.equal(message.result.serverInfo.name, 'code-map');
      assert.equal(message.result.runtime.version, VERSION);
      assert.match(message.result.runtime.instanceId, /^\d+:/);
      assert.equal(message.result.runtime.restartRequired, false);
      assert.ok(
        message.result.instructions.length <= 500,
        `initialize instructions regressed to ${message.result.instructions.length} characters`,
      );
      assert.match(message.result.instructions, /Known symbol.*read/);
      assert.match(message.result.instructions, /Unknown.*rg/);
      assert.match(message.result.instructions, /absolute repository root/);
      assert.match(message.result.instructions, /raw source/);
      assert.match(
        message.result.runtime.serverFile,
        /src[\\/]mcp[\\/]server\.ts$/,
      );

      const exited = once(child, 'exit', {
        signal: AbortSignal.timeout(3_000),
      });
      child.stdin.end();
      const [code] = await exited;
      assert.equal(code, 0);
    } finally {
      lines.close();
      if (child.exitCode == null && child.signalCode == null) {
        const killed = once(child, 'exit');
        child.kill();
        await killed;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'a running MCP loads a later index and reports edited bytes through changedOnly',
  { timeout: 10_000 },
  async () => {
    const root = repo({ 'src/m.ts': SRC });
    const nested = join(root, 'one', 'two');
    mkdirSync(nested, { recursive: true });
    const { index } = await buildIndex({ root });
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.MAP_INDEX;
    env.CODE_MAP_AUTO_INDEX = 'off';
    env.CODE_MAP_MAX_INFLIGHT_REQUESTS = '2';
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url))],
      {
        cwd: nested,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const lines = createInterface({ input: child.stdout });
    let id = 0;
    const pending = new Map<
      number,
      (response: Record<string, unknown>) => void
    >();
    lines.on('line', (line) => {
      const response = JSON.parse(line) as { id?: number } & Record<
        string,
        unknown
      >;
      if (response.id !== undefined) pending.get(response.id)?.(response);
    });
    const rpc = (
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`MCP request timed out: ${method}`)),
          3_000,
        );
        pending.set(requestId, (response) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(response);
        });
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) +
            '\n',
        );
      });
    };
    try {
      const before = await rpc('tools/call', {
        name: 'read',
        arguments: { ref: 'alpha' },
      });
      const beforeText = (before.result as { content: { text: string }[] })
        .content[0].text;
      assert.match(JSON.parse(beforeText).error ?? '', /No code-map index/);

      const invalid = await rpc('tools/call', {
        name: 'read',
        arguments: { refs: ['alpha', { coerced: 'before' }] },
      });
      assert.equal((invalid.error as { code?: number })?.code, -32602);
      assert.match(
        (invalid.error as { data?: { detail?: string } })?.data?.detail ?? '',
        /Every `refs` element/,
      );
      saveIndex(index, join(root, '.map-index.json'));
      const afterIndex = await rpc('tools/call', {
        name: 'read',
        arguments: { ref: 'alpha' },
      });
      const afterText = (afterIndex.result as { content: { text: string }[] })
        .content[0].text;
      assert.equal(JSON.parse(afterText).status, 'exact');

      writeFileSync(join(root, 'src/m.ts'), SRC.replace('x + 1', 'x + 2'));
      const refreshed = await buildIndex({ root, previous: index });
      saveIndex(refreshed.index, join(root, '.map-index.json'));

      const deltaResponse = await rpc('tools/call', {
        name: 'read',
        arguments: { refs: ['alpha'], changedOnly: true },
      });
      const deltaText = (
        deltaResponse.result as { content: { text: string }[] }
      ).content[0].text;
      const delta = JSON.parse(deltaText);
      assert.deepEqual(delta.unchanged, []);
      assert.equal(delta.changed.length, 1);
      assert.equal(delta.changed[0].id, 'src/m.ts#alpha');
      assert.match(delta.changed[0].raw ?? '', /x \+ 2/);

      const stableResponse = await rpc('tools/call', {
        name: 'read',
        arguments: { refs: ['alpha'], changedOnly: true },
      });
      const stableText = (
        stableResponse.result as { content: { text: string }[] }
      ).content[0].text;
      assert.deepEqual(JSON.parse(stableText).unchanged, ['src/m.ts#alpha']);
      assert.deepEqual(JSON.parse(stableText).changed, []);

      const pings = await Promise.all(
        Array.from({ length: 6 }, () => rpc('ping', {})),
      );
      const runtimes = pings.map(
        (response) =>
          (
            response.result as {
              runtime: {
                maxInflightRequests: number;
                maxObservedMcpRequests: number;
              };
            }
          ).runtime,
      );
      assert.ok(runtimes.every((runtime) => runtime.maxInflightRequests === 2));
      assert.ok(
        runtimes.every((runtime) => runtime.maxObservedMcpRequests <= 2),
      );
    } finally {
      lines.close();
      child.kill();
    }
  },
);

test(
  'stdin EOF aborts an active index scan before it can publish an index',
  { timeout: 20_000 },
  async () => {
    const root = wideRepo(512);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODE_MAP_AUTO_INDEX: 'on',
      CODE_MAP_MAX_INFLIGHT_REQUESTS: '2',
    };
    delete env.MAP_INDEX;
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url))],
      {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const lines = createInterface({ input: child.stdout });
    let id = 1;
    const pending = new Map<
      number,
      (response: Record<string, unknown>) => void
    >();
    lines.on('line', (line) => {
      const response = JSON.parse(line) as { id?: number } & Record<
        string,
        unknown
      >;
      if (response.id !== undefined) pending.get(response.id)?.(response);
    });
    const ping = (): Promise<Record<string, unknown>> => {
      const requestId = ++id;
      return new Promise((resolveResponse, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`MCP ping timed out: ${stderr}`)),
          3000,
        );
        pending.set(requestId, (response) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolveResponse(response);
        });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'ping', params: {} })}\n`,
        );
      });
    };
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'read',
            arguments: { root, ref: 'value511' },
          },
        })}\n`,
      );
      let observedActiveScan = false;
      const deadline = Date.now() + 3000;
      while (!observedActiveScan && Date.now() < deadline) {
        const response = await ping();
        const runtime = (
          response.result as {
            runtime: { indexAdmission: { active: number } };
          }
        ).runtime;
        observedActiveScan = runtime.indexAdmission.active === 1;
      }
      assert.equal(
        observedActiveScan,
        true,
        `the index scan was never observed as active: ${stderr}`,
      );
      assert.equal(existsSync(join(root, '.map-index.json')), false);

      const exited = once(child, 'exit', {
        signal: AbortSignal.timeout(3000),
      });
      child.stdin.end();
      const [code] = await exited;
      assert.equal(code, 0, stderr);
      assert.equal(existsSync(join(root, '.map-index.json')), false);
    } finally {
      lines.close();
      if (child.exitCode == null && child.signalCode == null) {
        const killed = once(child, 'exit');
        child.kill();
        await killed;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('changed: working-set delta — symbols in untouched files are unchanged, churned files re-anchor', async () => {
  const root = repo({
    'src/m.ts': SRC,
    'src/other.ts': 'export function beta(): number {\n  return 9;\n}\n',
  });
  const { index } = await buildIndex({ root });
  // Churn ONLY m.ts (shift alpha down); leave other.ts untouched.
  writeFileSync(
    join(root, 'src/m.ts'),
    '// pushed down\n// by two lines\n' + SRC,
  );
  const d = changed(index, ['alpha', 'beta']);
  assert.equal(d.filesChanged, 1, 'one file (m.ts) changed');
  assert.deepEqual(
    d.unchanged,
    ['src/other.ts#beta'],
    'beta in the untouched file → unchanged, no slice',
  );
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].id, 'src/m.ts#alpha');
  assert.equal(d.changed[0].status, 'relocated');
  assert.match(
    d.changed[0].raw ?? '',
    /function alpha/,
    'changed symbol carries its current slice',
  );
});

test('locate ranks exact above fuzzy', async () => {
  const { index } = await buildIndex({ root: repo({ 'src/m.ts': SRC }) });
  const hits = locate(index, 'alpha');
  assert.equal(hits[0].name, 'alpha');
  assert.equal(hits[0].match, 'exact');
});

test('an exact path ref never promotes a different fuzzy symbol to exact', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/provider.ts':
        'export function createDependencyProvider(): string { return "provider"; }\n',
    }),
  });
  const ref = 'src/provider.ts#DependencyProvider';

  for (const prepared of [false, true]) {
    if (prepared) prepareLookup(index);
    const result = read(index, ref);
    assert.notEqual(result.status, 'exact');
    assert.equal(result.raw, null);
    assert.notEqual(result.id, 'src/provider.ts#createDependencyProvider');
  }

  assert.equal(
    locate(index, 'src/provider.ts#DependencyProvider')[0]?.name,
    'createDependencyProvider',
    'explicit discovery remains fuzzy; only read resolution is strict',
  );
});

test('read returns the exact source when the file is unchanged', async () => {
  const { index } = await buildIndex({ root: repo({ 'src/m.ts': SRC }) });
  const r = read(index, index.entries.find((e) => e.name === 'alpha')!.id);
  assert.equal(r.status, 'exact');
  assert.equal(
    r.raw,
    'export function alpha(x: number): number {\n  return x + 1;\n}',
  );
});

test('read preserves direct top-level export syntax for every declaration shape', async () => {
  const declarations = {
    alpha: 'export function alpha(): number { return 1; }',
    Beta: 'export class Beta { method(): number { return 2; } }',
    Decorated: '@sealed\nexport class Decorated {}',
    gamma: 'export const gamma = 3, delta = 4;',
    delta: 'export const gamma = 3, delta = 4;',
    Shape: 'export interface Shape { value: number }',
    Alias: 'export type Alias = string | number;',
    Choice: 'export enum Choice { One }',
    ambient: 'export declare function ambient(value: number): void;',
    boundOne:
      'export const { boundOne, nested: { boundTwo }, ...boundRest } = source;',
    boundTwo:
      'export const { boundOne, nested: { boundTwo }, ...boundRest } = source;',
    boundRest:
      'export const { boundOne, nested: { boundTwo }, ...boundRest } = source;',
    firstBound:
      'export const [firstBound, , thirdBound = 3, ...tailBound] = values;',
    thirdBound:
      'export const [firstBound, , thirdBound = 3, ...tailBound] = values;',
    tailBound:
      'export const [firstBound, , thirdBound = 3, ...tailBound] = values;',
    omega: 'export default function omega(): number { return 5; }',
  } as const;
  const root = repo({
    'src/exports.ts': `${[...new Set(Object.values(declarations))].join('\n')}\n`,
  });
  const { index } = await buildIndex({ root });

  for (const [name, expected] of Object.entries(declarations)) {
    const entry = index.entries.find((candidate) => candidate.name === name);
    assert.ok(entry, `${name} is indexed`);
    const result = read(index, entry.id);
    assert.equal(result.status, 'exact');
    assert.equal(result.raw, expected, `${name} keeps its export wrapper`);
  }

  const method = index.entries.find((candidate) => candidate.name === 'method');
  assert.ok(method, 'class method is indexed');
  assert.equal(
    read(index, method.id).raw,
    'method(): number { return 2; }',
    'nested methods keep their own declaration boundary',
  );
});

test('read preserves the wrapper of an anonymous default export', async () => {
  const source = 'export default (): number => 1;';
  const { index } = await buildIndex({
    root: repo({ 'src/default.ts': `${source}\n` }),
  });
  const entry = index.entries.find((candidate) => candidate.name === 'default');
  assert.ok(entry, 'default export is indexed');
  assert.equal(read(index, entry.id).raw, source);
});

test('class methods are indexed with exact coordinates', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/c.ts':
        'export class Foo {\n  bar(n: number): number {\n    return n * 2;\n  }\n}\n',
    }),
  });
  const bar = index.entries.find((e) => e.name === 'bar')!;
  assert.ok(bar, 'method indexed');
  assert.equal(bar.kind, 'ClassMethod');
  assert.equal(bar.className, 'Foo');
  const r = read(index, bar.id);
  assert.equal(r.status, 'exact');
  assert.match(r.raw, /bar\(n: number\): number/);
});

test('dynamic computed class keys do not invent method identities', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/computed.ts':
        'const key = "dynamic";\nexport class Computed {\n  [key](): void {}\n  ["fixed"](): void {}\n  [""](): void {}\n}\n',
    }),
  });
  assert.equal(
    index.entries.some(
      (entry) => entry.className === 'Computed' && entry.name === 'key',
    ),
    false,
  );
  const fixed = index.entries.find(
    (entry) => entry.className === 'Computed' && entry.name === 'fixed',
  );
  assert.equal(fixed?.kind, 'ClassMethod');
  assert.match(read(index, fixed!.id).raw ?? '', /^\["fixed"\]/);
  const empty = index.entries.find(
    (entry) => entry.className === 'Computed' && entry.name === '',
  );
  assert.equal(empty?.kind, 'ClassMethod');
  assert.match(read(index, empty!.id).raw ?? '', /^\[""\]/);
});

test('read re-anchors via searchText after the file drifts', async () => {
  const root = repo({ 'src/m.ts': SRC });
  const { index } = await buildIndex({ root });
  const alpha = index.entries.find((e) => e.name === 'alpha')!;
  writeFileSync(join(root, 'src/m.ts'), '// A\n// B\n// C\n' + SRC);
  const r = read(index, alpha.id);
  assert.equal(r.status, 'relocated');
  assert.match(r.raw, /function alpha/);
  assert.equal(r.line, alpha.line + 3);
});

test('read refreshes the dirty AST boundary when a function grows', async () => {
  const root = repo({
    'src/grows.ts':
      'export function alpha(): number {\n  return 1;\n}\n\nexport function beta(): number {\n  return 2;\n}\n',
  });
  const { index } = await buildIndex({ root });
  const alpha = index.entries.find((entry) => entry.name === 'alpha')!;
  writeFileSync(
    join(root, 'src/grows.ts'),
    'export function alpha(): number {\n  const first = 1;\n  const second = 2;\n  // tail added after indexing\n  return first + second;\n}\n\nexport function beta(): number {\n  return 2;\n}\n',
  );

  const result = read(index, alpha.id, {
    snippet: 'return first + second;',
  });
  assert.equal(result.status, 'relocated');
  assert.match(result.raw ?? '', /tail added after indexing/);
  assert.match(result.raw ?? '', /return first \+ second/);
  assert.doesNotMatch(result.raw ?? '', /function beta/);
  assert.equal(result.aim?.status, 'hit');

  const delta = changed(index, [alpha.id]);
  assert.equal(delta.changed.length, 1);
  assert.match(delta.changed[0].raw ?? '', /return first \+ second/);
});

test('read reports anchor-lost when the signature anchor is destroyed', async () => {
  const root = repo({ 'src/m.ts': SRC });
  const { index } = await buildIndex({ root });
  const alpha = index.entries.find((e) => e.name === 'alpha')!;
  // Rewrite the file so alpha's signature line no longer exists anywhere — the
  // searchText anchor can't re-anchor, so read must confess it lost the symbol.
  writeFileSync(
    join(root, 'src/m.ts'),
    '// alpha was rewritten elsewhere\nexport const z = 1;\n',
  );
  const r = read(index, alpha.id);
  assert.equal(r.status, 'anchor-lost');
  assert.equal(r.raw, null);
});

test('incremental rebuild reuses unchanged files, re-reads changed ones', async () => {
  const root = repo({
    'src/a.ts':
      'function helperA(){ return 1; }\nexport function aaa(){ return helperA(); }\n',
    'src/b.ts': 'export function bbb(){ return 2; }\n',
  });
  const first = await buildIndex({ root });
  assert.equal(first.changed, 2);
  assert.equal(first.reused, 0);

  const second = await buildIndex({ root, previous: first.index });
  assert.equal(second.reused, 2);
  assert.equal(second.changed, 0);
  assert.equal(second.unchanged, true);

  writeFileSync(
    join(root, 'src/a.ts'),
    'function helperA(){ return 1; }\nfunction helperA2(){ return 3; }\nexport function aaa(){ return helperA() + helperA2(); }\n',
  );
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
      'pkg/dup.ts':
        'export function dup(): number { return 1; }\nexport function lonely(): number { return 9; }\n',
      'vendor/dup.ts': 'export function dup(): number { return 1; }\n',
      // Two files import the canonical pkg/dup; none import the vendored copy.
      'src/x.ts':
        "import { dup } from '../pkg/dup.ts';\nexport function x() { return dup(); }\n",
      'src/y.ts':
        "import { dup } from '../pkg/dup';\nexport function y() { return dup(); }\n",
    }),
  });
  const canonical = index.entries.find(
    (e) => e.file === 'pkg/dup.ts' && e.name === 'dup',
  )!;
  const vendored = index.entries.find(
    (e) => e.file === 'vendor/dup.ts' && e.name === 'dup',
  )!;
  const lonely = index.entries.find((e) => e.name === 'lonely')!;
  assert.equal(
    canonical.fanIn,
    2,
    'imported by x.ts and y.ts (incl. extensionless specifier)',
  );
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
      'src/a.ts':
        "import { shared } from './dep.js';\nexport function a() { return shared(); }\n",
      'src/sub/b.mts':
        "import { shared } from '../dep.js';\nexport function b() { return shared(); }\n",
    }),
  });
  const shared = index.entries.find(
    (e) => e.name === 'shared' && e.file === 'src/dep.ts',
  )!;
  assert.equal(
    shared.fanIn,
    2,
    "'./dep.js' and '../dep.js' both resolve to dep.ts",
  );
});

test('concept query ranks the acting function over a same-keyword type', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/diff.ts':
        [
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
      'src/m.ts':
        [
          'export function impl(x: number): number { return x * 2; }', // exported, used intra-file, not imported
          'export const api = { run: impl };', // api references impl
          'export function reallyDead(): void {}', // exported, referenced nowhere at all
        ].join('\n') + '\n',
      'src/use.ts':
        "import { api } from './m.js';\nexport function u() { return api.run(2); }\n",
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

test('named default declarations keep real kinds and every class method shape is indexed', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/w.ts': 'export default function widget(): number { return 1; }\n',
      'src/c.ts':
        'export default class Bar {\n  greet(): string { return "hi"; }\n}\n',
      'src/shape.ts':
        'export default interface WidgetShape { value: number }\n',
      'src/abstract.ts':
        'export default abstract class AbstractWidget {\n  abstract run(): void;\n  #hidden(): void {}\n}\n',
      'src/anon.ts': 'export default function (): void {}\n',
      'src/anon-class.ts':
        'export default class {\n  act(): number { return 1; }\n}\n',
    }),
  });
  // #2: real AST kind, not 'default' (so --kind filters work); locatable by name.
  assert.equal(
    index.entries.find((e) => e.name === 'widget')?.kind,
    'FunctionDeclaration',
  );
  assert.equal(
    index.entries.find((e) => e.name === 'Bar')?.kind,
    'ClassDeclaration',
  );
  const shape = index.entries.find((e) => e.name === 'WidgetShape');
  assert.equal(shape?.kind, 'TSInterfaceDeclaration');
  assert.equal(shape?.default, true);
  assert.match(read(index, shape!.id).raw ?? '', /^export default interface/);
  // #1: methods of a default-exported class are extracted.
  const greet = index.entries.find((e) => e.name === 'greet');
  assert.ok(greet && greet.className === 'Bar', 'default class method indexed');
  assert.equal(greet.namePath, undefined, 'className already owns the path');
  assert.equal(greet.id, 'src/c.ts#greet', 'legacy method id stays stable');
  const hierarchicalRead = read(index, 'src/c.ts#Bar/greet');
  assert.equal(hierarchicalRead.status, 'exact');
  assert.match(hierarchicalRead.raw ?? '', /^greet\(\): string/);
  const abstractMethod = index.entries.find(
    (e) => e.name === 'run' && e.className === 'AbstractWidget',
  );
  assert.equal(abstractMethod?.kind, 'ClassMethod');
  assert.match(read(index, abstractMethod!.id).raw ?? '', /^abstract run\(\)/);
  const privateMethod = index.entries.find(
    (e) => e.name === 'hidden' && e.className === 'AbstractWidget',
  );
  assert.equal(privateMethod?.visibility, 'private');
  assert.match(read(index, privateMethod!.id).raw ?? '', /^#hidden\(\)/);
  const anonymousFunction = index.entries.find(
    (e) => e.file === 'src/anon.ts' && e.name === 'default',
  );
  assert.equal(anonymousFunction?.kind, 'FunctionDeclaration');
  assert.equal(anonymousFunction?.default, true);
  const anonymousMethod = index.entries.find(
    (e) => e.file === 'src/anon-class.ts' && e.name === 'act',
  );
  assert.equal(anonymousMethod?.className, 'default');
  assert.equal(read(index, 'src/anon-class.ts#default/act').status, 'exact');
});

test('read --snippet designates a sub-symbol char range and flags intra-symbol ambiguity', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/f.ts':
        'export function f(): number {\n  const x = 1;\n  return x + 1;\n}\nexport function g(): void {\n  a();\n  a();\n}\nfunction a(): void {}\n',
    }),
  });
  const fId = index.entries.find((e) => e.name === 'f')!.id;
  const hit = read(index, fId, { snippet: 'const x = 1' });
  assert.equal(hit.aim?.status, 'hit');
  assert.equal(hit.aim?.matches.length, 1);
  assert.ok(hit.raw?.includes('const x = 1'), 'still returns the raw too');
  // snippet that occurs twice inside g → ambiguous (another "classroom" in the building)
  const amb = read(index, index.entries.find((e) => e.name === 'g')!.id, {
    snippet: 'a();',
  });
  assert.equal(amb.aim?.status, 'ambiguous');
  assert.equal(amb.aim?.matches.length, 2);
  // snippet from g must NOT match inside f — search is scoped to the symbol
  assert.equal(
    read(index, fId, { snippet: 'a();' }).aim?.status,
    'not-in-symbol',
  );
});

test('read flags ambiguous relocation when the signature anchor matches multiple sites', async () => {
  const root = repo({
    'src/m.ts': 'export function widget(): number {\n  return 1;\n}\n',
  });
  const { index } = await buildIndex({ root });
  const widget = index.entries.find((e) => e.name === 'widget')!;
  // Change the file (token differs → re-anchor path) AND make the signature line
  // occur twice, so the anchor is ambiguous.
  writeFileSync(
    join(root, 'src/m.ts'),
    '// export function widget(): number {   (old, duplicated)\nexport function widget(): number {\n  return 2;\n}\n',
  );
  const r = read(index, widget.id);
  assert.equal(r.status, 'ambiguous');
  assert.ok(
    r.candidates.length >= 2,
    'returns the multiple candidate anchor sites',
  );
});

test('mcp server: the only tool is read; dispatch routes it over a given index', async () => {
  assert.equal(TOOLS.length, 1);
  assert.equal(TOOLS[0].name, 'read');
  assert.ok(
    JSON.stringify(TOOLS[0]).length <= 1_600,
    'the always-visible read schema should stay compact',
  );
  assert.ok(
    TOOLS[0].inputSchema.properties.root,
    'global clients can select the active repository per call',
  );
  const { index } = await buildIndex({
    root: repo({
      'src/u.ts': 'export function helper(): number { return 1; }\n',
      'src/m.ts':
        "import { helper } from './u.js';\nexport function run(): number { return helper(); }\n",
    }),
  });
  assert.match(
    JSON.parse(dispatch(index, 'read', { ref: 'helper' })).raw ?? '',
    /function helper/,
  );
  assert.throws(() => dispatch(index, 'nope', {}), /unknown tool/);
});

test('mcp read batch: refs reads many in one call; validates, dedupes, caps', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/u.ts':
        'export function helper(): number { return 1; }\nexport function other(): number { return 2; }\n',
    }),
  });
  // batch: one call, one result per ref, order preserved
  const batchText = dispatch(index, 'read', { refs: ['helper', 'other'] });
  const batch = JSON.parse(batchText);
  assert.equal(batch.results.length, 2);
  assert.match(batch.results[0].raw ?? '', /function helper/);
  assert.match(batch.results[1].raw ?? '', /function other/);
  const compact = dispatch(index, 'read', {
    refs: ['src/u.ts#helper', 'src/u.ts#other'],
    responseFormat: 'compact',
  });
  assert.match(compact, /^\[exact helper @1-1\]/u);
  assert.match(compact, /\[exact other @2-2\]/u);
  assert.match(compact, /function helper/u);
  assert.match(compact, /function other/u);
  assert.doesNotMatch(compact, /"raw":/u);
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(batchText));

  const observations = new Map<string, string>();
  dispatch(
    index,
    'read',
    { refs: ['src/u.ts#helper'], responseFormat: 'compact' },
    observations,
  );
  const compactDelta = dispatch(
    index,
    'read',
    {
      refs: ['src/u.ts#helper'],
      changedOnly: true,
      responseFormat: 'compact',
    },
    observations,
  );
  assert.match(compactDelta, /^\[delta files=0\/1\]/u);
  assert.match(compactDelta, /unchanged: src\/u\.ts#helper/u);
  assert.match(compactDelta, /changed: none/u);
  // a missing ref in a batch is reported per-result, not a thrown error
  const withMiss = JSON.parse(
    dispatch(index, 'read', { refs: ['helper', 'nonexistent_xyz'] }),
  );
  assert.equal(withMiss.results.length, 2);
  assert.notEqual(withMiss.results[1].status, 'exact');
  // dedupe: duplicate refs collapse to one result
  assert.equal(
    JSON.parse(dispatch(index, 'read', { refs: ['helper', 'helper'] })).results
      .length,
    1,
  );
  // invalid input: both ref and refs, empty refs, neither → error object (no "undefined" symbol search)
  assert.match(
    JSON.parse(dispatch(index, 'read', { ref: 'helper', refs: ['other'] }))
      .error ?? '',
    /not both/,
  );
  assert.match(
    JSON.parse(dispatch(index, 'read', { refs: [] })).error ?? '',
    /non-empty/,
  );
  assert.match(
    JSON.parse(dispatch(index, 'read', { refs: ['helper', {}] })).error ?? '',
    /Every `refs` element/,
  );
  assert.match(
    JSON.parse(
      dispatch(index, 'read', { refs: ['helper'], changedOnly: 'false' }),
    ).error ?? '',
    /`changedOnly` must be a boolean/,
  );
  assert.match(
    JSON.parse(dispatch(index, 'read', { ref: 'helper', diagnostics: 'true' }))
      .error ?? '',
    /`diagnostics` must be a boolean/,
  );
  assert.match(
    JSON.parse(
      dispatch(index, 'read', { ref: 'helper', responseFormat: 'xml' }),
    ).error ?? '',
    /`responseFormat` must be `json` or `compact`/,
  );
  assert.match(
    JSON.parse(dispatch(index, 'read', {})).error ?? '',
    /Pass `ref`/,
  );
  // cap: >64 refs reads the first 64 and notes the rest
  const many = Array.from({ length: 70 }, (_, i) => `s${i}`);
  const capped = JSON.parse(dispatch(index, 'read', { refs: many }));
  assert.equal(capped.results.length, 64);
  assert.match(capped.note ?? '', /first 64 of 70/);
});

test('re-exported imports are not indexed as barrel symbols', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/parser.ts':
        'export function isResetIntent(): boolean {\n  return true;\n}\n',
      'src/pipeline.ts':
        "import { isResetIntent } from './parser.js';\nexport { isResetIntent };\nexport function run(): boolean {\n  return isResetIntent();\n}\n",
      'src/barrel.ts': "export { isResetIntent } from './parser.js';\n",
    }),
  });
  // isResetIntent has ONE definition — parser.ts. The barrel/re-export sites must
  // not be indexed as their own symbols (that shadows the real definition).
  const files = [
    ...new Set(
      index.entries
        .filter((e) => e.name === 'isResetIntent')
        .map((e) => e.file),
    ),
  ];
  assert.deepEqual(
    files,
    ['src/parser.ts'],
    'isResetIntent indexed only at its real definition',
  );
});

test('snippet aim never escapes the symbol: a stale file does not match another symbol', async () => {
  const root = repo({
    'm.ts':
      'export function foo() {\n  return 1\n}\n\nexport function bar() {\n  const SECRET = 2\n  return SECRET\n}\n',
  });
  const { index } = await buildIndex({ root });
  const foo = index.entries.find((e) => e.name === 'foo')!;
  // Change the file so the token goes stale, but leave foo's signature line intact.
  writeFileSync(
    join(root, 'm.ts'),
    'export function foo() {\n  return 1\n}\n\nexport function bar() {\n  const SECRET = 2 // touched\n  return SECRET\n}\n// trailing change\n',
  );
  // `SECRET` lives only in bar. Aiming it while reading foo must NOT report `hit`.
  const r = read(index, foo.id, { snippet: 'SECRET' });
  assert.notEqual(
    r.aim?.status,
    'hit',
    'a snippet from another symbol must not be an in-symbol hit',
  );
  assert.ok(
    r.aim &&
      (r.aim.status === 'not-in-symbol' || r.aim.status === 'unanchored'),
    `expected not-in-symbol/unanchored, got ${r.aim?.status}`,
  );
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
  assert.ok(
    locate(second.index, 'bravo').some((h) => h.file === 'src/m.ts'),
    'same-size mtime-restored edit detected',
  );
  assert.equal(
    locate(second.index, 'alpha').filter((h) => h.file === 'src/m.ts').length,
    0,
    'stale alpha entry dropped',
  );
});

test('read refuses a path that escapes the index root (traversal / untrusted index)', async () => {
  const root = repo({ 'src/m.ts': SRC });
  const { index } = await buildIndex({ root });
  // A malicious or corrupted index entry pointing outside the project root.
  const evil = {
    ...index.entries[0],
    id: 'evil#x',
    file: '../../../../../../etc/hostname',
    name: 'x',
    charStart: 0,
    charEnd: 8,
  };
  const r = read({ ...index, entries: [...index.entries, evil] }, 'evil#x');
  assert.notEqual(
    r.status,
    'exact',
    'must not read a file outside the index root',
  );
  assert.equal(r.raw, null);
});

test('default-exported function gets fan-in from default imports', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/dep.ts': 'export default function widget() { return 1 }\n',
      'src/a.ts':
        "import widget from './dep.ts'\nexport function a() { return widget() }\n",
      'src/b.ts':
        "import w from './dep.js'\nexport function b() { return w() }\n",
    }),
  });
  const widget = index.entries.find(
    (e) => e.name === 'widget' && e.file === 'src/dep.ts',
  )!;
  assert.ok(widget, 'default export indexed by its real name');
  assert.ok(widget.default, 'marked as the module default export');
  assert.equal(
    widget.fanIn,
    2,
    'two files default-import it (counted via the `default` bucket)',
  );
});

test('fan-in propagates through a barrel re-export to the real definition', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/real.ts': 'export function gizmo() { return 1 }\n',
      'src/index.ts': "export { gizmo } from './real.ts'\n", // barrel forwards it
      'src/a.ts':
        "import { gizmo } from './index.ts'\nexport function a() { return gizmo() }\n",
      'src/b.ts':
        "import { gizmo } from './index.ts'\nexport function b() { return gizmo() }\n",
    }),
  });
  const gizmo = index.entries.find(
    (e) => e.name === 'gizmo' && e.file === 'src/real.ts',
  )!;
  assert.equal(
    gizmo.fanIn,
    2,
    'two consumers importing via the barrel credit the real definition',
  );
});

test('fan-in follows renamed re-export chains to the source identity', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/real.ts': 'export function alpha() { return 1 }\n',
      'src/first.ts': "export { alpha as beta } from './real.ts'\n",
      'src/second.ts': "export { beta as gamma } from './first.ts'\n",
      'src/via-import.ts':
        "import { alpha as local } from './real.ts'\nexport { local as delta }\n",
      'src/a.ts': "import { gamma } from './second.ts'\ngamma()\n",
      'src/b.ts': "import { gamma } from './second.ts'\ngamma()\n",
      'src/c.ts': "import { delta } from './via-import.ts'\ndelta()\n",
    }),
  });
  const alpha = index.entries.find(
    (entry) => entry.file === 'src/real.ts' && entry.name === 'alpha',
  );
  assert.equal(
    alpha?.fanIn,
    4,
    'three downstream consumers plus via-import.ts itself import alpha',
  );
  assert.deepEqual(index.fileImports['src/first.ts'], [
    {
      source: './real.ts',
      name: 'beta',
      sourceName: 'alpha',
      reexport: true,
    },
  ]);
  assert.deepEqual(index.fileImports['src/second.ts'], [
    {
      source: './first.ts',
      name: 'gamma',
      sourceName: 'beta',
      reexport: true,
    },
  ]);
  assert.deepEqual(index.fileImports['src/via-import.ts'], [
    { source: './real.ts', name: 'alpha' },
    {
      source: './real.ts',
      name: 'delta',
      sourceName: 'alpha',
      reexport: true,
    },
  ]);
});

test('namespace imports stay dependency edges and namespace exports stay local symbols', async () => {
  const directSource = "export * as api from './real.ts'";
  const indirectSource =
    "import * as ns from './real.ts';\nexport { ns as sdk };";
  const { index } = await buildIndex({
    root: repo({
      'src/real.ts': 'export function alpha() { return 1 }\n',
      'src/direct.ts': `${directSource}\n`,
      'src/indirect.ts': `${indirectSource}\n`,
      'src/a.ts': "import { api } from './direct.ts'\napi.alpha()\n",
      'src/b.ts': "import { sdk } from './indirect.ts'\nsdk.alpha()\n",
    }),
  });
  const api = index.entries.find(
    (entry) => entry.file === 'src/direct.ts' && entry.name === 'api',
  );
  const sdk = index.entries.find(
    (entry) => entry.file === 'src/indirect.ts' && entry.name === 'sdk',
  );
  assert.equal(api?.kind, 'ExportNamespaceSpecifier');
  assert.equal(api?.fanIn, 1);
  assert.equal(read(index, api!.id).raw, directSource);
  assert.equal(sdk?.kind, 'ExportNamespaceSpecifier');
  assert.equal(sdk?.fanIn, 1);
  assert.match(read(index, sdk!.id).raw ?? '', /^export \{ ns as sdk \};$/);
  assert.deepEqual(index.fileImports['src/direct.ts'], [
    { source: './real.ts', name: '*' },
  ]);
  assert.deepEqual(index.fileImports['src/indirect.ts'], [
    { source: './real.ts', name: '*' },
  ]);
  assert.equal(
    index.entries.find(
      (entry) => entry.file === 'src/real.ts' && entry.name === 'alpha',
    )?.fanIn,
    0,
    'namespace property calls are not misreported as named imports',
  );
});

test('string exports, import-equals, side effects, and ambient module forms stay visible', async () => {
  const { index } = await buildIndex({
    root: repo({
      'src/dep.ts':
        'const sourceName = 1; const empty = 2; export { sourceName as "source-name", empty as "" };\n',
      'src/string-local.ts':
        'const local = 1; export { local as "kebab-name" };\n',
      'src/string-forward.ts':
        'export { "source-name" as localName, "" as emptyName } from "./dep.ts";\n',
      'src/string-consumer.ts':
        'import { emptyName } from "./string-forward.ts";\nvoid emptyName;\n',
      'src/string-direct.ts':
        'import { "" as emptyLocal } from "./dep.ts";\nvoid emptyLocal;\n',
      'src/empty-namespace.ts': 'export * as "" from "./dep.ts";\n',
      'src/empty-namespace-consumer.ts':
        'import { "" as emptyNamespace } from "./empty-namespace.ts";\nvoid emptyNamespace;\n',
      'src/empty-module.d.ts':
        'declare module "" { export const value: number; }\n',
      'src/side-effect.ts': 'import "./dep.ts";\nexport const ready = true;\n',
      'src/import-equals.ts':
        'import Alias = require("./dep.ts");\nexport { Alias as Public };\n',
      'src/export-import.ts': 'export import Direct = require("./dep.ts");\n',
      'src/export-assignment.ts':
        'declare function factory(): void;\nexport = factory;\n',
      'src/global.d.ts': 'export as namespace GlobalLib;\n',
    }),
  });

  const stringName = index.entries.find(
    (entry) =>
      entry.file === 'src/string-local.ts' && entry.name === 'kebab-name',
  );
  assert.equal(stringName?.kind, 'ExportSpecifier');
  assert.match(read(index, stringName!.id).raw ?? '', /^const local = 1/);
  assert.deepEqual(index.fileImports['src/string-forward.ts'], [
    {
      source: './dep.ts',
      name: 'localName',
      sourceName: 'source-name',
      reexport: true,
    },
    {
      source: './dep.ts',
      name: 'emptyName',
      sourceName: '',
      reexport: true,
    },
  ]);
  assert.deepEqual(index.fileImports['src/string-direct.ts'], [
    { source: './dep.ts', name: '' },
  ]);
  const emptyName = index.entries.find(
    (entry) => entry.file === 'src/dep.ts' && entry.name === '',
  );
  assert.equal(emptyName?.kind, 'ExportSpecifier');
  assert.equal(emptyName?.fanIn, 2);
  assert.equal(read(index, emptyName!.id).raw, 'const empty = 2;');
  const emptyNamespace = index.entries.find(
    (entry) => entry.file === 'src/empty-namespace.ts' && entry.name === '',
  );
  assert.equal(emptyNamespace?.kind, 'ExportNamespaceSpecifier');
  assert.equal(emptyNamespace?.fanIn, 1);
  assert.equal(
    read(index, emptyNamespace!.id).raw,
    'export * as "" from "./dep.ts";',
  );
  assert.deepEqual(index.fileImports['src/empty-namespace.ts'], [
    { source: './dep.ts', name: '*' },
  ]);
  const emptyModule = index.entries.find(
    (entry) => entry.file === 'src/empty-module.d.ts' && entry.name === '',
  );
  assert.equal(emptyModule?.kind, 'TSModuleDeclaration');
  assert.equal(
    read(index, emptyModule!.id).raw,
    'declare module "" { export const value: number; }',
  );
  assert.deepEqual(index.fileImports['src/side-effect.ts'], [
    { source: './dep.ts', name: '*' },
  ]);

  const publicNamespace = index.entries.find(
    (entry) => entry.file === 'src/import-equals.ts' && entry.name === 'Public',
  );
  assert.equal(publicNamespace?.kind, 'ExportNamespaceSpecifier');
  assert.deepEqual(index.fileImports['src/import-equals.ts'], [
    { source: './dep.ts', name: '*' },
  ]);
  const directNamespace = index.entries.find(
    (entry) => entry.file === 'src/export-import.ts' && entry.name === 'Direct',
  );
  assert.equal(directNamespace?.kind, 'TSImportEqualsDeclaration');
  assert.deepEqual(index.fileImports['src/export-import.ts'], [
    { source: './dep.ts', name: '*' },
  ]);

  const factory = index.entries.find(
    (entry) =>
      entry.file === 'src/export-assignment.ts' && entry.name === 'factory',
  );
  assert.equal(factory?.kind, 'TSDeclareFunction');
  assert.equal(factory?.visibility, undefined);
  assert.match(read(index, factory!.id).raw ?? '', /^declare function factory/);
  const globalNamespace = index.entries.find(
    (entry) => entry.file === 'src/global.d.ts' && entry.name === 'GlobalLib',
  );
  assert.equal(globalNamespace?.kind, 'TSNamespaceExportDeclaration');
  assert.equal(
    read(index, globalNamespace!.id).raw,
    'export as namespace GlobalLib;',
  );

  const persistedPath = join(index.meta.root, '.map-index.json');
  saveIndex(index, persistedPath);
  const persisted = loadIndex(persistedPath);
  assert.deepEqual(
    persisted.fileImports['src/string-forward.ts'],
    index.fileImports['src/string-forward.ts'],
  );
  const persistedEmpty = persisted.entries.find(
    (entry) => entry.file === 'src/dep.ts' && entry.name === '',
  );
  assert.equal(read(persisted, persistedEmpty!.id).raw, 'const empty = 2;');
});
