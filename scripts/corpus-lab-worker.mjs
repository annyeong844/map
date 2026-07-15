#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');

function decodePayload(encoded) {
  if (!encoded) throw new Error('The corpus worker needs an encoded payload.');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

async function runtimeModules() {
  const requested = process.env.CODE_MAP_CORPUS_RUNTIME;
  const sourceAvailable = existsSync(
    join(repositoryRoot, 'src', 'core', 'build-index.ts'),
  );
  const useSource =
    requested === 'source' || (requested !== 'dist' && sourceAvailable);
  const [build, drift, reads] = useSource
    ? await Promise.all([
        import('../src/core/build-index.ts'),
        import('../src/core/index-drift.ts'),
        import('../src/core/read.ts'),
      ])
    : await Promise.all([
        import('../dist/core/build-index.js'),
        import('../dist/core/index-drift.js'),
        import('../dist/core/read.js'),
      ]);
  return {
    buildIndex: build.buildIndex,
    scanIndexDrift: drift.scanIndexDrift,
    readMany: reads.readMany,
    runtime: useSource ? 'source' : 'dist',
  };
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

async function fileState(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { exists: true, kind: 'non-file' };
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: await hashFile(path),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

function sampleIndexes(length, requested) {
  if (length === 0 || requested <= 0) return [];
  const count = Math.min(length, requested);
  if (count === 1) return [0];
  const indexes = new Set();
  for (let index = 0; index < count; index++) {
    indexes.add(Math.round((index * (length - 1)) / (count - 1)));
  }
  return [...indexes];
}

async function sourceFingerprint(root, modules) {
  const scan = await modules.scanIndexDrift(root, null, true);
  const metadata = createHash('sha256');
  for (const file of scan.files) {
    const stat = scan.stats.get(file);
    metadata.update(file);
    metadata.update('\0');
    metadata.update(
      stat
        ? `${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs ?? ''}\0${stat.ino ?? ''}`
        : 'missing',
    );
    metadata.update('\0');
  }

  const sampledFiles = sampleIndexes(scan.files.length, 16).map(
    (index) => scan.files[index],
  );
  const content = createHash('sha256');
  for (const file of sampledFiles) {
    content.update(file);
    content.update('\0');
    content.update(hashText(readFileSync(join(root, file))));
    content.update('\0');
  }
  return {
    fileCount: scan.files.length,
    metadataSha256: metadata.digest('hex'),
    sampledContentSha256: content.digest('hex'),
    sampledFiles: sampledFiles.length,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function memorySampler() {
  let samples = 0;
  let start;
  let end;
  const peak = {};
  const capture = () => {
    const current = memorySnapshot();
    if (samples === 0) start = current;
    end = current;
    for (const [key, value] of Object.entries(current)) {
      peak[key] = Math.max(peak[key] ?? 0, value);
    }
    samples++;
  };
  capture();
  const timer = setInterval(capture, 25);
  return {
    capture,
    finish() {
      clearInterval(timer);
      capture();
      return {
        samples,
        start,
        end,
        peak,
        resourceMaxRssKiB: process.resourceUsage().maxRSS,
      };
    },
  };
}

function timingAccumulator() {
  let iterations = 0;
  let totalMs = 0;
  let minMs = Infinity;
  let maxMs = 0;
  return {
    add(ms) {
      iterations++;
      totalMs += ms;
      minMs = Math.min(minMs, ms);
      maxMs = Math.max(maxMs, ms);
    },
    summary() {
      return {
        iterations,
        minMs: Number(minMs.toFixed(2)),
        averageMs: Number((totalMs / iterations).toFixed(2)),
        maxMs: Number(maxMs.toFixed(2)),
      };
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runRepository(payload, modules) {
  const root = resolve(payload.root);
  const indexPath = join(root, '.map-index.json');
  const beforeSources = await sourceFingerprint(root, modules);
  const beforeIndex = await fileState(indexPath);
  global.gc?.();
  const sampler = memorySampler();

  const coldStarted = performance.now();
  let report = await modules.buildIndex({ root, force: true });
  const coldMs = performance.now() - coldStarted;
  sampler.capture();
  assert(
    report.filesMissing.length === 0,
    `${report.filesMissing.length} source files disappeared during indexing.`,
  );

  const ids = new Set(report.index.entries.map((entry) => entry.id));
  assert(
    ids.size === report.index.entries.length,
    `Index contains ${report.index.entries.length - ids.size} duplicate ids.`,
  );
  global.gc?.();
  const retainedAfterCold = memorySnapshot();
  const sampledEntries = sampleIndexes(
    report.index.entries.length,
    payload.readSamples,
  ).map((index) => report.index.entries[index]);
  const readResults = modules.readMany(
    report.index,
    sampledEntries.map((entry) => entry.id),
  );
  const statusCounts = {};
  let rawBytes = 0;
  for (const result of readResults) {
    statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
    if (result.raw !== null) rawBytes += Buffer.byteLength(result.raw);
  }
  assert(
    readResults.every((result) => result.status === 'exact'),
    `Fresh exact reads returned ${JSON.stringify(statusCounts)}.`,
  );
  global.gc?.();
  const retainedAfterReads = memorySnapshot();

  const noOpTimings = timingAccumulator();
  let identityReused = true;
  for (let iteration = 0; iteration < payload.noOpIterations; iteration++) {
    const prior = report.index;
    const started = performance.now();
    report = await modules.buildIndex({ root, previous: prior });
    noOpTimings.add(performance.now() - started);
    identityReused &&= report.index === prior;
    assert(
      report.unchanged,
      `No-op iteration ${iteration + 1} rebuilt the index.`,
    );
    assert(
      report.changed === 0,
      `No-op iteration ${iteration + 1} reparsed files.`,
    );
    assert(
      report.reused === report.filesIndexed,
      `No-op iteration ${iteration + 1} did not reuse every source file.`,
    );
    sampler.capture();
  }
  assert(identityReused, 'A no-op build allocated a replacement index object.');

  const beforeFinalGc = memorySnapshot();
  global.gc?.();
  const retainedAfterNoOps = memorySnapshot();
  sampler.capture();
  const memory = sampler.finish();
  const afterSources = await sourceFingerprint(root, modules);
  const afterIndex = await fileState(indexPath);
  assert(
    sameJson(beforeSources, afterSources),
    'Source-tree fingerprint changed during the read-only run.',
  );
  assert(
    sameJson(beforeIndex, afterIndex),
    '.map-index.json changed during the in-memory run.',
  );

  return {
    status: 'passed',
    name: payload.name,
    runtime: modules.runtime,
    sourceFiles: report.filesIndexed,
    entries: report.index.entries.length,
    counts: {
      defs: report.defs,
      methods: report.methods,
      privateDefs: report.privateDefs,
    },
    cold: { ms: Number(coldMs.toFixed(2)) },
    noOp: {
      ...noOpTimings.summary(),
      identityReused,
    },
    reads: {
      sampled: readResults.length,
      statusCounts,
      rawBytes,
    },
    memory: {
      ...memory,
      checkpoints: {
        retainedAfterCold,
        retainedAfterReads,
        beforeFinalGc,
        retainedAfterNoOps,
      },
      noOpRetainedGrowth: {
        rss: retainedAfterNoOps.rss - retainedAfterReads.rss,
        heapUsed: retainedAfterNoOps.heapUsed - retainedAfterReads.heapUsed,
      },
    },
    safety: {
      passed: true,
      sourceFingerprint: beforeSources,
      mapIndexBefore: beforeIndex,
      mapIndexAfter: afterIndex,
    },
  };
}

async function runDifferential(payload, modules) {
  const [leftRoot, rightRoot] = payload.roots.map((root) => resolve(root));
  const before = await Promise.all(
    [leftRoot, rightRoot].map(async (root) => ({
      source: await sourceFingerprint(root, modules),
      index: await fileState(join(root, '.map-index.json')),
    })),
  );
  global.gc?.();
  const sampler = memorySampler();

  let left = await modules.buildIndex({ root: leftRoot, force: true });
  const leftIds = new Set(left.index.entries.map((entry) => entry.id));
  const leftEntries = left.index.entries.length;
  left = null;
  global.gc?.();
  sampler.capture();

  const right = await modules.buildIndex({ root: rightRoot, force: true });
  let common = 0;
  let added = 0;
  const addedExamples = [];
  for (const entry of right.index.entries) {
    if (leftIds.delete(entry.id)) {
      common++;
    } else {
      added++;
      if (addedExamples.length < 20) addedExamples.push(entry.id);
    }
  }
  const removedExamples = [...leftIds].slice(0, 20);
  const removed = leftIds.size;
  const memory = sampler.finish();

  const after = await Promise.all(
    [leftRoot, rightRoot].map(async (root) => ({
      source: await sourceFingerprint(root, modules),
      index: await fileState(join(root, '.map-index.json')),
    })),
  );
  assert(
    sameJson(before, after),
    'A differential run changed a corpus snapshot.',
  );

  return {
    status: 'passed',
    names: payload.names,
    runtime: modules.runtime,
    leftEntries,
    rightEntries: right.index.entries.length,
    common,
    added,
    removed,
    addedExamples,
    removedExamples,
    memory,
    safety: { passed: true },
  };
}

try {
  const payload = decodePayload(process.argv[2]);
  const modules = await runtimeModules();
  const result =
    payload.kind === 'differential'
      ? await runDifferential(payload, modules)
      : await runRepository(payload, modules);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        stack: error?.stack,
      },
    })}\n`,
  );
  process.exitCode = 1;
}
