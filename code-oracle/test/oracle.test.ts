import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, parse as parsePath, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import {
  ContentLengthDecoder,
  coverageFor,
  disposeAll,
  type OracleSym,
  projectSnapshot,
  query,
  resolveNamePosition,
  resolveTsgoPackageBin,
  scanProjectEpoch,
  scanStaticInstantiationHints,
  TOOLS,
  tsgoSpawnCommand,
} from '../server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const installedTsgo = ['tsgo', 'tsgo.js']
  .map((name) =>
    join(HERE, '../node_modules/@typescript/native-preview/bin', name),
  )
  .some((candidate) => existsSync(candidate));
const hasTsgo =
  (!!process.env.TSGO_BIN && existsSync(process.env.TSGO_BIN)) ||
  (installedTsgo &&
    existsSync(
      join(
        HERE,
        '../node_modules/@typescript',
        `native-preview-${process.platform}-${process.arch}`,
      ),
    ));
const ORACLE_ROOT = join(HERE, '..');
const SERVER = join(ORACLE_ROOT, 'server.ts');

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function canonicalTempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
}

function lspLocation(
  file: string,
  line: number,
  character: number,
): Record<string, unknown> {
  return {
    uri: pathToFileURL(file).href,
    range: {
      start: { line, character },
      end: { line, character: character + 5 },
    },
  };
}

