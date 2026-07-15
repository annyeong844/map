import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpusScript = join(projectRoot, 'scripts', 'corpus-lab.mjs');

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test('corpus lab isolates workers and leaves source trees byte-for-byte alone', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'code-map-corpus-'));
  try {
    const corpusRoot = join(temporary, 'corpus with spaces');
    const firstRoot = join(corpusRoot, 'tiny-a');
    const secondRoot = join(corpusRoot, 'tiny-b');
    const firstSource =
      'export function alpha(value: number): number {\n  return value + 1;\n}\n';
    const secondSource =
      'export class Beta {\n  run() {\n    return 2;\n  }\n}\n';
    const existingIndex = '{"sentinel":"must stay untouched"}\n';
    write(join(firstRoot, 'src', 'alpha.ts'), firstSource);
    write(join(secondRoot, 'lib', 'beta.js'), secondSource);
    write(join(secondRoot, '.map-index.json'), existingIndex);
    const output = join(temporary, 'results', 'corpus.json');

    const run = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        corpusScript,
        '--root',
        corpusRoot,
        '--repos',
        'tiny-a,tiny-b',
        '--iterations',
        '3',
        '--samples',
        '2',
        '--no-differential',
        '--out',
        output,
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, CODE_MAP_CORPUS_RUNTIME: 'source' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /Corpus lab: 2\/2 repositories passed/);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(result.schemaVersion, 1);
    assert.deepEqual(result.summary, {
      repositories: 2,
      passed: 2,
      failed: 0,
      differentialFailed: false,
    });
    assert.equal(result.repositories.length, 2);
    for (const repository of result.repositories) {
      assert.equal(repository.status, 'passed');
      assert.equal(repository.process.cleanExit, true);
      assert.equal(repository.noOp.iterations, 3);
      assert.equal(repository.noOp.identityReused, true);
      assert.deepEqual(repository.reads.statusCounts, {
        exact: repository.reads.sampled,
      });
      assert.equal(repository.safety.passed, true);
    }
    assert.equal(existsSync(join(firstRoot, '.map-index.json')), false);
    assert.equal(
      readFileSync(join(firstRoot, 'src', 'alpha.ts'), 'utf8'),
      firstSource,
    );
    assert.equal(
      readFileSync(join(secondRoot, 'lib', 'beta.js'), 'utf8'),
      secondSource,
    );
    assert.equal(
      readFileSync(join(secondRoot, '.map-index.json'), 'utf8'),
      existingIndex,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('corpus lab compares the Fallow snapshots without mutating either side', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'code-map-corpus-diff-'));
  try {
    const corpusRoot = join(temporary, 'corpus');
    const left = join(corpusRoot, 'fallow-main');
    const right = join(corpusRoot, 'fallow-main(0715)');
    write(
      join(left, 'src', 'shared.ts'),
      'export function shared(): number { return 1; }\nexport const removed = 1;\n',
    );
    write(
      join(right, 'src', 'shared.ts'),
      'export function shared(): number { return 2; }\nexport const added = 2;\n',
    );
    const output = join(temporary, 'diff.json');
    const run = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        corpusScript,
        '--root',
        corpusRoot,
        '--repos',
        'fallow-main,fallow-main(0715)',
        '--iterations',
        '1',
        '--samples',
        '2',
        '--differential',
        '--out',
        output,
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, CODE_MAP_CORPUS_RUNTIME: 'source' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(result.summary.differentialFailed, false);
    assert.equal(result.differential.status, 'passed');
    assert.equal(result.differential.common, 1);
    assert.equal(result.differential.added, 1);
    assert.equal(result.differential.removed, 1);
    assert.equal(existsSync(join(left, '.map-index.json')), false);
    assert.equal(existsSync(join(right, '.map-index.json')), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('corpus lab rejects repository traversal before starting a worker', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'code-map-corpus-root-'));
  try {
    const run = spawnSync(
      process.execPath,
      [corpusScript, '--root', temporary, '--repos', '..'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, CODE_MAP_CORPUS_RUNTIME: 'source' },
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.equal(run.status, 1);
    assert.match(run.stderr, /escapes the corpus root/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
