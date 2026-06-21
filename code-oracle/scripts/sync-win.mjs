#!/usr/bin/env node
// Sync a standalone code-oracle install (server.ts + a *platform-correct* node_modules)
// from this source tree to a target dir, then `npm install` there.
//
// Why this exists: `npm i -g <local path>` SYMLINKS back to the source tree, so it
// reuses whatever platform's native tsgo binary already sits in code-oracle/node_modules.
// To run code-oracle on a DIFFERENT platform than the checkout was installed on — e.g. a
// fast win32 tsgo serving a WSL checkout over interop — you need a real copy + an install
// performed by THAT platform's npm. This does both.
//
// Usage (run with the TARGET platform's node/npm — that's what picks the binary):
//   node scripts/sync-win.mjs [targetDir]
//   targetDir: defaults to $CODE_ORACLE_TARGET, else <os-tmp>/code-oracle-win
//
//   # from Windows (gets native-preview-win32-x64):
//   node scripts\sync-win.mjs C:\Users\you\.local\code-oracle-win
//
// Then wire the MCP to: <that platform's node> <targetDir>/server.ts
import { cpSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // code-oracle/
const target = resolve(
  process.argv[2] ||
    process.env.CODE_ORACLE_TARGET ||
    join(process.env.TMPDIR || process.env.TEMP || '/tmp', 'code-oracle-win'),
);

mkdirSync(target, { recursive: true });
for (const f of ['server.ts', 'package.json', 'tsconfig.json', 'package-lock.json']) {
  const s = join(SRC, f);
  if (existsSync(s)) cpSync(s, join(target, f));
}
console.log(`synced source -> ${target}`);

// Static command (no user input) as a single shell string — avoids DEP0190 (args + shell).
const r = spawnSync('npm install --omit=dev', { cwd: target, stdio: 'inherit', shell: true });
if (r.status !== 0) {
  console.error('npm install failed in target');
  process.exit(r.status || 1);
}

const tnp = join(target, 'node_modules', '@typescript');
if (existsSync(tnp)) {
  const bins = readdirSync(tnp).filter((d) => d.startsWith('native-preview'));
  console.log('native binary:', bins.join(', ') || '(none — check optional deps)');
}
console.log(`done. wire MCP: <node> ${join(target, 'server.ts')}`);
