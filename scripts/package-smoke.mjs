#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'code-map-package-'));

function npm(args, cwd = projectRoot) {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', windowsHide: true })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        cwd, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32',
      });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `npm ${args[0]} failed`);
  return result.stdout;
}

function node(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd ?? temp,
    input: options.input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `node ${args[0]} failed`);
  return result;
}

try {
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temp]));
  const tarball = join(temp, packed[0].filename);
  const installRoot = join(temp, 'install');
  npm(['install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund', tarball], temp);

  const runInstalledMap = (args) => {
    const bin = join(installRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'map.cmd' : 'map');
    const result = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', bin, ...args], {
          cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 30_000,
        })
      : spawnSync(bin, args, { cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'installed map binary failed');
    return result;
  };

  const packageRoot = join(installRoot, 'node_modules', '@annyeong844', 'code-map');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const cli = join(packageRoot, manifest.bin.map.replace(/^\.\//u, ''));
  const server = join(packageRoot, manifest.bin['map-mcp'].replace(/^\.\//u, ''));
  const version = runInstalledMap(['--version']).stdout.trim();
  if (version !== manifest.version) throw new Error(`installed CLI version ${version} != package ${manifest.version}`);
  const setup = JSON.parse(runInstalledMap(['setup', 'codex', '--json']).stdout);
  if (realpathSync(setup.packageRoot) !== realpathSync(packageRoot) || !setup.steps?.some((step) => step.args?.includes('map-mcp'))) {
    throw new Error('installed setup plan does not point at its own marketplace and MCP binary');
  }

  const fixture = join(temp, 'fixture');
  mkdirSync(join(fixture, 'src'), { recursive: true });
  writeFileSync(join(fixture, 'src', 'sample.ts'), 'export function alpha(): number {\n  return 42;\n}\n');
  writeFileSync(join(fixture, 'src', 'sample.py'), 'def python_alpha():\n    return 43\n');
  const indexPath = join(fixture, '.map-index.json');
  runInstalledMap(['index', '--root', fixture, '--out', indexPath]);
  const read = JSON.parse(runInstalledMap(['read', 'alpha', '--index', indexPath, '--json']).stdout);
  if (read.status !== 'exact' || !read.raw?.includes('function alpha')) {
    throw new Error(`installed CLI read smoke failed: ${JSON.stringify(read)}`);
  }
  const pythonRead = JSON.parse(runInstalledMap(['read', 'python_alpha', '--index', indexPath, '--json']).stdout);
  if (pythonRead.status !== 'exact' || !pythonRead.raw?.includes('def python_alpha')) {
    throw new Error(`installed Python read smoke failed: ${JSON.stringify(pythonRead)}`);
  }

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read', arguments: { root: fixture, ref: 'alpha' } } },
  ].map((request) => JSON.stringify(request)).join('\n') + '\n';
  const mcp = node([server], { cwd: temp, input: requests });
  const responses = mcp.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const initialized = responses.find((response) => response.id === 1);
  const listed = responses.find((response) => response.id === 2);
  const called = responses.find((response) => response.id === 3);
  if (initialized?.result?.serverInfo?.version !== manifest.version) throw new Error('MCP version does not match package');
  const readTool = listed?.result?.tools?.find((tool) => tool.name === 'read');
  if (!readTool?.inputSchema?.properties?.root) throw new Error('fresh MCP schema lost the required root selector');
  const payload = JSON.parse(called?.result?.content?.[0]?.text ?? '{}');
  if (payload.status !== 'exact') throw new Error(`fresh MCP read smoke failed: ${JSON.stringify(payload)}`);

  process.stdout.write(`Fresh package smoke passed (${manifest.version}; TS/Python CLI + MCP + root schema).\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
