#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Registry tarballs already contain dist. Git dependencies do not, so npm's
// prepare lifecycle builds them after installing the checkout's devDependencies.
if (!existsSync(resolve('dist', 'cli', 'main.js'))) {
  const result = spawnSync(process.execPath, [resolve('scripts', 'build.mjs')], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
