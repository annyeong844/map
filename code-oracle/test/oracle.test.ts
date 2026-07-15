import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { ContentLengthDecoder, coverageFor, disposeAll, projectSnapshot, query, resolveNamePosition, resolveTsgoPackageBin, scanProjectEpoch, scanStaticInstantiationHints, TOOLS, tsgoSpawnCommand, type OracleSym } from '../server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const installedTsgo = ['tsgo', 'tsgo.js']
  .map((name) => join(HERE, '../node_modules/@typescript/native-preview/bin', name))
  .some((candidate) => existsSync(candidate));
const hasTsgo =
  (!!process.env.TSGO_BIN && existsSync(process.env.TSGO_BIN)) ||
  (installedTsgo &&
    existsSync(join(HERE, '../node_modules/@typescript', `native-preview-${process.platform}-${process.arch}`)));
const SERVER = join(HERE, '../server.ts');

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(check: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(25);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPids(path: string): number[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
}

function writeFakeLsp(path: string): void {
  writeFileSync(path, `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_LSP_PID_LOG, String(process.pid) + '\\n');
let buffer = Buffer.alloc(0);
function send(id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const separator = buffer.indexOf('\\r\\n\\r\\n');
    if (separator < 0) return;
    const header = buffer.subarray(0, separator).toString();
    const match = /Content-Length: (\\d+)/i.exec(header);
    if (!match) { buffer = buffer.subarray(separator + 4); continue; }
    const length = Number(match[1]);
    const start = separator + 4;
    if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length).toString());
    buffer = buffer.subarray(start + length);
    if (process.env.FAKE_LSP_METHOD_LOG && message.method) appendFileSync(process.env.FAKE_LSP_METHOD_LOG, message.method + '\\n');
    if (message.id != null && message.method !== process.env.FAKE_LSP_HANG_METHOD) {
      send(message.id, message.method === 'initialize' ? { capabilities: {} } : []);
    }
  }
});
`);
}

function startOracle(root: string, fakeLsp: string, pidLog: string, overrides: NodeJS.ProcessEnv = {}): {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TSGO_BIN: fakeLsp,
    CODE_ORACLE_ROOT: root,
    TS_ORACLE_QUIET_MS: '10',
    TS_ORACLE_MIN_MS: '10',
    TS_ORACLE_WARMUP_MS: '1000',
    TS_ORACLE_REQ_TIMEOUT_MS: '2000',
    FAKE_LSP_PID_LOG: pidLog,
    ...overrides,
  };
  if (overrides.CODE_ORACLE_PREWARM === undefined) delete env.CODE_ORACLE_PREWARM;
  const child = spawn(process.execPath, [SERVER], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  return { child, stderr: () => stderr };
}

async function stopOracle(child: ChildProcessWithoutNullStreams, pids: number[]): Promise<void> {
  if (child.exitCode == null && child.signalCode == null) {
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, delay(1000)]);
  }
  for (const pid of pids) {
    if (pidAlive(pid)) { try { process.kill(pid); } catch { /* already gone */ } }
  }
}

after(() => disposeAll());

test('the three tools are exposed', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['callers', 'definition', 'implementations']);
});

