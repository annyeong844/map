#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const archiveUrl = process.env.CODE_MAP_ARCHIVE_URL;
if (!archiveUrl) {
  throw new Error('CODE_MAP_ARCHIVE_URL is required.');
}
const parsedUrl = new URL(archiveUrl);
if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com') {
  throw new Error('CODE_MAP_ARCHIVE_URL must be an HTTPS github.com URL.');
}

const temporary = mkdtempSync(join(tmpdir(), 'code-map-github-archive-'));
const installRoot = join(temporary, 'install');
const fixture = join(temporary, 'fixture');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? temporary,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `${command} exited ${result.status}`,
    );
  }
  return result;
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && existsSync(npmCli)) {
    return run(process.execPath, [npmCli, ...args], { timeout: 300_000 });
  }
  if (process.platform === 'win32') {
    return run(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/c', 'npm.cmd', ...args],
      {
        timeout: 300_000,
      },
    );
  }
  return run('npm', args, { timeout: 300_000 });
}

try {
  mkdirSync(installRoot, { recursive: true });
  runNpm([
    'install',
    '--global',
    '--prefix',
    installRoot,
    '--strict-allow-scripts',
    '--no-audit',
    '--no-fund',
    archiveUrl,
  ]);

  const packageRoot = join(
    installRoot,
    'node_modules',
    '@annyeong844',
    'code-map',
  );
  if (!existsSync(packageRoot) || lstatSync(packageRoot).isSymbolicLink()) {
    throw new Error('GitHub archive did not install as a resident package.');
  }
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  );
  const mapBin =
    process.platform === 'win32'
      ? join(installRoot, 'map.cmd')
      : join(installRoot, 'bin', 'map');
  const mapCommand =
    process.platform === 'win32'
      ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', mapBin]]
      : [mapBin, []];
  const runMap = (args, options) =>
    run(mapCommand[0], [...mapCommand[1], ...args], options);

  const version = runMap(['--version']).stdout.trim();
  if (version !== manifest.version) {
    throw new Error(`installed version ${version} != ${manifest.version}`);
  }

  mkdirSync(join(fixture, 'src'), { recursive: true });
  writeFileSync(
    join(fixture, 'src', 'sample.ts'),
    'export function alpha(): number {\n  return 42;\n}\n',
  );
  writeFileSync(
    join(fixture, 'src', 'sample.py'),
    'def python_alpha():\n    return 43\n',
  );
  const indexPath = join(fixture, '.map-index.json');
  const backend = { CODE_MAP_PY_BACKEND: 'stdlib' };
  runMap(['index', '--root', fixture, '--out', indexPath], { env: backend });
  for (const ref of ['alpha', 'python_alpha']) {
    const read = JSON.parse(
      runMap(['read', ref, '--index', indexPath, '--json']).stdout,
    );
    if (read.status !== 'exact') {
      throw new Error(`GitHub archive read failed: ${JSON.stringify(read)}`);
    }
  }

  process.stdout.write(
    `GitHub archive smoke passed (${version}; resident package + TS/Python exact reads).\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
