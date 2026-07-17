#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, encoding) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

const changed = git(['diff', '--quiet', '--', 'dist']);
if (changed.status !== 0) {
  if (changed.status !== 1) process.exit(changed.status ?? 1);
  process.stderr.write(
    'Committed dist is stale. Run npm run build, stage dist, and retry.\n',
  );
  process.exit(1);
}

const untracked = git(
  ['ls-files', '--others', '--exclude-standard', '--', 'dist'],
  'utf8',
);
if (untracked.status !== 0) process.exit(untracked.status ?? 1);
if (untracked.stdout.trim()) {
  process.stderr.write(
    `Generated dist contains untracked files:\n${untracked.stdout}`,
  );
  process.exit(1);
}

process.stdout.write('Committed dist matches the current build.\n');
