#!/usr/bin/env node
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformKey =
  process.env.CODE_MAP_NATIVE_PLATFORM ?? `${process.platform}-${process.arch}`;
const supported = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
]);
if (!supported.has(platformKey)) {
  throw new Error(`Unsupported native platform key: ${platformKey}`);
}

const executable = platformKey.startsWith('win32-')
  ? 'code-map-python.exe'
  : 'code-map-python';
const source = resolve(
  process.env.CODE_MAP_NATIVE_BINARY ??
    resolve(
      root,
      'native',
      'python-extractor',
      'target',
      ...(process.env.CODE_MAP_NATIVE_TARGET
        ? [process.env.CODE_MAP_NATIVE_TARGET]
        : []),
      'release',
      executable,
    ),
);
if (!existsSync(source)) {
  throw new Error(`Native extractor build output was not found: ${source}`);
}

const destination = resolve(root, 'native', 'bin', platformKey, executable);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
if (!platformKey.startsWith('win32-')) chmodSync(destination, 0o755);
process.stdout.write(`Staged ${platformKey} extractor at ${destination}\n`);
