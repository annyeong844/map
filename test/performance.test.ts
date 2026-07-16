import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildIndex } from '../src/core/build-index.ts';
import { computeFanIn } from '../src/core/fan-in.ts';
import { locate } from '../src/core/locate.ts';
import { read, readMany } from '../src/core/read.ts';
import {
  exactFileEntryRange,
  getPreparedLookup,
  nextSiblingLine,
  prepareLookup,
} from '../src/core/store.ts';
import {
  INDEX_VERSION,
  type MapEntry,
  type MapIndex,
} from '../src/core/types.ts';
import { token } from '../src/core/util.ts';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'map-perf-'));
  for (const [file, source] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

function syntheticIndex(
  root: string,
  entries: MapEntry[],
  fileTokens: Record<string, string> = {},
): MapIndex {
  return {
    meta: {
      tool: 'code-map',
      version: INDEX_VERSION,
      generated: '',
      builtAtMs: 0,
      root,
      entryCount: entries.length,
      fileCount: Object.keys(fileTokens).length,
    },
    fileTokens,
    fileStats: {},
    fileImports: {},
    entries,
  };
}

test('bounded locate returns the exact same ordering as a full candidate sort', () => {
  const entries: MapEntry[] = Array.from({ length: 5_000 }, (_, i) => {
    let kind = 'FunctionDeclaration';
    if (i % 5 === 0) kind = 'TSInterfaceDeclaration';
    else if (i % 3 === 0) kind = 'ClassMethod';
    return {
      id: `src/f${i % 37}.ts#computeThing${i}`,
      name: `computeThing${i}`,
      kind,
      file: `src/f${i % 37}.ts`,
      line: i + 1,
      searchText: `computeThing${i}`,
      fanIn: (i * 17) % 29,
    };
  });
  const index = syntheticIndex(process.cwd(), entries);
  const bounded = locate(index, 'compute thing', { limit: 20 }).map(
    (hit) => hit.id,
  );
  const exhaustive = locate(index, 'compute thing', { limit: entries.length })
    .slice(0, 20)
    .map((hit) => hit.id);
  assert.deepEqual(bounded, exhaustive);
});

test('allocation-free subword matching preserves camel, separator, acronym, and fuzzy tiers', () => {
  const names = [
    'computeDiff',
    'compute_diff',
    'compute-diff',
    'XMLHttpRequest',
    'xComputeDiffY',
    'İcomputeDiff',
  ];
  const entries: MapEntry[] = names.map((name, i) => ({
    id: `f${i}.ts#${name}`,
    name,
    kind: 'FunctionDeclaration',
    file: `f${i}.ts`,
    line: 1,
    searchText: name,
  }));
  const index = syntheticIndex(process.cwd(), entries);
  const score = (id: string, query: string): number | undefined =>
    locate(index, query, { limit: entries.length }).find((hit) => hit.id === id)
      ?.score;

  assert.equal(score('f0.ts#computeDiff', 'computeDiff'), 100);
  assert.equal(score('f0.ts#computeDiff', 'COMPUTEDIFF'), 92);
  assert.equal(score('f0.ts#computeDiff', 'diff'), 80);
  assert.equal(score('f1.ts#compute_diff', 'diff'), 80);
  assert.equal(score('f2.ts#compute-diff', 'diff'), 80);
  assert.equal(score('f3.ts#XMLHttpRequest', 'xml'), 80);
  assert.equal(score('f3.ts#XMLHttpRequest', 'http'), 80);
  assert.equal(
    score('f4.ts#xComputeDiffY', 'computediff'),
    50,
    'a term spanning two camel segments is only a substring',
  );
  assert.equal(score('f0.ts#computeDiff', 'pute'), 50);
  assert.equal(score('f0.ts#computeDiff', 'cpdf'), 30);
  assert.equal(
    score('f5.ts#İcomputeDiff', 'diff'),
    80,
    'Unicode lowercase length changes retain the old segment behavior',
  );
});

test('fuzzy result reuse is O(1) and bounded instead of retaining arbitrary queries', () => {
  const base: MapEntry[] = Array.from({ length: 100 }, (_, i) => ({
    id: `f${i}.ts#symbol${i}`,
    name: `symbol${i}`,
    kind: 'FunctionDeclaration',
    file: `f${i}.ts`,
    line: 1,
    searchText: `symbol${i}`,
  }));
  let reads = 0;
  const numeric = /^(0|[1-9]\d*)$/;
  const entries = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && numeric.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const index = syntheticIndex(process.cwd(), entries);
  locate(index, 'symbol0');
  reads = 0;
  locate(index, 'symbol0');
  assert.equal(
    reads,
    0,
    'an identical bounded query reuses its scored entries',
  );

  for (let i = 1; i <= 32; i++) locate(index, `missing-query-${i}`);
  reads = 0;
  locate(index, 'symbol0');
  assert.equal(
    reads,
    entries.length,
    'the 33rd distinct query evicts the oldest cached result',
  );
});

test('a prepared exact-name lookup skips fuzzy locate candidates', () => {
  const entries: MapEntry[] = [
    {
      id: 'a.ts#alpha',
      name: 'alpha',
      kind: 'FunctionDeclaration',
      file: 'a.ts',
      line: 1,
      searchText: 'function alpha() {}',
      fanIn: 1,
    },
    {
      id: 'c.ts#alpha',
      name: 'alpha',
      kind: 'FunctionDeclaration',
      file: 'c.ts',
      line: 1,
      searchText: 'function alpha() {}',
      fanIn: 2,
    },
    {
      id: 'b.ts#alphaHelper',
      name: 'alphaHelper',
      kind: 'FunctionDeclaration',
      file: 'b.ts',
      line: 1,
      searchText: 'function alphaHelper() {}',
      fanIn: 99,
    },
  ];
  const index = syntheticIndex(process.cwd(), entries);
  prepareLookup(index);
  assert.deepEqual(
    locate(index, 'alpha').map((hit) => hit.id),
    ['c.ts#alpha', 'a.ts#alpha'],
  );
  assert.equal(
    readMany(index, ['alpha'])[0].status,
    'ambiguous',
    'duplicate exact names remain unresolved',
  );
});

test('one-shot exact batch resolves in one index pass without retaining lookup tables', () => {
  const root = repo({});
  const chunks: string[] = [];
  const baseEntries: MapEntry[] = [];
  let offset = 0;
  for (let i = 0; i < 5_000; i++) {
    const source = `line ${i}\n`;
    chunks.push(source);
    baseEntries.push({
      id: `large.txt#s${i}`,
      name: `s${i}`,
      kind: 'line',
      file: 'large.txt',
      line: i + 1,
      endLine: i + 1,
      charStart: offset,
      charEnd: offset + source.length,
      searchText: `line ${i}`,
    });
    offset += source.length;
  }
  const text = chunks.join('');
  writeFileSync(join(root, 'large.txt'), text);
  let visits = 0;
  const numeric = /^(0|[1-9]\d*)$/;
  const entries = new Proxy(baseEntries, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        return function* (): IterableIterator<MapEntry> {
          for (const entry of target) {
            visits++;
            yield entry;
          }
        };
      }
      if (typeof property === 'string' && numeric.test(property)) visits++;
      return Reflect.get(target, property, receiver);
    },
  });
  const index = syntheticIndex(root, entries, { 'large.txt': token(text) });
  const refs = Array.from({ length: 64 }, (_, i) => `large.txt#s${i * 70}`);
  assert.equal(getPreparedLookup(index), undefined);
  const results = readMany(index, refs);
  assert.ok(visits >= entries.length, 'the one file bucket is scanned once');
  assert.ok(
    visits <= entries.length + 2 * Math.ceil(Math.log2(entries.length)) + 2,
    `batch range lookup read ${visits} entries`,
  );
  assert.equal(
    results.every((result) => result.status === 'exact'),
    true,
  );
  assert.equal(
    getPreparedLookup(index),
    undefined,
    'one-shot batches do not retain a full lookup table',
  );
});

