#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformKey =
  process.env.CODE_MAP_NATIVE_PLATFORM ?? `${process.platform}-${process.arch}`;
const executable = platformKey.startsWith('win32-')
  ? 'code-map-python.exe'
  : 'code-map-python';
const binary = resolve(
  process.env.CODE_MAP_PY_NATIVE ??
    resolve(root, 'native', 'bin', platformKey, executable),
);
if (statSync(binary).size === 0) {
  throw new Error(`Empty native extractor: ${binary}`);
}

const fixture = mkdtempSync(join(tmpdir(), 'code-map-native-smoke-'));
try {
  mkdirSync(join(fixture, 'src'));
  const source =
    'NOTE = "😀"\r\n@decorator\r\ndef alpha(value):\r\n    return value\r\n';
  writeFileSync(join(fixture, 'src', 'sample.py'), source, 'utf8');
  const result = spawnSync(binary, [fixture], {
    input: JSON.stringify({
      files: ['src/sample.py'],
      targets: ['src/sample.py'],
    }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr || `Native extractor exited ${result.status}`,
    );
  }
  const output = JSON.parse(result.stdout);
  const parsedFile = output.p?.find(
    (candidate) => candidate[0] === 'src/sample.py',
  );
  const entry = parsedFile?.[2]?.find((candidate) => candidate[0] === 'alpha');
  const binding = parsedFile?.[2]?.find((candidate) => candidate[0] === 'NOTE');
  const raw = entry && source.slice(entry[2], entry[3]);
  const bindingRaw = binding && source.slice(binding[2], binding[3]);
  const token = createHash('sha256').update(source).digest('hex').slice(0, 16);
  if (
    output.v !== 1 ||
    output.m?.length !== 0 ||
    output.i?.length !== 0 ||
    parsedFile?.[1] !== token ||
    binding?.[1] !== 3 ||
    bindingRaw !== 'NOTE = "😀"' ||
    !raw?.startsWith('@decorator\r\ndef alpha(value):') ||
    !raw.endsWith('return value')
  ) {
    throw new Error(`Native extractor smoke mismatch: ${result.stdout}`);
  }
  process.stdout.write(`Native ${platformKey} smoke passed.\n`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
