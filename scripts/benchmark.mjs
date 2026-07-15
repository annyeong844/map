#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildIndex } from '../src/core/build-index.ts';
import { computeFanIn } from '../src/core/fan-in.ts';
import { locate } from '../src/core/locate.ts';
import { read, readMany } from '../src/core/read.ts';
import { prepareLookup } from '../src/core/store.ts';
import { INDEX_VERSION } from '../src/core/types.ts';
import { token } from '../src/core/util.ts';

const count = (name, fallback) => Math.max(1, Number(process.env[name] ?? fallback));
const BUILD_SYMBOLS = count('MAP_BENCH_BUILD_SYMBOLS', 2_000);
const LOCATE_ENTRIES = count('MAP_BENCH_LOCATE_ENTRIES', 50_000);
const LINE_ENTRIES = count('MAP_BENCH_LINE_ENTRIES', 20_000);
const BARREL_DEPTH = count('MAP_BENCH_BARREL_DEPTH', 10_000);
const FANIN_IMPORTERS = count('MAP_BENCH_FANIN_IMPORTERS', 50_000);
const SAMPLES = count('MAP_BENCH_SAMPLES', 5);
const LOOKUP_SCALES = String(process.env.MAP_BENCH_LOOKUP_SCALES ?? '7000,70000')
  .split(',')
  .map((value) => Math.max(1, Number(value.trim())))
  .filter(Number.isFinite);
const READ_SCALES = String(process.env.MAP_BENCH_READ_SCALES ?? '7000,70000')
  .split(',')
  .map((value) => Math.max(64, Number(value.trim())))
  .filter(Number.isFinite);

const results = {};
const measure = async (name, fn) => {
  const start = performance.now();
  const value = await fn();
  results[name] = { ms: +(performance.now() - start).toFixed(2), ...value };
  return results[name];
};

