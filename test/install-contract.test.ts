import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('GitHub installs need no dependency lifecycle approval', () => {
  const manifest: {
    bin: Record<string, string>;
    files: string[];
    scripts: Record<string, string>;
  } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(
      manifest.scripts[lifecycle],
      undefined,
      `${lifecycle} would be blocked in a default npm 11 global install`,
    );
  }
  assert.ok(manifest.files.includes('dist'));
  for (const target of Object.values(manifest.bin)) {
    assert.ok(existsSync(resolve(root, target)), `missing committed ${target}`);
  }

  for (const readme of ['README.md', 'README.ko.md']) {
    const text = readFileSync(resolve(root, readme), 'utf8');
    assert.ok(text.includes('/archive/refs/heads/main.tar.gz'));
    assert.ok(!text.includes('npm install -g github:annyeong844/map'));
  }
});