test('exact path-scoped read and fuzzy locate inspect only that v13 file range', () => {
  const root = repo({});
  const files = 1_024;
  const perFile = 8;
  const targetFile = 'f0512.ts';
  const targetBase = 512 * perFile;
  let targetText = '';
  let targetOffset = 0;
  const base: MapEntry[] = [];
  for (let f = 0; f < files; f++) {
    const file = `f${String(f).padStart(4, '0')}.ts`;
    for (let j = 0; j < perFile; j++) {
      const n = f * perFile + j;
      const raw = `symbol${n}\n`;
      const entry: MapEntry = {
        id: `${file}#symbol${n}`,
        name: `symbol${n}`,
        kind: 'FunctionDeclaration',
        file,
        line: j + 1,
        endLine: j + 1,
        searchText: `symbol${n}`,
      };
      if (file === targetFile) {
        entry.charStart = targetOffset;
        entry.charEnd = targetOffset + raw.length;
        targetOffset += raw.length;
        targetText += raw;
      }
      base.push(entry);
    }
  }
  writeFileSync(join(root, targetFile), targetText);
  let indexedReads = 0;
  const numeric = /^(0|[1-9]\d*)$/;
  const entries = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && numeric.test(property)) {
        indexedReads++;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const index = syntheticIndex(root, entries, {
    [targetFile]: token(targetText),
  });
  assert.deepEqual(exactFileEntryRange(index, targetFile), {
    start: targetBase,
    end: targetBase + perFile,
  });
  indexedReads = 0;
  const result = read(index, `${targetFile}#symbol${targetBase + perFile - 1}`);
  assert.equal(result.status, 'exact');
  assert.equal(result.raw, `symbol${targetBase + perFile - 1}\n`);
  assert.ok(
    indexedReads <= 3 * Math.ceil(Math.log2(base.length)) + perFile,
    `path read touched ${indexedReads} entries`,
  );

  indexedReads = 0;
  const hits = locate(index, `${targetFile}#symbl${targetBase + perFile - 1}`);
  assert.equal(hits[0]?.id, `${targetFile}#symbol${targetBase + perFile - 1}`);
  assert.equal(
    hits.every((hit) => hit.file === targetFile),
    true,
  );
  assert.ok(
    indexedReads <= 3 * Math.ceil(Math.log2(base.length)) + perFile,
    `path locate touched ${indexedReads} entries`,
  );
});

