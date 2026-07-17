import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'code-map-prepare-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(
    join(projectRoot, 'scripts', 'prepare-package.mjs'),
    join(root, 'scripts', 'prepare-package.mjs'),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      dependencies: { 'oxc-parser': '^0.136.0' },
      devDependencies: {
        '@types/node': '^22.19.21',
        oxlint: '1.74.0',
        typescript: '^7.0.2',
      },
      type: 'module',
    }),
  );
  writeFileSync(
    join(root, 'fake-npm.mjs'),
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const root = process.cwd();
for (const relative of [
  'node_modules/typescript/bin/tsc',
  'node_modules/@types/node/package.json',
  'node_modules/oxc-parser/package.json',
]) {
  const file = resolve(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{}');
}
writeFileSync(resolve(root, 'bootstrap.json'), JSON.stringify({
  argv: process.argv.slice(2),
  global: process.env.npm_config_global,
  location: process.env.npm_config_location,
  prefix: process.env.npm_config_prefix,
}));
`,
  );
  writeFileSync(
    join(root, 'scripts', 'build.mjs'),
    `import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const output = resolve('dist', 'cli', 'main.js');
mkdirSync(resolve('dist', 'cli'), { recursive: true });
writeFileSync(output, '');
writeFileSync(resolve('build-ran.txt'), 'yes');
`,
  );
  return root;
}

test('Git prepare resets inherited global npm config and bootstraps only build dependencies', () => {
  const root = createFixture();
  try {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'prepare-package.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_global: 'true',
          npm_config_location: 'global',
          npm_config_prefix: join(root, 'wrong-global-prefix'),
          npm_execpath: join(root, 'fake-npm.mjs'),
        },
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const bootstrap: {
      argv: string[];
      global: string;
      location: string;
      prefix: string;
    } = JSON.parse(readFileSync(join(root, 'bootstrap.json'), 'utf8'));
    assert.equal(bootstrap.global, 'false');
    assert.equal(bootstrap.location, 'project');
    assert.equal(bootstrap.prefix, root);
    assert.deepEqual(bootstrap.argv.slice(0, 2), [
      'install',
      '--ignore-scripts',
    ]);
    assert.ok(bootstrap.argv.includes('--global=false'));
    assert.ok(bootstrap.argv.includes('--location=project'));
    assert.ok(!bootstrap.argv.includes('--omit=optional'));
    assert.deepEqual(
      bootstrap.argv.slice(bootstrap.argv.indexOf('--prefix') + 1),
      [
        root,
        'typescript@^7.0.2',
        '@types/node@^22.19.21',
        'oxc-parser@^0.136.0',
      ],
    );
    assert.ok(!bootstrap.argv.some((argument) => argument.includes('oxlint')));
    assert.ok(existsSync(join(root, 'build-ran.txt')));
    assert.ok(existsSync(join(root, 'dist', 'cli', 'main.js')));
    assert.ok(!existsSync(join(root, 'package-lock.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git prepare leaves an already packed dist untouched', () => {
  const root = createFixture();
  try {
    const entry = join(root, 'dist', 'cli', 'main.js');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'prebuilt');
    const env = { ...process.env };
    delete env.npm_execpath;

    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'prepare-package.mjs')],
      {
        cwd: root,
        encoding: 'utf8',
        env,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(entry, 'utf8'), 'prebuilt');
    assert.ok(!existsSync(join(root, 'bootstrap.json')));
    assert.ok(!existsSync(join(root, 'build-ran.txt')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