test('query validates the MCP boundary before paths or checker state are touched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-input-'));
  const file = join(root, 'source.ts');
  writeFileSync(file, 'export const value = 1;\n');
  try {
    assert.match(String((await query('callers', { file: {} }) as { error: string }).error), /file.*non-empty string/);
    assert.match(String((await query('callers', { file, root: [] }) as { error: string }).error), /root.*non-empty string/);
    assert.match(String((await query('callers', { file, name: {} }) as { error: string }).error), /name.*non-empty string/);
    assert.match(String((await query('callers', { file, line: 0 }) as { error: string }).error), /provided together/);
    assert.match(String((await query('callers', { file, line: -1, character: 0 }) as { error: string }).error), /non-negative safe integers/);
    assert.match(String((await query('implementations', { file, name: 'value', evidence: 'yes' }) as { error: string }).error), /evidence.*boolean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('coverage metadata distinguishes checker evidence, over-approximation, and Python lower bounds', () => {
  assert.equal(coverageFor('callers', 'ts').kind, 'checker-confirmed');
  const implementations = coverageFor('implementations', 'ts');
  assert.equal(implementations.kind, 'sound-overapproximation');
  assert.equal(implementations.scope, 'checker-visible-project');
  assert.ok(implementations.residuals.includes('token-only-di'));
  const python = coverageFor('callers', 'py');
  assert.equal(python.kind, 'lower-bound');
  assert.equal(python.scope, 'intra-file');
  assert.ok(python.residuals.includes('cross-file-references'));
});

test('static instantiation hints ignore comments and strings and retain strong construction signals', () => {
  const hints = scanStaticInstantiationHints([
    '// new CommentOnly()',
    'const text = "new StringOnly()";',
    'const circle = new Circle();',
    'const provider = { useClass: EmailNotifier };',
    '',
  ].join('\n'), 'fixture.ts');
  assert.deepEqual(hints.map((hint) => [hint.name, hint.kind, hint.line]), [
    ['Circle', 'constructor', 3],
    ['EmailNotifier', 'di-use-class', 4],
  ]);
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

test('concurrent project snapshots share one exact scan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-snapshot-flight-'));
  try {
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    for (let i = 0; i < 128; i++) writeFileSync(join(root, `f${i}.ts`), `export const f${i} = ${i};\n`);
    const snapshots = await Promise.all(Array.from({ length: 32 }, () => projectSnapshot(root)));
    assert.ok(snapshots.every((snapshot) => snapshot === snapshots[0]), 'overlapping callers must share one snapshot object');
    assert.equal(snapshots[0].files.size, 129);
  } finally {
    disposeAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test('tsgo package resolution follows a hoisted Node dependency layout', () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-hoisted-tsgo-'));
  try {
    const scope = join(root, 'node_modules/@typescript');
    const packageRoot = join(scope, 'native-preview');
    const platformRoot = join(scope, `native-preview-${process.platform}-${process.arch}`);
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(join(platformRoot, 'lib'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@typescript/native-preview',
      exports: { './package.json': './package.json' },
    }));
    writeFileSync(join(platformRoot, 'package.json'), JSON.stringify({
      name: `@typescript/native-preview-${process.platform}-${process.arch}`,
      exports: { './package.json': './package.json' },
    }));
    const executable = join(platformRoot, 'lib', process.platform === 'win32' ? 'tsgo.exe' : 'tsgo');
    writeFileSync(executable, 'native executable placeholder\n');

    assert.equal(resolveTsgoPackageBin(join(root, 'client.cjs')), executable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('startup is lazy unless prewarm is explicitly enabled', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-lazy-'));
  const fakeLsp = join(root, 'fake-lsp.mjs');
  const pidLog = join(root, 'lsp-pids.txt');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  writeFakeLsp(fakeLsp);
  const oracle = startOracle(root, fakeLsp, pidLog);
  try {
    await delay(400);
    assert.deepEqual(readPids(pidLog), [], `default startup must not spawn an LSP: ${oracle.stderr()}`);
    const exited = once(oracle.child, 'exit');
    oracle.child.stdin.end();
    const [code] = await withTimeout(exited, 3000, `lazy MCP did not exit on stdin EOF: ${oracle.stderr()}`);
    assert.equal(code, 0, oracle.stderr());
  } finally {
    await stopOracle(oracle.child, readPids(pidLog));
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate queries share work and same-epoch cache writes append one delta', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-query-flight-'));
  const fakeLsp = join(root, 'fake-lsp.mjs');
  const pidLog = join(root, 'lsp-pids.txt');
  const methodLog = join(root, 'lsp-methods.txt');
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const cache = join(HERE, '../.cache', `${digest}.json`);
  const cacheLog = join(HERE, '../.cache', `${digest}.jsonl`);
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  writeFakeLsp(fakeLsp);

  const run = async (requests: { id: number; character: number }[]): Promise<void> => {
    const oracle = startOracle(root, fakeLsp, pidLog, { FAKE_LSP_METHOD_LOG: methodLog });
    const lines = createInterface({ input: oracle.child.stdout });
    const responses = new Promise<string[]>((resolveResponses) => {
      const received: string[] = [];
      lines.on('line', (line) => {
        received.push(line);
        if (received.length === requests.length) resolveResponses(received);
      });
    });
    try {
      for (const request of requests) {
        oracle.child.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          method: 'tools/call',
          params: { name: 'definition', arguments: { root, file: join(root, 'source.ts'), line: 0, character: request.character } },
        }) + '\n');
      }
      const messages = await withTimeout(responses, 5000, `oracle queries timed out: ${oracle.stderr()}`);
      for (const line of messages) assert.equal(JSON.parse(line).error, undefined, line);
      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(exited, 3000, `oracle did not flush and exit: ${oracle.stderr()}`);
      assert.equal(code, 0, oracle.stderr());
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
    }
  };

  try {
    rmSync(cache, { force: true });
    rmSync(cacheLog, { force: true });
    await run([{ id: 1, character: 13 }, { id: 2, character: 13 }]);
    const methods = readFileSync(methodLog, 'utf8').trim().split(/\s+/);
    assert.equal(methods.filter((method) => method === 'textDocument/definition').length, 1, 'identical requests must share one LSP call');
    const base = readFileSync(cache, 'utf8');

    await run([{ id: 3, character: 12 }]);
    assert.equal(readFileSync(cache, 'utf8'), base, 'same-epoch answers must not rewrite the full snapshot');
    const deltas = readFileSync(cacheLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(deltas.length, 1);
    assert.match(deltas[0].key, /#0:12$/);
  } finally {
    rmSync(cache, { force: true });
    rmSync(cacheLog, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('warm sessions are LRU-bounded and idle-reaped', { timeout: 15_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'code-oracle-pool-'));
  const firstRoot = join(base, 'first');
  const secondRoot = join(base, 'second');
  const fakeLsp = join(base, 'fake-lsp.mjs');
  const pidLog = join(base, 'lsp-pids.txt');
  for (const root of [firstRoot, secondRoot]) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }));
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  }
  writeFakeLsp(fakeLsp);
  const oracle = startOracle(firstRoot, fakeLsp, pidLog, {
    CODE_ORACLE_PREWARM: '0',
    CODE_ORACLE_MAX_SESSIONS: '1',
    CODE_ORACLE_SESSION_IDLE_MS: '5000',
  });
  const lines = createInterface({ input: oracle.child.stdout });
  let id = 0;
  const callDefinition = async (root: string): Promise<void> => {
    const response = once(lines, 'line');
    oracle.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: ++id,
      method: 'tools/call',
      params: { name: 'definition', arguments: { root, file: join(root, 'source.ts'), line: 0, character: 13 } },
    }) + '\n');
    const [line] = await withTimeout(response, 5000, `oracle query timed out: ${oracle.stderr()}`);
    const message = JSON.parse(line as string);
    assert.equal(message.error, undefined, JSON.stringify(message));
  };

  try {
    await callDefinition(firstRoot);
    await waitUntil(() => readPids(pidLog).length === 1, 2000, 'first LSP did not start');
    const firstPid = readPids(pidLog)[0];

    await callDefinition(secondRoot);
    await waitUntil(() => readPids(pidLog).length === 2, 2000, 'second LSP did not start');
    const secondPid = readPids(pidLog)[1];
    await waitUntil(() => !pidAlive(firstPid), 2000, 'LRU cap did not reap the first LSP');
    assert.equal(pidAlive(secondPid), true, 'newest LSP was reaped instead of the LRU session');
    await waitUntil(() => !pidAlive(secondPid), 7000, 'idle timeout did not reap the remaining LSP');

    const exited = once(oracle.child, 'exit');
    oracle.child.stdin.end();
    const [code] = await withTimeout(exited, 3000, `pooled MCP did not exit: ${oracle.stderr()}`);
    assert.equal(code, 0, oracle.stderr());
  } finally {
    lines.close();
    await stopOracle(oracle.child, readPids(pidLog));
    rmSync(base, { recursive: true, force: true });
  }
});