test('line-only batch resolves sibling boundaries and preserves exact slices', () => {
  const root = repo({});
  const text = Array.from({ length: 5_000 }, (_, i) => `line ${i}\n`).join('');
  writeFileSync(join(root, 'large.txt'), text);
  const entries: MapEntry[] = Array.from({ length: 5_000 }, (_, i) => ({
    id: `large.txt#s${i}`,
    name: `s${i}`,
    kind: 'line',
    file: 'large.txt',
    line: i + 1,
    searchText: `line ${i}`,
  }));
  const index = syntheticIndex(root, entries, { 'large.txt': token(text) });
  const refs = Array.from({ length: 64 }, (_, i) => `large.txt#s${i * 70}`);
  const results = readMany(index, refs);
  assert.equal(results.length, refs.length);
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].status, 'exact');
    assert.equal(results[i].raw, `line ${i * 70}\n`);
  }
  const aimed = read(index, 'large.txt#s420', { snippet: 'line 420' });
  assert.equal(
    aimed.aim?.status,
    'hit',
    'line-only snippet aim exercises its sibling-bounded range',
  );
  assert.equal(aimed.aim?.matches[0]?.line, 421);

  writeFileSync(join(root, 'large.txt'), `header\n${text}`);
  const relocated = readMany(index, ['large.txt#s4999'])[0];
  assert.equal(relocated.status, 'relocated');
  assert.equal(relocated.line, 5001);
  assert.equal(
    relocated.raw,
    'line 4999\n',
    'changed content token rebuilds the cached line index',
  );
});

test('a final line-only symbol reaches EOF instead of stopping at an arbitrary window', () => {
  const tail = 'CLEAN_LINE_ONLY_TAIL_SENTINEL';
  const text = [
    'legacy symbol',
    ...Array.from({ length: 160 }, (_, i) => `body line ${i}`),
    tail,
    '',
  ].join('\n');
  const root = repo({ 'legacy.txt': text });
  const entry: MapEntry = {
    id: 'legacy.txt#symbol',
    name: 'symbol',
    kind: 'line',
    file: 'legacy.txt',
    line: 1,
    searchText: 'legacy symbol',
  };
  const index = syntheticIndex(root, [entry], {
    'legacy.txt': token(text),
  });

  const result = read(index, entry.id, { snippet: tail });
  assert.equal(result.status, 'exact');
  assert.match(result.raw ?? '', new RegExp(`${tail}\\n$`));
  assert.equal(result.aim?.status, 'hit');
  assert.equal(result.aim?.matches[0]?.line, 162);
  assert.match(result.note ?? '', /next sibling or EOF/);
});

