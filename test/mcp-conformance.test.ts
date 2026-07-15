import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

interface RpcResponse {
  id: string | number | null;
  result?: {
    serverInfo?: { name?: string };
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