const measurePrepared = async (name, prepare, run) => {
  const samples = [];
  let value = {};
  for (let i = 0; i < SAMPLES; i++) {
    const state = await prepare();
    global.gc?.();
    const start = performance.now();
    value = await run(state);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  results[name] = {
    ms: +samples[Math.floor(samples.length / 2)].toFixed(2),
    samples: samples.length,
    minMs: +samples[0].toFixed(2),
    maxMs: +samples.at(-1).toFixed(2),
    ...value,
  };
  return results[name];
};

const buildRoot = mkdtempSync(join(tmpdir(), 'map-benchmark-build-'));
try {
  const buildSource = Array.from({ length: BUILD_SYMBOLS }, (_, i) => `export function f${i}(x: number) { return x + ${i}; }\n`).join('');
  writeFileSync(join(buildRoot, 'large.ts'), buildSource);
  let built;
  await measure('build.full', async () => {
    built = await buildIndex({ root: buildRoot, force: true });
    return { symbols: built.index.entries.length };
  });
  await measure('build.noop', async () => {
    const report = await buildIndex({ root: buildRoot, previous: built.index });
    return { reusedFiles: report.reused, unchanged: report.unchanged };
  });
  writeFileSync(join(buildRoot, 'large.ts'), `// body-only edit\n${buildSource}`);
  await measure('build.incremental.bodyOnly', async () => {
    const report = await buildIndex({ root: buildRoot, previous: built.index });
    return { changedFiles: report.changed, fanInReused: report.fanInReused };
  });
} finally {
  rmSync(buildRoot, { recursive: true, force: true });
}

const locateEntries = Array.from({ length: LOCATE_ENTRIES }, (_, i) => ({
  id: `src/f${String(i % 100).padStart(3, '0')}.ts#computeSymbol${i}`,
  name: `computeSymbol${i}`,
  kind: 'FunctionDeclaration',
  file: `src/f${String(i % 100).padStart(3, '0')}.ts`,
  line: Math.floor(i / 100) + 1,
  searchText: `function computeSymbol${i}`,
  fanIn: i % 17,
})).sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
const locateIndex = {
  meta: { tool: 'code-map', version: INDEX_VERSION, generated: '', builtAtMs: 0, root: process.cwd(), entryCount: LOCATE_ENTRIES },
  fileTokens: {}, fileStats: {}, fileImports: {}, entries: locateEntries,
};
await measure('locate.cold', async () => ({ hits: locate(locateIndex, 'compute', { limit: 20 }).length }));
await measure('locate.warm', async () => ({ hits: locate(locateIndex, 'compute', { limit: 20 }).length }));
const pathTarget = LOCATE_ENTRIES - 1;
const pathRemainder = pathTarget % 100;
const pathFile = `src/f${String(pathRemainder).padStart(3, '0')}.ts`;
await measurePrepared('locate.pathScoped.cold', async () => ({
  meta: { tool: 'code-map', version: INDEX_VERSION, generated: '', builtAtMs: 0, root: process.cwd(), entryCount: LOCATE_ENTRIES },
  fileTokens: {}, fileStats: {}, fileImports: {}, entries: locateEntries,
}), async (index) => ({ hits: locate(index, `${pathFile}#compteSymbol${pathTarget}`, { limit: 20 }).length }));

const pathReadRoot = mkdtempSync(join(tmpdir(), 'map-benchmark-path-read-'));
try {
  const pathLines = [];
  for (let i = pathRemainder; i < LOCATE_ENTRIES; i += 100) pathLines.push(`function computeSymbol${i}() {}\n`);
  const pathText = pathLines.join('');
  const pathDir = join(pathReadRoot, 'src');
  mkdirSync(pathDir, { recursive: true });
  writeFileSync(join(pathReadRoot, pathFile), pathText);
  const pathToken = token(pathText);
  await measurePrepared('read.pathExact.cold', async () => ({
    meta: { tool: 'code-map', version: INDEX_VERSION, generated: '', builtAtMs: 0, root: pathReadRoot, entryCount: LOCATE_ENTRIES },
    fileTokens: { [pathFile]: pathToken }, fileStats: {}, fileImports: {}, entries: locateEntries,
  }), async (index) => ({ status: read(index, `${pathFile}#computeSymbol${pathTarget}`).status }));
} finally {
  rmSync(pathReadRoot, { recursive: true, force: true });
}

const lookupMeasurements = [];
for (const size of LOOKUP_SCALES) {
  const entries = Array.from({ length: size }, (_, i) => ({
    id: `src/f${i % 500}.ts#symbol${i}`,
    name: `symbol${i}`,
    kind: 'FunctionDeclaration',
    file: `src/f${i % 500}.ts`,
    line: Math.floor(i / 500) + 1,
    searchText: `function symbol${i}`,
  }));
  const result = await measurePrepared(`lookup.prepare.${size}`, async () => ({
    meta: { tool: 'code-map', version: INDEX_VERSION, generated: '', builtAtMs: 0, root: process.cwd(), entryCount: size },
    fileTokens: {}, fileStats: {}, fileImports: {}, entries,
  }), async (index) => {
    const lookup = prepareLookup(index);
    return { ids: lookup.byId.size, names: lookup.byName.size };
  });
  lookupMeasurements.push({ size, ms: result.ms });
}
if (lookupMeasurements.length >= 2) {
  const first = lookupMeasurements[0];
  const last = lookupMeasurements.at(-1);
  results['lookup.prepare.scale'] = {
    from: first.size,
    to: last.size,
    nRatio: +(last.size / first.size).toFixed(2),
    timeRatio: +(last.ms / Math.max(first.ms, 0.01)).toFixed(2),
  };
}

const charReadMeasurements = [];
for (const size of READ_SCALES) {
  const root = mkdtempSync(join(tmpdir(), 'map-benchmark-char-read-'));
  try {
    const chunks = Array.from({ length: size }, (_, i) => `line ${i}\n`);
    const text = chunks.join('');
    writeFileSync(join(root, 'large.txt'), text);
    let offset = 0;
    const entries = chunks.map((source, i) => {
      const entry = {
        id: `large.txt#s${i}`,
        name: `s${i}`,
        kind: 'line',
        file: 'large.txt',
        line: i + 1,
        endLine: i + 1,
        charStart: offset,
        charEnd: offset + source.length,
        searchText: `line ${i}`,
      };
      offset += source.length;
      return entry;
    });
    const contentToken = token(text);
    const makeIndex = () => ({
      meta: { tool: 'code-map', version: INDEX_VERSION, generated: '', builtAtMs: 0, root, entryCount: entries.length },
      fileTokens: { 'large.txt': contentToken }, fileStats: {}, fileImports: {}, entries,
    });
    const refs = Array.from({ length: 64 }, (_, i) => `large.txt#s${Math.min(size - 1, Math.floor(((i + 1) * size) / 64) - 1)}`);
    const cold = await measurePrepared(`read.charBatch64.${size}.cold`, async () => makeIndex(), async (index) => ({ results: readMany(index, refs).length }));
    await measurePrepared(`read.charBatch64.${size}.warm`, async () => {
      const index = makeIndex();
      readMany(index, refs);
      return index;
    }, async (index) => ({ results: readMany(index, refs).length }));
    charReadMeasurements.push({ size, ms: cold.ms });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
if (charReadMeasurements.length >= 2) {
  const first = charReadMeasurements[0];
  const last = charReadMeasurements.at(-1);
  results['read.charBatch64.scale'] = {
    from: first.size,
    to: last.size,
    nRatio: +(last.size / first.size).toFixed(2),
    timeRatio: +(last.ms / Math.max(first.ms, 0.01)).toFixed(2),
  };
}

const readRoot = mkdtempSync(join(tmpdir(), 'map-benchmark-read-'));
try {
  const chunks = Array.from({ length: LINE_ENTRIES }, (_, i) => `line ${i}\n`);
  const text = chunks.join('');
  writeFileSync(join(readRoot, 'large.txt'), text);
  const lineEntries = Array.from({ length: LINE_ENTRIES }, (_, i) => ({
    id: `large.txt#s${i}`, name: `s${i}`, kind: 'line', file: 'large.txt', line: i + 1, searchText: `line ${i}`,
  }));
  const contentToken = token(text);
  const makeIndex = (entries) => ({
    meta: { tool: 'code-map', version: INDEX_VERSION, generated: '', builtAtMs: 0, root: readRoot, entryCount: entries.length },
    fileTokens: { 'large.txt': contentToken }, fileStats: {}, fileImports: {}, entries,
  });
  const refs = Array.from({ length: 64 }, (_, i) => `large.txt#s${Math.min(LINE_ENTRIES - 1, i * Math.floor(LINE_ENTRIES / 64))}`);
  await measurePrepared('read.lineBatch64.cold', async () => makeIndex(lineEntries), async (index) => ({ results: readMany(index, refs).length }));
  await measurePrepared('read.lineBatch64.warm', async () => {
    const index = makeIndex(lineEntries);
    readMany(index, refs);
    return index;
  }, async (index) => ({ results: readMany(index, refs).length }));
} finally {
  rmSync(readRoot, { recursive: true, force: true });
}

const barrelFiles = Array.from({ length: BARREL_DEPTH }, (_, i) => `f${i}.ts`);
barrelFiles.push('use.ts');
const barrelImports = new Map();
for (let i = 0; i < BARREL_DEPTH - 1; i++) barrelImports.set(`f${i}.ts`, [{ source: `./f${i + 1}`, name: '*', reexport: true }]);
barrelImports.set('use.ts', Array.from({ length: 200 }, (_, i) => ({ source: './f0', name: `symbol${i}` })));
await measure('fanIn.deepBarrel', async () => {
  const fanIn = computeFanIn(barrelFiles, barrelImports);
  return { depth: BARREL_DEPTH, names: 200, resolved: fanIn.size };
});

const mixedBarrelImports = new Map();
for (let i = 0; i < BARREL_DEPTH - 1; i++) {
  mixedBarrelImports.set(`f${i}.ts`, [
    { source: `./missing${i}`, name: `special${i}`, reexport: true },
    { source: `./f${i + 1}`, name: '*', reexport: true },
  ]);
}
mixedBarrelImports.set('use.ts', Array.from({ length: BARREL_DEPTH - 1 }, (_, i) => ({ source: './f0', name: `special${i}` })));
await measure('fanIn.mixedBarrel', async () => {
  const fanIn = computeFanIn(barrelFiles, mixedBarrelImports);
  return { depth: BARREL_DEPTH, names: BARREL_DEPTH - 1, resolved: fanIn.size };
});

const flatFiles = ['target.ts', ...Array.from({ length: FANIN_IMPORTERS }, (_, i) => `use${i}.ts`)];
const flatImports = new Map(flatFiles.slice(1).map((file) => [file, [{ source: './target', name: 'target' }]]));
await measure('fanIn.flat', async () => {
  const fanIn = computeFanIn(flatFiles, flatImports);
  return { importers: FANIN_IMPORTERS, counted: fanIn.get('target.ts::target') ?? 0 };
});

console.log(JSON.stringify(results, null, 2));
