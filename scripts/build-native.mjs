#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformKey = `${process.platform}-${process.arch}`;
const executable =
  process.platform === 'win32' ? 'code-map-python.exe' : 'code-map-python';
const staged = resolve(root, 'native', 'bin', platformKey, executable);

if (process.env.CODE_MAP_USE_STAGED_NATIVE === '1') {
  if (!existsSync(staged) || statSync(staged).size === 0) {
    throw new Error(`Staged native extractor is missing or empty: ${staged}`);
  }
  process.stdout.write(`Using staged ${platformKey} extractor at ${staged}\n`);
  process.exit(0);
}

const cargo = spawnSync(
  'cargo',
  [
    'build',
    '--release',
    '--locked',
    '--manifest-path',
    'native/python-extractor/Cargo.toml',
  ],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
if (cargo.error) throw cargo.error;
if (cargo.status !== 0) process.exit(cargo.status ?? 1);

const stage = spawnSync(process.execPath, ['scripts/stage-native.mjs'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
if (stage.error) throw stage.error;
process.exit(stage.status ?? 1);