test('ordered line-only boundaries are logarithmic; legacy unsorted indexes stay correct', () => {
  const base: MapEntry[] = Array.from({ length: 8_192 }, (_, i) => ({
    id: `f${String(Math.floor(i / 8)).padStart(4, '0')}.txt#s${i}`,
    name: `s${i}`,
    kind: 'line',
    file: `f${String(Math.floor(i / 8)).padStart(4, '0')}.txt`,
    line: (i % 8) + 1,
    searchText: `line ${i}`,
  }));
  let indexedReads = 0;
  const entries = new Proxy(base, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^(0|[1-9]\d*)$/.test(property)) {
        indexedReads++;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const index = syntheticIndex(process.cwd(), entries);
  assert.equal(nextSiblingLine(index, base[4_096]), 2);
  assert.ok(
    indexedReads <= 2 * Math.ceil(Math.log2(base.length)) + 2,
    `binary lookup read ${indexedReads} entries`,
  );
  const firstReads = indexedReads;
  assert.equal(nextSiblingLine(index, base[4_096]), 2);
  assert.equal(
    indexedReads,
    firstReads,
    "a repeated line-only read reuses only that entry's memoized boundary",
  );

  const legacyEntries: MapEntry[] = [
    {
      id: 'a.ts#one',
      name: 'one',
      kind: 'line',
      file: 'a.ts',
      line: 1,
      searchText: 'one',
    },
    {
      id: 'b.ts#one',
      name: 'one',
      kind: 'line',
      file: 'b.ts',
      line: 1,
      searchText: 'one',
    },
    {
      id: 'a.ts#three',
      name: 'three',
      kind: 'line',
      file: 'a.ts',
      line: 3,
      searchText: 'three',
    },
    {
      id: 'a.ts#two',
      name: 'two',
      kind: 'line',
      file: 'a.ts',
      line: 2,
      searchText: 'two',
    },
  ];
  const legacy = syntheticIndex(process.cwd(), legacyEntries);
  legacy.meta.version = INDEX_VERSION - 1;
  assert.equal(nextSiblingLine(legacy, legacyEntries[0]), 2);
  assert.equal(nextSiblingLine(legacy, legacyEntries[3]), 3);
});

test('cold fuzzy resolution reuses the located entry instead of scanning a third time', () => {
  const count = 5_000;
  const root = repo({});
  const targetFile = `f${count - 1}.ts`;
  const source = `export function symbol${count - 1}(): number { return ${count - 1}; }\n`;
  writeFileSync(join(root, targetFile), source);
  const base: MapEntry[] = Array.from({ length: count }, (_, i) => ({
    id: `f${i}.ts#symbol${i}`,
    name: `symbol${i}`,
    kind: 'FunctionDeclaration',
    file: `f${i}.ts`,
    line: 1,
    endLine: 1,
    charStart: 0,
    charEnd: source.length,
    searchText: `export function symbol${i}`,
  }));
  let visits = 0;
  const numeric = /^(0|[1-9]\d*)$/;
  const entries = new Proxy(base, {
    get(target, property, receiver) {
      if (property === Symbol.iterator) {
        return function* (): IterableIterator<MapEntry> {
          for (const entry of target) {
            visits++;
            yield entry;
          }
        };
      }
      if (typeof property === 'string' && numeric.test(property)) visits++;
      return Reflect.get(target, property, receiver);
    },
  });
  const index = syntheticIndex(root, entries, { [targetFile]: token(source) });
  const result = read(index, `symbl${count - 1}`);
  assert.equal(result.status, 'exact');
  assert.match(result.raw ?? '', /function symbol4999/);
  assert.equal(
    visits,
    count * 2,
    'one exact pass + one fuzzy pass; no id-to-entry third scan',
  );
});

test('fan-in resolves a 12k wildcard barrel chain iteratively for many names', () => {
  const depth = 12_000;
  const files = Array.from({ length: depth }, (_, i) => `f${i}.ts`);
  files.push('use.ts');
  const imports = new Map<
    string,
    { source: string; name: string; reexport?: boolean }[]
  >();
  for (let i = 0; i < depth - 1; i++) {
    imports.set(`f${i}.ts`, [
      { source: `./f${i + 1}`, name: '*', reexport: true },
    ]);
  }
  imports.set(
    'use.ts',
    Array.from({ length: 200 }, (_, i) => ({
      source: './f0',
      name: `symbol${i}`,
    })),
  );
  const fanIn = computeFanIn(files, imports);
  for (let i = 0; i < 200; i++) {
    assert.equal(fanIn.get(`f${depth - 1}.ts::symbol${i}`), 1);
  }
});

test(
  'fan-in batches names through mixed named/wildcard barrels',
  { timeout: 1500 },
  () => {
    const depth = 1_000;
    const files = Array.from({ length: depth }, (_, i) => `f${i}.ts`);
    files.push('use.ts');
    const imports = new Map<
      string,
      { source: string; name: string; reexport?: boolean }[]
    >();
    for (let i = 0; i < depth - 1; i++) {
      imports.set(`f${i}.ts`, [
        // The named route wins only for its own name. Every other name should flow
        // through the wildcard without re-walking the whole chain.
        { source: `./missing${i}`, name: `special${i}`, reexport: true },
        { source: `./f${i + 1}`, name: '*', reexport: true },
      ]);
    }
    imports.set('use.ts', [
      ...Array.from({ length: depth - 1 }, (_, i) => ({
        source: './f0',
        name: `special${i}`,
      })),
      ...Array.from({ length: 200 }, (_, i) => ({
        source: './f0',
        name: `ordinary${i}`,
      })),
    ]);

    const fanIn = computeFanIn(files, imports);
    for (let i = 0; i < depth - 1; i++) {
      assert.equal(fanIn.get(`f${i}.ts::special${i}`), 1);
    }
    for (let i = 0; i < 200; i++) {
      assert.equal(fanIn.get(`f${depth - 1}.ts::ordinary${i}`), 1);
    }
  },
);

test('batched fan-in preserves re-export order and mixed-cycle semantics', () => {
  const files = [
    'cycle-a.ts',
    'cycle-b.ts',
    'early.ts',
    'late.ts',
    'tail.ts',
    'target.ts',
    'use-cycle.ts',
    'use-early.ts',
    'use-late.ts',
  ];
  const imports = new Map<
    string,
    { source: string; name: string; reexport?: boolean }[]
  >([
    [
      'early.ts',
      [
        { source: './target', name: 'x', reexport: true },
        { source: './tail', name: '*', reexport: true },
      ],
    ],
    [
      'late.ts',
      [
        { source: './tail', name: '*', reexport: true },
        { source: './target', name: 'x', reexport: true },
      ],
    ],
    [
      'cycle-a.ts',
      [
        { source: './target', name: 'x', reexport: true },
        { source: './cycle-b', name: '*', reexport: true },
      ],
    ],
    ['cycle-b.ts', [{ source: './cycle-a', name: '*', reexport: true }]],
    ['use-early.ts', [{ source: './early', name: 'x' }]],
    ['use-late.ts', [{ source: './late', name: 'x' }]],
    [
      'use-cycle.ts',
      [
        { source: './cycle-a', name: 'x' },
        { source: './cycle-a', name: 'y' },
      ],
    ],
  ]);

  const fanIn = computeFanIn(files, imports);
  assert.equal(
    fanIn.get('target.ts::x'),
    2,
    'an exact route before wildcard wins',
  );
  assert.equal(
    fanIn.get('tail.ts::x'),
    1,
    'a wildcard before the exact route wins',
  );
  assert.equal(
    fanIn.get('cycle-a.ts::y'),
    1,
    'mixed wildcard cycles retain their canonical terminal',
  );
});

test('fan-in promotes singleton consumer buckets only for distinct importers', () => {
  const files = [
    'barrel-b.ts',
    'barrel-c.ts',
    'target.ts',
    'use-b1.ts',
    'use-b2.ts',
    'use-c.ts',
    'use-direct.ts',
  ];
  const imports = new Map<
    string,
    { source: string; name: string; reexport?: boolean }[]
  >([
    ['barrel-b.ts', [{ source: './target', name: 'x', reexport: true }]],
    ['barrel-c.ts', [{ source: './target', name: 'x', reexport: true }]],
    ['use-direct.ts', [{ source: './target', name: 'x' }]],
    [
      'use-b1.ts',
      [
        { source: './barrel-b', name: 'x' },
        { source: './barrel-b', name: 'x' },
      ],
    ],
    ['use-b2.ts', [{ source: './barrel-b', name: 'x' }]],
    ['use-c.ts', [{ source: './barrel-c', name: 'x' }]],
  ]);

  const fanIn = computeFanIn(files, imports);
  assert.equal(fanIn.get('target.ts::x'), 4);
});

test('fan-in promotes singleton routes without changing first-export order', () => {
  const files = [
    'barrel.ts',
    'tail.ts',
    'target-a.ts',
    'target-b.ts',
    'use.ts',
  ];
  const imports = new Map<
    string,
    { source: string; name: string; reexport?: boolean }[]
  >([
    [
      'barrel.ts',
      [
        { source: './target-a', name: 'x', reexport: true },
        { source: './target-b', name: 'x', reexport: true },
        { source: './target-b', name: 'y', reexport: true },
        { source: './tail', name: '*', reexport: true },
      ],
    ],
    [
      'use.ts',
      [
        { source: './barrel', name: 'x' },
        { source: './barrel', name: 'y' },
        { source: './barrel', name: 'z' },
      ],
    ],
  ]);

  const fanIn = computeFanIn(files, imports);
  assert.equal(fanIn.get('target-a.ts::x'), 1);
  assert.equal(fanIn.get('target-b.ts::x'), undefined);
  assert.equal(fanIn.get('target-b.ts::y'), 1);
  assert.equal(fanIn.get('tail.ts::z'), 1);
});

test('fan-in relative fast path preserves nested and normalized imports', () => {
  const files = ['src/nested/value.ts', 'src/target.ts', 'src/use.ts'];
  const imports = new Map<
    string,
    { source: string; name: string; reexport?: boolean }[]
  >([
    [
      'src/use.ts',
      [
        { source: './nested/value', name: 'value' },
        { source: './nested/../target', name: 'target' },
      ],
    ],
  ]);

  const fanIn = computeFanIn(files, imports);
  assert.equal(fanIn.get('src/nested/value.ts::value'), 1);
  assert.equal(fanIn.get('src/target.ts::target'), 1);
});

test('incremental no-op returns the prior snapshot and a deleted empty file invalidates it', async () => {
  const root = repo({
    'src/a.ts': 'export function a() { return 1 }\n',
    'src/empty.ts': '// intentionally no symbols\n',
  });
  const first = await buildIndex({ root });
  const noOp = await buildIndex({ root, previous: first.index });
  assert.equal(noOp.unchanged, true);
  assert.equal(noOp.fanInReused, true);
  assert.equal(
    noOp.index,
    first.index,
    'no-op does not clone/re-sort/recompute an identical index',
  );

  unlinkSync(join(root, 'src/empty.ts'));
  const afterDelete = await buildIndex({ root, previous: first.index });
  assert.equal(afterDelete.unchanged, false);
  assert.equal(
    afterDelete.fanInReused,
    false,
    'a changed file set invalidates import-route reuse',
  );
  assert.equal(afterDelete.filesIndexed, 1);
  assert.equal(afterDelete.index.meta.fileCount, 1);
});

test('incremental fan-in skips body-only graphs but rejects import and definition-surface counterexamples', async () => {
  const root = repo({
    'target.ts': 'export function target() { return 1 }\n',
    'use.ts':
      "import { target, future } from './target';\nexport const used = target;\n",
    'worker.ts': 'export function worker() { return 1 }\n',
  });
  const first = await buildIndex({ root });
  assert.equal(first.fanInReused, false);
  assert.equal(
    first.index.entries.find((entry) => entry.id === 'target.ts#target')?.fanIn,
    1,
  );

  writeFileSync(
    join(root, 'worker.ts'),
    'export function worker() { return 123456 }\n',
  );
  const bodyOnly = await buildIndex({ root, previous: first.index });
  assert.equal(bodyOnly.fanInReused, true);
  assert.equal(
    bodyOnly.index.entries.find((entry) => entry.id === 'target.ts#target')
      ?.fanIn,
    1,
  );

  writeFileSync(
    join(root, 'target.ts'),
    'export function target() { return 1 }\nexport function future() { return 2 }\n',
  );
  const addedDefinition = await buildIndex({ root, previous: bodyOnly.index });
  assert.equal(
    addedDefinition.fanInReused,
    false,
    'an already-imported new definition needs the discarded fan-in key',
  );
  assert.equal(
    addedDefinition.index.entries.find(
      (entry) => entry.id === 'target.ts#future',
    )?.fanIn,
    1,
  );

  writeFileSync(
    join(root, 'worker.ts'),
    "import { target } from './target';\nexport function worker() { return target() }\n",
  );
  const changedImport = await buildIndex({
    root,
    previous: addedDefinition.index,
  });
  assert.equal(changedImport.fanInReused, false);
  assert.equal(
    changedImport.index.entries.find((entry) => entry.id === 'target.ts#target')
      ?.fanIn,
    2,
  );
});
