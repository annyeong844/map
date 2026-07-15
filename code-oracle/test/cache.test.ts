import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  isCachedOracleResult,
  ResultCacheStore,
  SourceLineCache,
} from '../oracle-cache.ts';

function oracleResult(root: string, index: number) {
  return {
    tool: 'callers',
    symbol: {
      file: 'src/service.ts',
      name: 'run',
      position: { line: index, character: 0 },
      futureSymbolField: true,
    },
    root,
    results: [
      {
        file: 'src/caller.ts',
        line: index + 1,
        preview: 'run();',
        futureLocationField: 'preserved',
      },
    ],
    count: 1,
    cached: false,
    coverage: {
      kind: 'checker-resolved',
      scope: 'project',
      residuals: [],
      futureCoverageField: 'preserved',
    },
    note: 'cache fixture',
    futureEvidence: { version: 2 },
    payload: String(index).repeat(96),
  };
}

function cacheFiles(directory: string, root: string) {
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return {
    snapshot: join(directory, `${digest}.json`),
    log: join(directory, `${digest}.jsonl`),
  };
}

test('cached oracle result validation keeps additive fields without accepting partial records', () => {
  const valid = oracleResult('root', 0);
  assert.equal(isCachedOracleResult(valid), true);
  assert.equal(isCachedOracleResult(null), false);
  assert.equal(isCachedOracleResult({ root: 'root' }), false);
  assert.equal(isCachedOracleResult({ ...valid, count: 2 }), false);
  assert.equal(isCachedOracleResult({ ...valid, results: [null] }), false);
});

test('result cache evicts resident roots by bytes and reloads exact answers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-result-cache-'));
  const maxBytes = 2048;
  const cache = new ResultCacheStore({
    directory,
    schema: 4,
    maxBytes,
    idleMs: 0,
    persistDelayMs: 60_000,
  });
  const roots = Array.from({ length: 12 }, (_, index) =>
    join(directory, `root-${index}`),
  );
  const values = roots.map((root, index) => oracleResult(root, index));

  try {
    for (let index = 0; index < roots.length; index++) {
      cache.store(roots[index], 'epoch', 'query', values[index]);
    }
    const bounded = cache.stats();
    assert.ok(bounded.evictions > 0);
    assert.ok(bounded.residentBytes <= maxBytes);
    assert.ok(bounded.maxObservedBytes <= maxBytes);

    const reloaded = cache.lookup(roots[0], 'epoch', 'query');
    assert.equal(reloaded.hit, true);
    if (reloaded.hit) assert.deepEqual(reloaded.value, values[0]);
    assert.ok(cache.stats().residentBytes <= maxBytes);
  } finally {
    cache.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('result cache discards only invalid snapshot, delta, and live-hit records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-result-boundary-'));
  const root = join(directory, 'root');
  const epoch = 'epoch';
  const files = cacheFiles(directory, root);
  const options = {
    directory,
    schema: 4,
    maxBytes: 64 * 1024,
    idleMs: 0,
    persistDelayMs: 60_000,
  };
  const snapshotValue = oracleResult(root, 1);
  const deltaValue = oracleResult(root, 2);

  try {
    const seed = new ResultCacheStore(options);
    seed.store(root, epoch, 'snapshot-valid', snapshotValue);
    seed.dispose();

    const snapshot = JSON.parse(readFileSync(files.snapshot, 'utf8')) as {
      entries: Record<string, unknown>;
    };
    snapshot.entries['snapshot-invalid'] = { root, partial: true };
    writeFileSync(files.snapshot, JSON.stringify(snapshot));
    appendFileSync(
      files.log,
      `${[
        {
          schema: options.schema,
          epoch,
          key: 'delta-valid',
          value: deltaValue,
        },
        {
          schema: options.schema,
          epoch,
          key: 'delta-invalid',
          value: ['not', 'an', 'oracle-result'],
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`,
    );

    const loaded = new ResultCacheStore(options);
    assert.deepEqual(loaded.lookup(root, epoch, 'snapshot-valid'), {
      hit: true,
      value: snapshotValue,
    });
    assert.deepEqual(loaded.lookup(root, epoch, 'delta-valid'), {
      hit: true,
      value: deltaValue,
    });
    assert.deepEqual(loaded.lookup(root, epoch, 'snapshot-invalid'), {
      hit: false,
    });
    assert.deepEqual(loaded.lookup(root, epoch, 'delta-invalid'), {
      hit: false,
    });

    loaded.store(root, epoch, 'store-invalid', { root, partial: true });
    assert.deepEqual(loaded.lookup(root, epoch, 'store-invalid'), {
      hit: false,
    });

    const mutated = oracleResult(root, 3);
    loaded.store(root, epoch, 'live-invalid', mutated);
    mutated.count = 2;
    assert.deepEqual(loaded.lookup(root, epoch, 'live-invalid'), {
      hit: false,
    });
    loaded.dispose();

    const compacted = JSON.parse(readFileSync(files.snapshot, 'utf8')) as {
      entries: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(compacted.entries).sort(), [
      'delta-valid',
      'snapshot-valid',
    ]);
    assert.equal(existsSync(files.log), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('targeted invalidation removes a persisted zero without touching positive answers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-result-invalidate-'));
  const root = join(directory, 'root');
  const epoch = 'epoch';
  const options = {
    directory,
    schema: 5,
    maxBytes: 64 * 1024,
    idleMs: 0,
    persistDelayMs: 60_000,
  };
  const zero = { ...oracleResult(root, 0), results: [], count: 0 };
  const positive = oracleResult(root, 1);

  try {
    const cache = new ResultCacheStore(options);
    cache.store(root, epoch, 'zero', zero);
    cache.store(root, epoch, 'positive', positive);
    assert.equal(
      cache.invalidateWhere(
        root,
        epoch,
        (value) => value.tool === 'callers' && value.count === 0,
      ),
      1,
    );
    assert.deepEqual(cache.lookup(root, epoch, 'zero'), { hit: false });
    assert.equal(cache.lookup(root, epoch, 'positive').hit, true);
    cache.dispose();

    const reloaded = new ResultCacheStore(options);
    assert.deepEqual(reloaded.lookup(root, epoch, 'zero'), { hit: false });
    assert.equal(reloaded.lookup(root, epoch, 'positive').hit, true);
    reloaded.dispose();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source previews stay exact when oversized files bypass resident retention', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oracle-source-cache-'));
  const maxBytes = 256;
  const cache = new SourceLineCache(maxBytes, 0, 160);

  try {
    for (let index = 0; index < 8; index++) {
      const firstLine = `line-${index}`;
      const file = join(directory, `source-${index}.ts`);
      writeFileSync(file, `${firstLine}\n${'x'.repeat(2048)}\n`);
      assert.equal(cache.line(file, 0, `token-${index}`), firstLine);
    }
    const stats = cache.stats();
    assert.ok(stats.evictions > 0);
    assert.ok(stats.residentBytes <= maxBytes);
    assert.ok(stats.maxObservedBytes <= maxBytes);
  } finally {
    cache.clear();
    rmSync(directory, { recursive: true, force: true });
  }
});