async function waitUntil(
  check: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(25);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPids(path: string): number[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

function writeWideTsFixtures(root: string, fileCount: number): void {
  for (let index = 0; index < fileCount; index++) {
    writeFileSync(
      join(root, `fixture-${index}.ts`),
      `export const fixture${index} = ${index};\n`,
    );
  }
}

function writeFakeLsp(path: string): void {
  writeFileSync(
    path,
    `
import { appendFileSync, unlinkSync } from 'node:fs';
appendFileSync(process.env.FAKE_LSP_PID_LOG, String(process.pid) + '\\n');
const stderrBytes = Number(process.env.FAKE_LSP_STDERR_BYTES || 0);
if (stderrBytes > 0) {
  const prefix = 'DROPPED_BACKEND_STDERR_PREFIX';
  const tail = 'RETAINED_BACKEND_STDERR_TAIL';
  const fill = 'x'.repeat(Math.max(0, stderrBytes - prefix.length - tail.length));
  process.stderr.write(prefix + fill + tail);
}
let buffer = Buffer.alloc(0);
let definitionObserved = false;
function send(id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
}
function sendError(id, method) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32042,
      message: 'synthetic checker failure',
      data: { method },
    },
  });
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
      const reply = () => {
        if (message.method === 'initialize' && process.env.FAKE_LSP_DELETE_ON_INITIALIZE) {
          try { unlinkSync(process.env.FAKE_LSP_DELETE_ON_INITIALIZE); } catch {}
        }
        if (message.method === process.env.FAKE_LSP_ERROR_METHOD) {
          sendError(message.id, message.method);
        } else if (message.method === 'initialize') {
          send(message.id, { capabilities: {} });
        } else if (message.method === 'textDocument/definition') {
          definitionObserved = true;
          send(message.id, JSON.parse(process.env.FAKE_LSP_DEFINITION_RESULT || '[]'));
        } else if (
          message.method === 'textDocument/references' &&
          process.env.FAKE_LSP_REFERENCES_RESULT
        ) {
          send(message.id, JSON.parse(process.env.FAKE_LSP_REFERENCES_RESULT));
        } else if (
          message.method === 'textDocument/references' &&
          definitionObserved
        ) {
          send(message.id, JSON.parse(process.env.FAKE_LSP_REFERENCES_AFTER_DEFINITION || '[]'));
        } else {
          send(message.id, []);
        }
      };
      const delay = Number(process.env.FAKE_LSP_DELAY_MS || 0);
      if (message.method === process.env.FAKE_LSP_DELAY_METHOD && delay > 0) setTimeout(reply, delay);
      else reply();
    }
  }
});
`,
  );
}

function startOracle(
  root: string,
  fakeLsp: string,
  pidLog: string,
  overrides: NodeJS.ProcessEnv = {},
): {
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
  if (overrides.CODE_ORACLE_PREWARM === undefined) {
    delete env.CODE_ORACLE_PREWARM;
  }
  const child = spawn(process.execPath, [SERVER], {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { child, stderr: () => stderr };
}

async function stopOracle(
  child: ChildProcessWithoutNullStreams,
  pids: number[],
): Promise<void> {
  if (child.exitCode == null && child.signalCode == null) {
    const exited = once(child, 'exit');
    child.kill();
    await Promise.race([exited, delay(1000)]);
  }
  for (const pid of pids) {
    if (pidAlive(pid)) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  }
}

async function callOracleTool(
  lines: ReturnType<typeof createInterface>,
  child: ChildProcessWithoutNullStreams,
  id: number,
  name: 'callers' | 'definition' | 'implementations',
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = once(lines, 'line', {
    signal: AbortSignal.timeout(5_000),
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`,
  );
  const [line] = await response;
  const message = JSON.parse(line as string) as {
    error?: unknown;
    result?: { content: { text: string }[] };
  };
  assert.equal(message.error, undefined, line as string);
  assert.ok(message.result?.content[0]?.text, line as string);
  return JSON.parse(message.result.content[0].text) as Record<string, unknown>;
}

after(() => disposeAll());

test('the three tools are exposed', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), [
    'callers',
    'definition',
    'implementations',
  ]);
});

test(
  'initialize and ping identify a stale running Oracle from its own bytes',
  { timeout: 10_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-runtime-id-');
    const copiedServer = join(root, 'server.ts');
    const runtimeSources = readdirSync(ORACLE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
    for (const source of runtimeSources) {
      copyFileSync(join(ORACLE_ROOT, source), join(root, source));
    }
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'runtime-fixture', version: '9.8.7' }),
    );
    const child = spawn(process.execPath, [copiedServer], {
      cwd: root,
      env: { ...process.env, CODE_ORACLE_PREWARM: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const lines = createInterface({ input: child.stdout });
    let id = 0;
    const rpc = async (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      const requestId = ++id;
      const response = once(lines, 'line', {
        signal: AbortSignal.timeout(3_000),
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`,
      );
      const [line] = await response;
      return JSON.parse(line as string) as Record<string, unknown>;
    };
    try {
      const initialized = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
      });
      const initializeResult = initialized.result as {
        serverInfo: { name: string; version: string };
        runtime: {
          buildId: string;
          serverFile: string;
          sourceDigestAtStart: string;
          sourceDigestNow: string;
          runtimeSourcesAtStart: string[];
          runtimeSourcesNow: string[];
          restartRequired: boolean;
        };
      };
      assert.deepEqual(initializeResult.serverInfo, {
        name: 'code-oracle',
        version: '9.8.7',
      });
      assert.match(initializeResult.runtime.buildId, /^9\.8\.7:[0-9a-f]{16}$/);
      assert.equal(initializeResult.runtime.serverFile, copiedServer);
      assert.equal(initializeResult.runtime.restartRequired, false);
      assert.equal(
        initializeResult.runtime.sourceDigestAtStart,
        initializeResult.runtime.sourceDigestNow,
      );
      assert.deepEqual(
        initializeResult.runtime.runtimeSourcesAtStart,
        runtimeSources,
      );
      assert.deepEqual(
        initializeResult.runtime.runtimeSourcesNow,
        runtimeSources,
      );

      const copiedRuntimeControl = join(root, 'runtime-control.ts');
      writeFileSync(
        copiedRuntimeControl,
        `${readFileSync(copiedRuntimeControl, 'utf8')}\n// changed after startup\n`,
      );
      const pinged = await rpc('ping');
      const pingResult = pinged.result as {
        runtime: {
          sourceDigestAtStart: string;
          sourceDigestNow: string;
          restartRequired: boolean;
          warning?: string;
        };
      };
      assert.equal(pingResult.runtime.restartRequired, true);
      assert.notEqual(
        pingResult.runtime.sourceDigestAtStart,
        pingResult.runtime.sourceDigestNow,
      );
      assert.match(pingResult.runtime.warning ?? '', /new MCP session/);

      const exited = once(child, 'exit', {
        signal: AbortSignal.timeout(3_000),
      });
      child.stdin.end();
      const [code] = await exited;
      assert.equal(code, 0, stderr);
    } finally {
      lines.close();
      if (child.exitCode == null && child.signalCode == null) child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('query validates the MCP boundary before paths or checker state are touched', async () => {
  const root = canonicalTempDir('code-oracle-input-');
  const file = join(root, 'source.ts');
  writeFileSync(file, 'export const value = 1;\n');
  try {
    assert.match(
      String(
        ((await query('callers', { file: {} })) as { error: string }).error,
      ),
      /file.*non-empty string/,
    );
    assert.match(
      String(
        ((await query('callers', { file, root: [] })) as { error: string })
          .error,
      ),
      /root.*non-empty string/,
    );
    assert.match(
      String(
        ((await query('callers', { file, name: {} })) as { error: string })
          .error,
      ),
      /name.*non-empty string/,
    );
    assert.match(
      String(
        ((await query('callers', { file, line: 0 })) as { error: string })
          .error,
      ),
      /provided together/,
    );
    assert.match(
      String(
        (
          (await query('callers', { file, line: -1, character: 0 })) as {
            error: string;
          }
        ).error,
      ),
      /non-negative safe integers/,
    );
    assert.match(
      String(
        (
          (await query('implementations', {
            file,
            name: 'value',
            evidence: 'yes',
          })) as { error: string }
        ).error,
      ),
      /evidence.*boolean/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('query contains real files under an absolute non-broad root', async (t) => {
  const container = canonicalTempDir('code-oracle-scope-');
  const root = join(container, 'repo');
  const outside = join(container, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  const insideFile = join(root, 'inside.ts');
  const outsideFile = join(outside, 'outside.ts');
  writeFileSync(insideFile, 'export const inside = 1;\n');
  writeFileSync(outsideFile, 'export const outside = 1;\n');
  const priorBroadRoot = process.env.CODE_ORACLE_ALLOW_BROAD_ROOT;
  delete process.env.CODE_ORACLE_ALLOW_BROAD_ROOT;
  try {
    assert.match(
      String(
        (
          (await query('callers', {
            file: relative(root, insideFile),
            name: 'inside',
          })) as { error: string }
        ).error,
      ),
      /file.*absolute/,
    );
    assert.match(
      String(
        (
          (await query('callers', {
            file: insideFile,
            root: 'relative-root',
            name: 'inside',
          })) as { error: string }
        ).error,
      ),
      /root.*absolute/,
    );
    assert.match(
      String(
        (
          (await query('callers', {
            file: outsideFile,
            root,
            name: 'outside',
          })) as { error: string }
        ).error,
      ),
      /escapes root.*realpath/,
    );
    assert.match(
      String(
        (
          (await query('callers', {
            file: insideFile,
            root: parsePath(insideFile).root,
            name: 'inside',
          })) as { error: string }
        ).error,
      ),
      /refusing a volume\/home root/,
    );

    const linked = join(root, 'linked');
    let linkedAvailable = false;
    try {
      symlinkSync(
        outside,
        linked,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      linkedAvailable = true;
    } catch (error) {
      t.diagnostic(
        `symlink escape probe unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    if (linkedAvailable) {
      assert.match(
        String(
          (
            (await query('callers', {
              file: join(linked, 'outside.ts'),
              root,
              name: 'outside',
            })) as { error: string }
          ).error,
        ),
        /escapes root.*realpath/,
      );
    }
  } finally {
    if (priorBroadRoot === undefined) {
      delete process.env.CODE_ORACLE_ALLOW_BROAD_ROOT;
    } else {
      process.env.CODE_ORACLE_ALLOW_BROAD_ROOT = priorBroadRoot;
    }
    rmSync(container, { recursive: true, force: true });
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
  const hints = scanStaticInstantiationHints(
    [
      '// new CommentOnly()',
      'const text = "new StringOnly()";',
      'const circle = new Circle();',
      'const provider = { useClass: EmailNotifier };',
      '',
    ].join('\n'),
    'fixture.ts',
  );
  assert.deepEqual(
    hints.map((hint) => [hint.name, hint.kind, hint.line]),
    [
      ['Circle', 'constructor', 3],
      ['EmailNotifier', 'di-use-class', 4],
    ],
  );
});

test('tsgo spawn accepts the new extensionless Node launcher and legacy/native binaries', () => {
  const root = canonicalTempDir('code-oracle-tsgo-');
  try {
    const extensionless = join(root, 'tsgo');
    const legacy = join(root, 'tsgo.js');
    const native = join(root, 'tsgo-native');
    writeFileSync(extensionless, '#!/usr/bin/env node\n');
    writeFileSync(legacy, '/* legacy Node launcher */\n');
    writeFileSync(native, 'native executable placeholder\n');

    const args = ['--lsp', '--stdio'];
    assert.deepEqual(tsgoSpawnCommand(extensionless), {
      cmd: process.execPath,
      args: [extensionless, ...args],
    });
    assert.deepEqual(tsgoSpawnCommand(legacy), {
      cmd: process.execPath,
      args: [legacy, ...args],
    });
    assert.deepEqual(tsgoSpawnCommand(native), { cmd: native, args });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Content-Length decoding is linear-safe across byte splits and packed frames', () => {
  const first = { jsonrpc: '2.0', id: 1, result: '한글🙂' };
  const second = { jsonrpc: '2.0', id: 2, result: [1, 2, 3] };
  const bytes = Buffer.concat([frame(first), frame(second)]);
  const decoder = new ContentLengthDecoder();
  const messages: Buffer[] = [];
  // Worst fragmentation: one byte per chunk. The former Buffer.concat loop
  // repeatedly copied the entire accumulated body here.
  for (const byte of bytes) messages.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(
    messages.map((body) => JSON.parse(body.toString())),
    [first, second],
  );

  const packed = new ContentLengthDecoder().push(bytes);
  assert.deepEqual(
    packed.map((body) => JSON.parse(body.toString())),
    [first, second],
  );
});

test('concurrent project snapshots share one exact scan', async () => {
  const root = canonicalTempDir('code-oracle-snapshot-flight-');
  try {
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    for (let i = 0; i < 128; i++) {
      writeFileSync(join(root, `f${i}.ts`), `export const f${i} = ${i};\n`);
    }
    const snapshots = await Promise.all(
      Array.from({ length: 32 }, () => projectSnapshot(root)),
    );
    assert.ok(
      snapshots.every((snapshot) => snapshot === snapshots[0]),
      'overlapping callers must share one snapshot object',
    );
    assert.equal(snapshots[0].files.size, 129);
    const later = await projectSnapshot(root);
    assert.ok(
      later.scanSerial > snapshots[0].scanSerial,
      'a later scan needs a strictly newer validation serial',
    );
  } finally {
    disposeAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test('tsgo package resolution follows a hoisted Node dependency layout', () => {
  const root = canonicalTempDir('code-oracle-hoisted-tsgo-');
  try {
    const scope = join(root, 'node_modules/@typescript');
    const packageRoot = join(scope, 'native-preview');
    const platformRoot = join(
      scope,
      `native-preview-${process.platform}-${process.arch}`,
    );
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(join(platformRoot, 'lib'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@typescript/native-preview',
        exports: { './package.json': './package.json' },
      }),
    );
    writeFileSync(
      join(platformRoot, 'package.json'),
      JSON.stringify({
        name: `@typescript/native-preview-${process.platform}-${process.arch}`,
        exports: { './package.json': './package.json' },
      }),
    );
    const executable = join(
      platformRoot,
      'lib',
      process.platform === 'win32' ? 'tsgo.exe' : 'tsgo',
    );
    writeFileSync(executable, 'native executable placeholder\n');

    assert.equal(resolveTsgoPackageBin(join(root, 'client.cjs')), executable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'startup is lazy unless prewarm is explicitly enabled',
  { timeout: 10_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-lazy-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ include: ['*.ts'] }),
    );
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
    writeFakeLsp(fakeLsp);
    const oracle = startOracle(root, fakeLsp, pidLog);
    try {
      await delay(400);
      assert.deepEqual(
        readPids(pidLog),
        [],
        `default startup must not spawn an LSP: ${oracle.stderr()}`,
      );
      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(
        exited,
        3000,
        `lazy MCP did not exit on stdin EOF: ${oracle.stderr()}`,
      );
      assert.equal(code, 0, oracle.stderr());
    } finally {
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'duplicate queries share work and a later snapshot validates their cache entry',
  { timeout: 15_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-query-flight-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    const methodLog = join(root, 'lsp-methods.txt');
    const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const cache = join(HERE, '../.cache', `${digest}.json`);
    const cacheLog = join(HERE, '../.cache', `${digest}.jsonl`);
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ include: ['*.ts'] }),
    );
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
    writeFakeLsp(fakeLsp);

    const oracle = startOracle(root, fakeLsp, pidLog, {
      FAKE_LSP_METHOD_LOG: methodLog,
      FAKE_LSP_DEFINITION_RESULT: JSON.stringify([
        lspLocation(join(root, 'source.ts'), 0, 13),
      ]),
    });
    const lines = createInterface({ input: oracle.child.stdout });
    const firstResponses = new Promise<string[]>((resolveResponses) => {
      const received: string[] = [];
      lines.on('line', (line) => {
        received.push(line);
        if (received.length === 2) resolveResponses(received);
      });
    });

    try {
      rmSync(cache, { force: true });
      rmSync(cacheLog, { force: true });
      for (const id of [1, 2]) {
        oracle.child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: {
              name: 'definition',
              arguments: {
                root,
                file: join(root, 'source.ts'),
                line: 0,
                character: 13,
              },
            },
          })}\n`,
        );
      }
      const messages = await withTimeout(
        firstResponses,
        5_000,
        `oracle queries timed out: ${oracle.stderr()}`,
      );
      for (const line of messages) {
        assert.equal(JSON.parse(line).error, undefined, line);
      }

      // This different query's ordinary start snapshot validates the staged
      // character-13 result without adding a second scan to the first query.
      await callOracleTool(lines, oracle.child, 3, 'definition', {
        root,
        file: join(root, 'source.ts'),
        line: 0,
        character: 12,
      });
      const cached = await callOracleTool(
        lines,
        oracle.child,
        4,
        'definition',
        {
          root,
          file: join(root, 'source.ts'),
          line: 0,
          character: 13,
        },
      );
      assert.equal(cached.cached, true);
      const methods = readFileSync(methodLog, 'utf8').trim().split(/\s+/);
      assert.equal(
        methods.filter((method) => method === 'textDocument/definition').length,
        2,
        'the duplicate and later cache hit must not add checker calls',
      );

      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(
        exited,
        3_000,
        `oracle did not flush and exit: ${oracle.stderr()}`,
      );
      assert.equal(code, 0, oracle.stderr());
      assert.equal(existsSync(cache), true, 'validated answers were not saved');
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(cache, { force: true });
      rmSync(cacheLog, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'callers preserve distinct references that share one source line',
  { timeout: 10_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-same-line-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    const definitionFile = join(root, 'definition.ts');
    const callerFile = join(root, 'caller.ts');
    const callerLine =
      'export const both = (): void => { target(); target(); };';
    const firstCharacter = callerLine.indexOf('target');
    const secondCharacter = callerLine.indexOf('target', firstCharacter + 1);
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ include: ['*.ts'] }),
    );
    writeFileSync(definitionFile, 'export function target(): void {}\n');
    writeFileSync(
      callerFile,
      `import { target } from './definition.js';\n${callerLine}\n`,
    );
    writeFakeLsp(fakeLsp);
    const oracle = startOracle(root, fakeLsp, pidLog, {
      CODE_ORACLE_PREWARM: '0',
      FAKE_LSP_REFERENCES_RESULT: JSON.stringify([
        lspLocation(callerFile, 1, firstCharacter),
        lspLocation(callerFile, 1, secondCharacter),
      ]),
    });
    const lines = createInterface({ input: oracle.child.stdout });
    try {
      const result = await callOracleTool(lines, oracle.child, 1, 'callers', {
        root,
        file: definitionFile,
        line: 0,
        character: 16,
      });
      assert.equal(
        result.count,
        2,
        `same-line calls were collapsed: ${JSON.stringify(result)}`,
      );
      assert.deepEqual(
        (result.results as { character?: number }[]).map(
          (location) => location.character,
        ),
        [firstCharacter, secondCharacter],
      );
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'completed queries close every document opened in a warm LSP session',
  { timeout: 10_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-did-close-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    const methodLog = join(root, 'lsp-methods.txt');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ include: ['*.ts'] }),
    );
    const files = Array.from({ length: 3 }, (_, index) => {
      const file = join(root, `source-${index}.ts`);
      writeFileSync(file, `export const value${index} = ${index};\n`);
      return file;
    });
    writeFakeLsp(fakeLsp);
    const oracle = startOracle(root, fakeLsp, pidLog, {
      CODE_ORACLE_PREWARM: '0',
      CODE_ORACLE_SESSION_IDLE_MS: '60000',
      FAKE_LSP_METHOD_LOG: methodLog,
    });
    const lines = createInterface({ input: oracle.child.stdout });
    try {
      for (const [index, file] of files.entries()) {
        await callOracleTool(lines, oracle.child, index + 1, 'definition', {
          root,
          file,
          name: `value${index}`,
        });
      }
      // didClose is an LSP notification: the Oracle writes it before returning,
      // but the fake child may append its observation a scheduling turn later.
      // Wait for delivery, while still failing if any close is genuinely absent.
      await waitUntil(
        () =>
          existsSync(methodLog) &&
          readFileSync(methodLog, 'utf8')
            .split(/\r?\n/)
            .filter((method) => method === 'textDocument/didClose').length ===
            files.length,
        1_000,
        'didClose notifications did not reach the LSP',
      );
      const methods = readFileSync(methodLog, 'utf8').trim().split(/\r?\n/);
      assert.equal(
        methods.filter((method) => method === 'textDocument/didOpen').length,
        files.length,
      );
      assert.equal(
        methods.filter((method) => method === 'textDocument/didClose').length,
        files.length,
        `open documents accumulated in the warm session: ${methods.join(', ')}`,
      );
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'a query never persists its result under an epoch changed during the LSP read',
  { timeout: 10_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-epoch-race-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    const methodLog = join(root, 'lsp-methods.txt');
    const source = join(root, 'source.ts');
    const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const cache = join(HERE, '../.cache', `${digest}.json`);
    const cacheLog = join(HERE, '../.cache', `${digest}.jsonl`);
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ include: ['*.ts'] }),
    );
    writeFileSync(source, 'export const value = 1;\n');
    writeFakeLsp(fakeLsp);
    const oldEpoch = await scanProjectEpoch(root);
    const oracle = startOracle(root, fakeLsp, pidLog, {
      CODE_ORACLE_PREWARM: '0',
      FAKE_LSP_METHOD_LOG: methodLog,
      FAKE_LSP_DELAY_METHOD: 'textDocument/definition',
      FAKE_LSP_DELAY_MS: '750',
    });
    const lines = createInterface({ input: oracle.child.stdout });
    try {
      rmSync(cache, { force: true });
      rmSync(cacheLog, { force: true });
      const pending = callOracleTool(lines, oracle.child, 1, 'definition', {
        root,
        file: source,
        line: 0,
        character: 13,
      });
      await waitUntil(
        () =>
          existsSync(methodLog) &&
          readFileSync(methodLog, 'utf8').includes('textDocument/definition'),
        3_000,
        `the delayed LSP read never started: ${oracle.stderr()}`,
      );
      writeFileSync(source, 'export const value = 2;\n');
      const currentEpoch = await scanProjectEpoch(root);
      assert.notEqual(currentEpoch, oldEpoch, 'fixture epoch did not change');
      await pending;
      const retried = await callOracleTool(
        lines,
        oracle.child,
        2,
        'definition',
        { root, file: source, line: 0, character: 13 },
      );
      assert.equal(
        retried.cached,
        false,
        'the changed epoch reused the staged pre-change answer',
      );
      const methods = readFileSync(methodLog, 'utf8').trim().split(/\r?\n/);
      assert.equal(
        methods.filter((method) => method === 'textDocument/definition').length,
        2,
      );

      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(
        exited,
        3_000,
        `Oracle did not flush and exit: ${oracle.stderr()}`,
      );
      assert.equal(code, 0, oracle.stderr());
      assert.equal(
        existsSync(cache) || existsSync(cacheLog),
        false,
        'the stale start epoch was persisted after the project changed',
      );
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(cache, { force: true });
      rmSync(cacheLog, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'warm sessions are LRU-bounded and idle-reaped',
  { timeout: 15_000 },
  async () => {
    const base = canonicalTempDir('code-oracle-pool-');
    const firstRoot = join(base, 'first');
    const secondRoot = join(base, 'second');
    const fakeLsp = join(base, 'fake-lsp.mjs');
    const pidLog = join(base, 'lsp-pids.txt');
    for (const root of [firstRoot, secondRoot]) {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ include: ['*.ts'] }),
      );
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
      oracle.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: {
            name: 'definition',
            arguments: {
              root,
              file: join(root, 'source.ts'),
              line: 0,
              character: 13,
            },
          },
        }) + '\n',
      );
      const [line] = await withTimeout(
        response,
        5000,
        `oracle query timed out: ${oracle.stderr()}`,
      );
      const message = JSON.parse(line as string);
      assert.equal(message.error, undefined, JSON.stringify(message));
    };

    try {
      await callDefinition(firstRoot);
      await waitUntil(
        () => readPids(pidLog).length === 1,
        2000,
        'first LSP did not start',
      );
      const firstPid = readPids(pidLog)[0];

      await callDefinition(secondRoot);
      await waitUntil(
        () => readPids(pidLog).length === 2,
        2000,
        'second LSP did not start',
      );
      const secondPid = readPids(pidLog)[1];
      await waitUntil(
        () => !pidAlive(firstPid),
        2000,
        'LRU cap did not reap the first LSP',
      );
      assert.equal(
        pidAlive(secondPid),
        true,
        'newest LSP was reaped instead of the LRU session',
      );
      await waitUntil(
        () => !pidAlive(secondPid),
        7000,
        'idle timeout did not reap the remaining LSP',
      );

      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(
        exited,
        3000,
        `pooled MCP did not exit: ${oracle.stderr()}`,
      );
      assert.equal(code, 0, oracle.stderr());
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  'zero callers answers are never cached and a later definition proof is observed',
  { timeout: 10_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-caller-proof-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    const methodLog = join(root, 'lsp-methods.txt');
    const definitionFile = join(root, 'definition.ts');
    const callerFile = join(root, 'caller.ts');
    const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
    const cache = join(HERE, '../.cache', `${digest}.json`);
    const cacheLog = join(HERE, '../.cache', `${digest}.jsonl`);
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ include: ['*.ts'] }),
    );
    writeFileSync(
      definitionFile,
      'export function guard(value: unknown): value is string { return typeof value === "string"; }\n',
    );
    const callerSource =
      'import { guard } from "./definition.js";\nexport const compiled = (value: unknown) => guard(value);\n';
    writeFileSync(callerFile, callerSource);
    writeFakeLsp(fakeLsp);

    const callerCharacter = callerSource.split('\n')[1].indexOf('guard');
    const oracle = startOracle(root, fakeLsp, pidLog, {
      CODE_ORACLE_PREWARM: '0',
      CODE_ORACLE_SESSION_IDLE_MS: '60000',
      FAKE_LSP_METHOD_LOG: methodLog,
      FAKE_LSP_DEFINITION_RESULT: JSON.stringify([
        lspLocation(definitionFile, 0, 16),
      ]),
      FAKE_LSP_REFERENCES_AFTER_DEFINITION: JSON.stringify([
        lspLocation(callerFile, 1, callerCharacter),
      ]),
    });
    const lines = createInterface({ input: oracle.child.stdout });
    let id = 0;
    const call = async (
      name: 'callers' | 'definition',
      file: string,
      line: number,
      character: number,
    ): Promise<{
      count: number;
      cached: boolean;
      results: { file: string }[];
    }> => {
      const response = once(lines, 'line', {
        signal: AbortSignal.timeout(3_000),
      });
      oracle.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: ++id,
          method: 'tools/call',
          params: {
            name,
            arguments: { root, file, line, character },
          },
        })}\n`,
      );
      const [lineText] = await response;
      const message = JSON.parse(lineText as string) as {
        result: { content: { text: string }[] };
      };
      return JSON.parse(message.result.content[0].text) as {
        count: number;
        cached: boolean;
        results: { file: string }[];
      };
    };

    try {
      const first = await call('callers', definitionFile, 0, 16);
      assert.equal(first.count, 0);
      assert.equal(first.cached, false);

      const repeated = await call('callers', definitionFile, 0, 16);
      assert.equal(repeated.count, 0);
      assert.equal(repeated.cached, false);

      const proof = await call('definition', callerFile, 1, callerCharacter);
      assert.equal(proof.count, 1);
      assert.equal(proof.results[0]?.file, 'definition.ts');

      const refreshed = await call('callers', definitionFile, 0, 16);
      assert.equal(
        refreshed.count,
        1,
        `definition proved a caller, but Oracle reused a stale zero: ${JSON.stringify(refreshed)}`,
      );
      assert.equal(refreshed.cached, false);
      assert.equal(refreshed.results[0]?.file, 'caller.ts');
      const methods = readFileSync(methodLog, 'utf8').trim().split(/\r?\n/);
      assert.equal(
        methods.filter((method) => method === 'textDocument/references').length,
        3,
      );
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(cache, { force: true });
      rmSync(cacheLog, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'an LSP JSON-RPC error stays an error and is never cached as a zero result',
  { timeout: 10_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-response-error-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    const methodLog = join(root, 'lsp-methods.txt');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ include: ['*.ts'] }),
    );
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
    writeFakeLsp(fakeLsp);
    const oracle = startOracle(root, fakeLsp, pidLog, {
      CODE_ORACLE_PREWARM: '0',
      CODE_ORACLE_SESSION_IDLE_MS: '60000',
      FAKE_LSP_ERROR_METHOD: 'textDocument/definition',
      FAKE_LSP_METHOD_LOG: methodLog,
    });
    const lines = createInterface({ input: oracle.child.stdout });
    try {
      for (const id of [1, 2]) {
        const response = once(lines, 'line');
        oracle.child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: {
              name: 'definition',
              arguments: {
                root,
                file: join(root, 'source.ts'),
                line: 0,
                character: 13,
              },
            },
          }) + '\n',
        );
        const [line] = await withTimeout(
          response,
          3000,
          `checker error did not answer: ${oracle.stderr()}`,
        );
        const message = JSON.parse(line as string);
        assert.equal(message.id, id);
        assert.equal(message.error?.code, -32603);
        assert.match(
          message.error?.message ?? '',
          /LSP request failed \(-32042\): synthetic checker failure/,
        );
        assert.deepEqual(message.error?.data, {
          lspCode: -32042,
          lspData: { method: 'textDocument/definition' },
        });
        assert.equal(message.result, undefined);
      }

      const methods = readFileSync(methodLog, 'utf8').trim().split(/\r?\n/);
      assert.equal(
        methods.filter((method) => method === 'textDocument/definition').length,
        2,
        'the first checker error was cached instead of querying the LSP again',
      );

      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(
        exited,
        3000,
        `error-test MCP did not exit: ${oracle.stderr()}`,
      );
      assert.equal(code, 0, oracle.stderr());
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'project evidence read failures are surfaced instead of claiming a clean zero',
  { timeout: 10_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-degraded-scan-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    const definitionFile = join(root, 'definition.ts');
    const callerFile = join(root, 'caller.ts');
    writeFileSync(
      definitionFile,
      'export function target(): number { return 1; }\n',
    );
    writeFileSync(
      callerFile,
      "import { target } from './definition.js';\nexport const run = target();\n",
    );
    writeFakeLsp(fakeLsp);
    const oracle = startOracle(root, fakeLsp, pidLog, {
      CODE_ORACLE_PREWARM: '0',
      CODE_ORACLE_SESSION_IDLE_MS: '60000',
      FAKE_LSP_DELETE_ON_INITIALIZE: callerFile,
    });
    const lines = createInterface({ input: oracle.child.stdout });
    try {
      const response = once(lines, 'line');
      oracle.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'callers',
            arguments: { root, file: definitionFile, name: 'target' },
          },
        }) + '\n',
      );
      const [line] = await withTimeout(
        response,
        3000,
        `degraded query did not answer: ${oracle.stderr()}`,
      );
      const message = JSON.parse(line as string);
      const result = JSON.parse(message.result.content[0].text);
      assert.equal(result.count, 0);
      assert.equal(result.incomplete, true);
      assert.ok(result.degradation.staticSupplement.failureCount >= 1);
      assert.ok(
        result.degradation.staticSupplement.examples.some((value: string) =>
          value.includes('caller.ts'),
        ),
      );
      assert.match(result.note, /project evidence reads failed/i);

      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(
        exited,
        3000,
        `degraded-test MCP did not exit: ${oracle.stderr()}`,
      );
      assert.equal(code, 0, oracle.stderr());
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'unique-root Oracle queries wait instead of multiplying active LSP sessions',
  { timeout: 15_000 },
  async () => {
    const base = canonicalTempDir('code-oracle-admission-');
    const fakeLsp = join(base, 'fake-lsp.mjs');
    const pidLog = join(base, 'lsp-pids.txt');
    writeFakeLsp(fakeLsp);
    const roots = Array.from({ length: 4 }, (_, index) => {
      const root = join(base, `repo-${index}`);
      mkdirSync(root);
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({ include: ['*.ts'] }),
      );
      writeFileSync(
        join(root, 'source.ts'),
        `export const value${index} = ${index};\n`,
      );
      return root;
    });
    const oracle = startOracle(base, fakeLsp, pidLog, {
      CODE_ORACLE_PREWARM: '0',
      CODE_ORACLE_SESSION_IDLE_MS: '60000',
      CODE_ORACLE_MAX_ACTIVE_SESSIONS: '2',
      CODE_ORACLE_MAX_ACTIVE_PROJECT_SCANS: '4',
      CODE_ORACLE_MAX_INFLIGHT_REQUESTS: '3',
      FAKE_LSP_DELAY_METHOD: 'textDocument/definition',
      FAKE_LSP_DELAY_MS: '750',
    });
    const lines = createInterface({ input: oracle.child.stdout });
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
      return new Promise((resolveResponse, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Oracle request timed out: ${method}`)),
          10_000,
        );
        pending.set(requestId, (response) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolveResponse(response);
        });
        oracle.child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`,
        );
      });
    };
    try {
      const requests = roots.map((root, index) =>
        rpc('tools/call', {
          name: 'definition',
          arguments: {
            root,
            file: join(root, 'source.ts'),
            line: 0,
            character: 13 + String(index).length,
          },
        }),
      );
      await waitUntil(
        () => readPids(pidLog).length === 2,
        3000,
        `the first two admitted LSPs did not start: ${oracle.stderr()}`,
      );
      await delay(150);
      assert.equal(
        readPids(pidLog).length,
        2,
        'more than two LSP sessions became active before a permit was released',
      );

      const responses = await Promise.all(requests);
      assert.equal(readPids(pidLog).length, roots.length);
      for (const response of responses) {
        const text = (response.result as { content: { text: string }[] })
          .content[0].text;
        assert.equal(JSON.parse(text).count, 0);
      }

      const ping = await rpc('ping', {});
      const runtime = (
        ping.result as {
          runtime: {
            maxObservedMcpRequests: number;
            maxObservedQueuedMcpRequests: number;
            sessionAdmission: {
              limit: number;
              active: number;
              queued: number;
              maxActive: number;
              maxQueued: number;
            };
          };
        }
      ).runtime;
      assert.equal(runtime.sessionAdmission.limit, 2);
      assert.equal(runtime.sessionAdmission.active, 0);
      assert.equal(runtime.sessionAdmission.queued, 0);
      assert.equal(runtime.sessionAdmission.maxActive, 2);
      assert.ok(runtime.sessionAdmission.maxQueued >= 1);
      assert.equal(runtime.maxObservedMcpRequests, 3);
      assert.ok(runtime.maxObservedQueuedMcpRequests >= 1);

      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(
        exited,
        3000,
        `admission-test MCP did not exit: ${oracle.stderr()}`,
      );
      assert.equal(code, 0, oracle.stderr());
      await waitUntil(
        () => readPids(pidLog).every((pid) => !pidAlive(pid)),
        3000,
        'admission-test LSP survived MCP EOF',
      );
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(base, { recursive: true, force: true });
    }
  },
);

test(
  'an LSP request timeout fails honestly and terminates the poisoned backend',
  { timeout: 10_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-timeout-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ include: ['*.ts'] }),
    );
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
    writeFakeLsp(fakeLsp);
    const oracle = startOracle(root, fakeLsp, pidLog, {
      CODE_ORACLE_PREWARM: '0',
      CODE_ORACLE_SESSION_IDLE_MS: '60000',
      TS_ORACLE_REQ_TIMEOUT_MS: '100',
      TS_ORACLE_INIT_TIMEOUT_MS: '2000',
      FAKE_LSP_HANG_METHOD: 'textDocument/definition',
      FAKE_LSP_STDERR_BYTES: '65536',
    });
    const lines = createInterface({ input: oracle.child.stdout });
    try {
      const response = once(lines, 'line');
      oracle.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'definition',
            arguments: {
              root,
              file: join(root, 'source.ts'),
              line: 0,
              character: 13,
            },
          },
        }) + '\n',
      );
      const [line] = await withTimeout(
        response,
        3000,
        `timed-out query did not answer: ${oracle.stderr()}`,
      );
      const message = JSON.parse(line as string);
      assert.match(
        message.error?.message ?? '',
        /LSP request timed out.*textDocument\/definition/,
      );
      assert.match(
        message.error?.message ?? '',
        /RETAINED_BACKEND_STDERR_TAIL/,
      );
      assert.doesNotMatch(
        message.error?.message ?? '',
        /DROPPED_BACKEND_STDERR_PREFIX/,
      );
      assert.ok(
        (message.error?.message?.length ?? Infinity) < 34 * 1024,
        'backend diagnostics must retain a bounded stderr tail',
      );
      await waitUntil(
        () => readPids(pidLog).length === 1,
        1000,
        'timed-out LSP never started',
      );
      const lspPid = readPids(pidLog)[0];
      await waitUntil(
        () => !pidAlive(lspPid),
        2000,
        'timed-out LSP was left alive',
      );

      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(
        exited,
        3000,
        `timeout-test MCP did not exit: ${oracle.stderr()}`,
      );
      assert.equal(code, 0, oracle.stderr());
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'stdin EOF shuts down an in-flight prewarm and reaps its LSP',
  { timeout: 10_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-eof-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ include: ['*.ts'] }),
    );
    writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
    writeFakeLsp(fakeLsp);
    const oracle = startOracle(root, fakeLsp, pidLog, {
      CODE_ORACLE_PREWARM: '1',
      CODE_ORACLE_SESSION_IDLE_MS: '60000',
    });
    try {
      await waitUntil(
        () => readPids(pidLog).length === 1,
        3000,
        `prewarm LSP did not start: ${oracle.stderr()}`,
      );
      const lspPid = readPids(pidLog)[0];
      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(
        exited,
        3000,
        `MCP stayed alive after stdin EOF: ${oracle.stderr()}`,
      );
      assert.equal(code, 0, oracle.stderr());
      await waitUntil(
        () => !pidAlive(lspPid),
        2000,
        'stdin EOF left the LSP process alive',
      );
    } finally {
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'stdin EOF aborts an active project scan before spawning an LSP',
  { timeout: 20_000 },
  async () => {
    const root = canonicalTempDir('code-oracle-eof-scan-');
    const fakeLsp = join(root, 'fake-lsp.mjs');
    const pidLog = join(root, 'lsp-pids.txt');
    const source = join(root, 'source.ts');
    writeFileSync(source, 'export const value = 1;\n');
    writeWideTsFixtures(root, 512);
    writeFakeLsp(fakeLsp);
    const oracle = startOracle(root, fakeLsp, pidLog, {
      CODE_ORACLE_PREWARM: '0',
      CODE_ORACLE_MAX_INFLIGHT_REQUESTS: '2',
    });
    const lines = createInterface({ input: oracle.child.stdout });
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
          () => reject(new Error(`Oracle ping timed out: ${oracle.stderr()}`)),
          3000,
        );
        pending.set(requestId, (response) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolveResponse(response);
        });
        oracle.child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'ping', params: {} })}\n`,
        );
      });
    };
    try {
      oracle.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'definition',
            arguments: { root, file: source, line: 0, character: 13 },
          },
        })}\n`,
      );
      let observedActiveScan = false;
      const deadline = Date.now() + 3000;
      while (!observedActiveScan && Date.now() < deadline) {
        const response = await ping();
        const runtime = (
          response.result as {
            runtime: { projectScanAdmission: { active: number } };
          }
        ).runtime;
        observedActiveScan = runtime.projectScanAdmission.active === 1;
      }
      assert.equal(
        observedActiveScan,
        true,
        `the Oracle project scan was never observed as active: ${oracle.stderr()}`,
      );
      assert.deepEqual(readPids(pidLog), []);

      const exited = once(oracle.child, 'exit');
      oracle.child.stdin.end();
      const [code] = await withTimeout(
        exited,
        3000,
        `Oracle stayed alive after scan-owner EOF: ${oracle.stderr()}`,
      );
      assert.equal(code, 0, oracle.stderr());
      assert.ok(readPids(pidLog).every((pid) => !pidAlive(pid)));
    } finally {
      lines.close();
      await stopOracle(oracle.child, readPids(pidLog));
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('project fingerprint catches additions, deletions, and restored-mtime edits', async () => {
  const root = canonicalTempDir('code-oracle-epoch-');
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
  assert.equal(
    await scanProjectEpoch(root),
    first,
    'deleting the added source restores the original fingerprint',
  );

  const before = statSync(source);
  writeFileSync(source, 'export const z = 1\n'); // equal size
  utimesSync(source, before.atime, before.mtime);
  const afterSourceEdit = await scanProjectEpoch(root);
  assert.notEqual(
    afterSourceEdit,
    first,
    'ctime catches an equal-size edit with restored mtime',
  );

  writeFileSync(config, JSON.stringify({ include: ['src/*.ts'] }));
  assert.notEqual(
    await scanProjectEpoch(root),
    afterSourceEdit,
    'project configuration participates in the fingerprint',
  );
});

test('an active Oracle project scan observes cancellation', async () => {
  const root = canonicalTempDir('code-oracle-cancel-scan-');
  writeWideTsFixtures(root, 256);
  const controller = new AbortController();
  const scan = scanProjectEpoch(root, controller.signal);
  setImmediate(() => {
    controller.abort(new Error('cancel active Oracle scan'));
  });
  await assert.rejects(scan, /cancel active Oracle scan/);
  rmSync(root, { recursive: true, force: true });
});

// Pure resolver, no LSP: the name→declaration decision behind the interface-vs-class
// footgun. A bare name that lives in two containers must surface both, never silently
// anchor on the first (the earlier interface method), and a qualified Container.name
// must pin the exact declaration.
test('resolveNamePosition: bare ambiguity is surfaced; qualified name disambiguates (no LSP)', () => {
  const syms: OracleSym[] = [
    {
      name: 'WebSocketLike',
      container: null,
      line: 0,
      character: 17,
      kind: 11,
    }, // interface
    {
      name: 'send',
      container: 'WebSocketLike',
      line: 1,
      character: 2,
      kind: 6,
    }, // earlier same-name decl
    {
      name: 'RunChannelClient',
      container: null,
      line: 3,
      character: 13,
      kind: 5,
    }, // class
    {
      name: 'send',
      container: 'RunChannelClient',
      line: 5,
      character: 2,
      kind: 6,
    }, // later same-name decl
    {
      name: 'open',
      container: 'RunChannelClient',
      line: 8,
      character: 2,
      kind: 6,
    },
  ];

  // bare `send` matches two containers → ambiguous, not silently the first (interface)
  const amb = resolveNamePosition(syms, 'send');
  assert.ok(
    amb && 'ambiguous' in amb,
    `expected ambiguous, got ${JSON.stringify(amb)}`,
  );
  assert.deepEqual(amb.ambiguous.map((c) => c.container).sort(), [
    'RunChannelClient',
    'WebSocketLike',
  ]);

  // qualified names anchor the exact declaration (the reported fix)
  assert.deepEqual(resolveNamePosition(syms, 'RunChannelClient.send'), {
    line: 5,
    character: 2,
  });
  assert.deepEqual(resolveNamePosition(syms, 'WebSocketLike.send'), {
    line: 1,
    character: 2,
  });

  // a bare name unique to one container resolves cleanly
  assert.deepEqual(resolveNamePosition(syms, 'open'), {
    line: 8,
    character: 2,
  });
  assert.deepEqual(resolveNamePosition(syms, 'RunChannelClient'), {
    line: 3,
    character: 13,
  });

  // overload signatures share one container → collapse to the first, NOT ambiguous
  const overloads: OracleSym[] = [
    { name: 'foo', container: 'C', line: 10, character: 2, kind: 6 },
    { name: 'foo', container: 'C', line: 12, character: 2, kind: 6 },
  ];
  assert.deepEqual(resolveNamePosition(overloads, 'foo'), {
    line: 10,
    character: 2,
  });

  // prefer a declaration kind (Function) over a non-decl (Variable) of the same name
  const mixed: OracleSym[] = [
    { name: 'bar', container: null, line: 20, character: 6, kind: 13 }, // Variable
    { name: 'bar', container: null, line: 22, character: 9, kind: 12 }, // Function
  ];
  assert.deepEqual(resolveNamePosition(mixed, 'bar'), {
    line: 22,
    character: 9,
  });

  // unknown name → null → caller then does the comment/import-skipping text scan
  assert.equal(resolveNamePosition(syms, 'nope'), null);
});

// The interface-dispatch case, as a real fixture (was only a comment + a buggy spike):
// `implementations` must resolve an interface method to its concrete impls — the
// type-aware CHA that a structural call graph cannot draw.
test(
  'implementations resolves an interface method to every concrete impl (type-aware CHA)',
  {
    skip: hasTsgo ? false : 'tsgo not installed (npm install in code-oracle/)',
    timeout: 90_000,
  },
  async () => {
    const root = canonicalTempDir('code-oracle-');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'nodenext',
          moduleResolution: 'nodenext',
        },
        include: ['*.ts'],
      }),
    );
    writeFileSync(
      join(root, 'shape.ts'),
      ['export interface Shape {', '  area(): number;', '}', ''].join('\n'),
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
    const r = (await query('implementations', {
      file: join(root, 'shape.ts'),
      line: 1,
      character: 2,
      root,
    })) as {
      tool: string;
      count: number;
      coverage: { kind: string };
      implementationEvidence: { runtimeObserved: boolean; likelyCount: number };
      results: {
        file: string;
        line: number;
        container: string | null;
        likelihood: string;
        staticEvidence?: { kind: string }[];
      }[];
    };
    assert.equal(r.tool, 'implementations');
    assert.ok(
      r.count >= 2,
      `expected >= 2 concrete impls, got ${r.count}: ${JSON.stringify(r.results)}`,
    );
    assert.equal(r.coverage.kind, 'sound-overapproximation');
    assert.equal(r.implementationEvidence.runtimeObserved, false);
    const circle = r.results.find((result) => result.container === 'Circle');
    const square = r.results.find((result) => result.container === 'Square');
    assert.equal(circle?.likelihood, 'likely');
    assert.ok(
      circle?.staticEvidence?.some(
        (evidence) => evidence.kind === 'constructor',
      ),
    );
    assert.equal(square?.likelihood, 'possible');
    assert.equal(r.implementationEvidence.likelyCount, 1);

    const unranked = (await query('implementations', {
      file: join(root, 'shape.ts'),
      line: 1,
      character: 2,
      root,
      evidence: false,
    })) as {
      count: number;
      implementationEvidence: { basis: string };
      results: { likelihood?: string }[];
    };
    assert.equal(
      unranked.count,
      r.count,
      'opting out of evidence must not change the possible set',
    );
    assert.equal(unranked.implementationEvidence.basis, 'not-requested');
    assert.ok(
      unranked.results.every((result) => result.likelihood === undefined),
    );
  },
);

// Real footgun (firsthand 2026-07): asking callers by the bare name `send` silently
// anchored on the EARLIER same-name declaration — interface WebSocketLike.send — and
// returned socket.send() sites, not the intended class method RunChannelClient.send.
// A bare name that matches two declarations in different containers must NOT be picked
// silently: surface the ambiguity, and let a qualified `Container.name` disambiguate.
test(
  'bare name flags same-file same-name ambiguity; qualified name anchors the right declaration',
  {
    skip: hasTsgo ? false : 'tsgo not installed (npm install in code-oracle/)',
    timeout: 90_000,
  },
  async () => {
    const root = canonicalTempDir('code-oracle-');
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'nodenext',
          moduleResolution: 'nodenext',
        },
        include: ['*.ts'],
      }),
    );
    writeFileSync(
      join(root, 'chan.ts'),
      [
        'export interface WebSocketLike {',
        '  send(data: string): void;', // WebSocketLike.send — the EARLIER decl
        '}',
        'export class RunChannelClient {',
        '  constructor(private socket: WebSocketLike) {}',
        '  send(data: string): void {', // RunChannelClient.send — the LATER decl
        '    this.socket.send(data);', // caller of WebSocketLike.send (through the interface)
        '  }',
        '  open()  { this.send("o"); }', // caller of RunChannelClient.send
        '  close() { this.send("c"); }', // caller of RunChannelClient.send
        '  ping()  { this.send("p"); }', // caller of RunChannelClient.send
        '}',
        '',
      ].join('\n'),
    );
    const file = join(root, 'chan.ts');

    // 1) bare `send` is ambiguous across two containers → surfaced, not silently picked.
    const amb = (await query('callers', { file, name: 'send', root })) as {
      error?: string;
      candidates?: { name: string }[];
    };
    assert.ok(
      amb.error && Array.isArray(amb.candidates),
      `expected ambiguity, got ${JSON.stringify(amb)}`,
    );
    assert.deepEqual(amb.candidates!.map((c) => c.name).sort(), [
      'RunChannelClient.send',
      'WebSocketLike.send',
    ]);

    // 2) qualified name anchors the class method → only the this.send() sites, never socket.send.
    const cls = (await query('callers', {
      file,
      name: 'RunChannelClient.send',
      root,
    })) as { count: number; results: { preview: string }[] };
    const previews = cls.results.map((r) => r.preview).join('\n');
    assert.ok(
      cls.count >= 3,
      `expected the 3 this.send() callers, got ${cls.count}: ${JSON.stringify(cls.results)}`,
    );
    assert.ok(
      !/socket\.send/.test(previews),
      `socket.send must not be a caller of RunChannelClient.send: ${previews}`,
    );

    // 3) the interface method resolves to the socket.send() site, not the this.send() ones.
    const iface = (await query('callers', {
      file,
      name: 'WebSocketLike.send',
      root,
    })) as { count: number; results: { preview: string }[] };
    assert.ok(
      iface.results.some((r) => /this\.socket\.send/.test(r.preview)),
      `expected socket.send caller, got ${JSON.stringify(iface.results)}`,
    );
  },
);

test(
  'callers supplements config-less MJS reverse importers without opening the consumer',
  {
    skip: hasTsgo ? false : 'tsgo not installed (npm install in code-oracle/)',
    timeout: 90_000,
  },
  async () => {
    const root = canonicalTempDir('code-oracle-inferred-mjs-');
    const definitionFile = join(root, 'definition.mjs');
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ type: 'module', private: true }),
      );
      writeFileSync(definitionFile, 'export function target() { return 1; }\n');
      writeFileSync(
        join(root, 'caller.mjs'),
        "import { target as renamed } from './definition.mjs';\nexport const run = () => renamed();\n",
      );

      const result = (await query('callers', {
        file: definitionFile,
        name: 'target',
        root,
      })) as {
        count: number;
        results: { file: string; preview: string; basis?: string }[];
        coverage: { kind: string };
        staticSupplement: { count: number };
      };
      assert.equal(
        result.count,
        1,
        `config-less MJS callers must include unopened reverse importers: ${JSON.stringify(result)}`,
      );
      assert.equal(result.results[0]?.file, 'caller.mjs');
      assert.match(result.results[0]?.preview ?? '', /renamed\(\)/);
      assert.equal(result.results[0]?.basis, 'static-import-call');
      assert.equal(result.coverage.kind, 'checker-plus-static');
      assert.equal(result.staticSupplement.count, 1);
    } finally {
      disposeAll();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'callers reconciles added, modified, and deleted sibling files after warmup',
  {
    skip: hasTsgo ? false : 'tsgo not installed (npm install in code-oracle/)',
    timeout: 90_000,
  },
  async () => {
    const root = canonicalTempDir('code-oracle-dirty-callers-');
    const definitionFile = join(root, 'definition.ts');
    const callerFile = join(root, 'caller.ts');

    try {
      writeFileSync(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            module: 'nodenext',
            moduleResolution: 'nodenext',
          },
          include: ['*.ts'],
        }),
      );
      writeFileSync(
        definitionFile,
        'export function target(): number { return 1; }\n',
      );

      const before = (await query('callers', {
        file: definitionFile,
        name: 'target',
        root,
      })) as { count: number };
      assert.equal(before.count, 0);

      writeFileSync(
        callerFile,
        "import { target } from './definition.js';\nexport const run = () => target();\n",
      );
      const afterAddition = (await query('callers', {
        file: definitionFile,
        name: 'target',
        root,
      })) as { count: number; results: { file: string }[] };
      assert.equal(
        afterAddition.count,
        1,
        `new sibling caller must enter the warm project: ${JSON.stringify(afterAddition)}`,
      );
      assert.equal(afterAddition.results[0]?.file, 'caller.ts');

      writeFileSync(
        callerFile,
        "import { target } from './definition.js';\nexport const first = () => target();\nexport const second = () => target();\n",
      );
      const afterModification = (await query('callers', {
        file: definitionFile,
        name: 'target',
        root,
      })) as { count: number };
      assert.equal(
        afterModification.count,
        2,
        `modified sibling content must replace the warm overlay: ${JSON.stringify(afterModification)}`,
      );

      unlinkSync(callerFile);
      const afterDeletion = (await query('callers', {
        file: definitionFile,
        name: 'target',
        root,
      })) as { count: number };
      assert.equal(
        afterDeletion.count,
        0,
        `deleted sibling must leave the project graph: ${JSON.stringify(afterDeletion)}`,
      );
    } finally {
      disposeAll();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