test('an LSP request timeout fails honestly and terminates the poisoned backend', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-timeout-'));
  const fakeLsp = join(root, 'fake-lsp.mjs');
  const pidLog = join(root, 'lsp-pids.txt');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  writeFakeLsp(fakeLsp);
  const oracle = startOracle(root, fakeLsp, pidLog, {
    CODE_ORACLE_PREWARM: '0',
    CODE_ORACLE_SESSION_IDLE_MS: '60000',
    TS_ORACLE_REQ_TIMEOUT_MS: '100',
    FAKE_LSP_HANG_METHOD: 'textDocument/definition',
  });
  const lines = createInterface({ input: oracle.child.stdout });
  try {
    const response = once(lines, 'line');
    oracle.child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'definition', arguments: { root, file: join(root, 'source.ts'), line: 0, character: 13 } },
    }) + '\n');
    const [line] = await withTimeout(response, 3000, `timed-out query did not answer: ${oracle.stderr()}`);
    const message = JSON.parse(line as string);
    assert.match(message.error?.message ?? '', /LSP request timed out.*textDocument\/definition/);
    await waitUntil(() => readPids(pidLog).length === 1, 1000, 'timed-out LSP never started');
    const lspPid = readPids(pidLog)[0];
    await waitUntil(() => !pidAlive(lspPid), 2000, 'timed-out LSP was left alive');

    const exited = once(oracle.child, 'exit');
    oracle.child.stdin.end();
    const [code] = await withTimeout(exited, 3000, `timeout-test MCP did not exit: ${oracle.stderr()}`);
    assert.equal(code, 0, oracle.stderr());
  } finally {
    lines.close();
    await stopOracle(oracle.child, readPids(pidLog));
    rmSync(root, { recursive: true, force: true });
  }
});

