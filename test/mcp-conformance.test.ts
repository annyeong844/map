import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/core/build-index.ts';
import { saveIndex } from '../src/core/store.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

interface RpcResponse {
  id: string | number | null;
  result?: {
    serverInfo?: { name?: string };
    content?: { type: string; text: string }[];
  };
  error?: {
    code?: number;
    message?: string;
  };
}

async function exerciseWire(
  server: string,
  expectedName: string,
  limitEnv: Record<string, string>,
): Promise<void> {
  const child = spawn(process.execPath, [server], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODE_MAP_AUTO_INDEX: '0',
      CODE_ORACLE_PREWARM: '0',
      ...limitEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  const responses: RpcResponse[] = [];
  const received = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `timed out waiting for ${expectedName} conformance responses: ${stderr}`,
        ),
      );
    }, 5_000);
    lines.on('line', (line) => {
      try {
        responses.push(JSON.parse(line) as RpcResponse);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
        return;
      }
      if (responses.length === 3) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  try {
    child.stdin.write(`${'x'.repeat(256)}\n`);
    child.stdin.write('{broken-json\n');
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      })}\n`,
    );
    await received;

    assert.equal(responses[0].error?.code, -32600);
    assert.match(responses[0].error?.message ?? '', /exceeds 128 bytes/);
    assert.equal(responses[1].error?.code, -32700);
    assert.equal(responses[2].id, 1);
    assert.equal(responses[2].result?.serverInfo?.name, expectedName);

    const exited = once(child, 'exit', {
      signal: AbortSignal.timeout(5_000),
    });
    child.stdin.end();
    const [code] = await exited;
    assert.equal(code, 0, stderr);
  } finally {
    lines.close();
    if (child.exitCode == null && child.signalCode == null) child.kill();
  }
}

test('both MCP servers bound NDJSON bytes, report parse errors, and resynchronize', async () => {
  await exerciseWire(join(ROOT, 'src/mcp/server.ts'), 'code-map', {
    CODE_MAP_MAX_NDJSON_LINE_BYTES: '128',
  });
  await exerciseWire(join(ROOT, 'code-oracle/server.ts'), 'code-oracle', {
    CODE_ORACLE_MAX_NDJSON_LINE_BYTES: '128',
  });
});

test(
  'code-map preserves the tail of a large clean line-only result',
  { timeout: 10_000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'map-mcp-tail-'));
    const sourceDir = join(root, 'src');
    mkdirSync(sourceDir);
    const tail = 'CLEAN_MCP_TAIL_SENTINEL_7F9A';
    const body = Array.from(
      { length: 2_000 },
      (_, i) => `  void 0; // body ${i}`,
    ).join('\n');
    writeFileSync(
      join(sourceDir, 'huge.ts'),
      `export function hugeSymbol(): string {\n${body}\n` +
        `  return '${tail}';\n}\n`,
    );
    const { index } = await buildIndex({ root });
    const entry = index.entries.find(
      (candidate) => candidate.id === 'src/huge.ts#hugeSymbol',
    );
    assert.ok(entry);
    delete entry.charStart;
    delete entry.charEnd;
    delete entry.endLine;
    saveIndex(index, join(root, '.map-index.json'));

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODE_MAP_AUTO_INDEX: '0',
    };
    delete env.MAP_INDEX;
    const child = spawn(process.execPath, [join(ROOT, 'src/mcp/server.ts')], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const lines = createInterface({ input: child.stdout });
    try {
      const response = await new Promise<RpcResponse>(
        (resolveResponse, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`MCP read timed out: ${stderr}`)),
            5_000,
          );
          lines.once('line', (line) => {
            clearTimeout(timer);
            resolveResponse(JSON.parse(line) as RpcResponse);
          });
          child.stdin.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'read',
                arguments: {
                  ref: entry.id,
                  responseFormat: 'compact',
                },
              },
            })}\n`,
          );
        },
      );
      const output = response.result?.content?.[0]?.text ?? '';
      assert.match(output, /^\[exact /);
      assert.ok(output.length > 32_768, 'fixture must cross pipe buffering');
      assert.ok(
        output.includes(`return '${tail}';\n}`),
        `tail missing from MCP output: ${output.slice(-200)}`,
      );

      const exited = once(child, 'exit', {
        signal: AbortSignal.timeout(3_000),
      });
      child.stdin.end();
      const [code] = await exited;
      assert.equal(code, 0, stderr);
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