test('stdin EOF shuts down an in-flight prewarm and reaps its LSP', { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-eof-'));
  const fakeLsp = join(root, 'fake-lsp.mjs');
  const pidLog = join(root, 'lsp-pids.txt');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ include: ['*.ts'] }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  writeFakeLsp(fakeLsp);
  const oracle = startOracle(root, fakeLsp, pidLog, {
    CODE_ORACLE_PREWARM: '1',
    CODE_ORACLE_SESSION_IDLE_MS: '60000',
  });
  try {
    await waitUntil(() => readPids(pidLog).length === 1, 3000, `prewarm LSP did not start: ${oracle.stderr()}`);
    const lspPid = readPids(pidLog)[0];
    const exited = once(oracle.child, 'exit');
    oracle.child.stdin.end();
    const [code] = await withTimeout(exited, 3000, `MCP stayed alive after stdin EOF: ${oracle.stderr()}`);
    assert.equal(code, 0, oracle.stderr());
    await waitUntil(() => !pidAlive(lspPid), 2000, 'stdin EOF left the LSP process alive');
  } finally {
    await stopOracle(oracle.child, readPids(pidLog));
    rmSync(root, { recursive: true, force: true });
  }
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
    join(root, 'shape.ts'),
    [
      'export interface Shape {',
      '  area(): number;',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'circle.ts'),
    [
      "import type { Shape } from './shape.js';",
      'export class Circle implements Shape {',
      '  area() { return 3.14; }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'square.ts'),
    [
      "import type { Shape } from './shape.js';",
      'export class Square implements Shape {',
      '  area() { return 4; }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'app.ts'),
    [
      "import type { Shape } from './shape.js';",
      "import { Circle } from './circle.js';",
      'export const active: Shape = new Circle();',
      '',
    ].join('\n'),
  );

  // Point at the interface method's declaration (line 1, the `area` token at col 2).
  const r = (await query('implementations', { file: join(root, 'shape.ts'), line: 1, character: 2, root })) as {
    tool: string;
    count: number;
    coverage: { kind: string };
    implementationEvidence: { runtimeObserved: boolean; likelyCount: number };
    results: { file: string; line: number; container: string | null; likelihood: string; staticEvidence?: { kind: string }[] }[];
  };
  assert.equal(r.tool, 'implementations');
  assert.ok(r.count >= 2, `expected >= 2 concrete impls, got ${r.count}: ${JSON.stringify(r.results)}`);
  assert.equal(r.coverage.kind, 'sound-overapproximation');
  assert.equal(r.implementationEvidence.runtimeObserved, false);
  const circle = r.results.find((result) => result.container === 'Circle');
  const square = r.results.find((result) => result.container === 'Square');
  assert.equal(circle?.likelihood, 'likely');
  assert.ok(circle?.staticEvidence?.some((evidence) => evidence.kind === 'constructor'));
  assert.equal(square?.likelihood, 'possible');
  assert.equal(r.implementationEvidence.likelyCount, 1);

  const unranked = (await query('implementations', {
    file: join(root, 'shape.ts'), line: 1, character: 2, root, evidence: false,
  })) as {
    count: number;
    implementationEvidence: { basis: string };
    results: { likelihood?: string }[];
  };
  assert.equal(unranked.count, r.count, 'opting out of evidence must not change the possible set');
  assert.equal(unranked.implementationEvidence.basis, 'not-requested');
  assert.ok(unranked.results.every((result) => result.likelihood === undefined));
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
