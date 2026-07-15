import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ByteLru, type ByteLruStats } from './runtime-control.ts';

const CACHE_ENTRY_OVERHEAD_BYTES = 64;
const NUMBER_STORAGE_BYTES = 8;
const LINE_FEED_BYTE = 10;
const HASH_HEX_LENGTH = 16;

type Cache = {
  schema: number;
  epoch: string;
  entries: Record<string, unknown>;
};
type CacheDelta = {
  schema: number;
  epoch: string;
  key: string;
  value: unknown;
};
type CacheResident = { bytes: number; entryBytes: Map<string, number> };
type DirtyCache = { reset: boolean; keys: Set<string> };
type BoundedCacheText = {
  text: string | null;
  bytes: number;
  oversized: boolean;
};

export interface ResultCacheOptions {
  directory: string;
  schema: number;
  maxBytes: number;
  idleMs: number;
  persistDelayMs: number;
}

export interface CachedOracleResult extends Record<string, unknown> {
  tool: string;
  symbol: {
    file: string;
    name: string | null;
    position: { line: number; character: number };
  };
  root: string;
  results: Record<string, unknown>[];
  count: number;
  cached: boolean;
  coverage: {
    kind: string;
    scope: string;
    residuals: string[];
  };
  note?: string;
}

export type ResultCacheLookup =
  | { hit: false }
  | { hit: true; value: CachedOracleResult };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validate the stable cache envelope while deliberately allowing additive
 * fields inside the result, locations, symbol, coverage, and future evidence. */
export function isCachedOracleResult(
  value: unknown,
): value is CachedOracleResult {
  if (!isObjectRecord(value)) return false;
  const symbol = value.symbol;
  const coverage = value.coverage;
  if (!isObjectRecord(symbol) || !isObjectRecord(coverage)) return false;
  const position = symbol.position;
  if (!isObjectRecord(position)) return false;
  if (
    typeof value.tool !== 'string' ||
    value.tool.length === 0 ||
    typeof symbol.file !== 'string' ||
    (symbol.name !== null && typeof symbol.name !== 'string') ||
    !isNonNegativeSafeInteger(position.line) ||
    !isNonNegativeSafeInteger(position.character) ||
    typeof value.root !== 'string' ||
    !Array.isArray(value.results) ||
    !value.results.every(isObjectRecord) ||
    !isNonNegativeSafeInteger(value.count) ||
    value.count !== value.results.length ||
    typeof value.cached !== 'boolean' ||
    typeof coverage.kind !== 'string' ||
    typeof coverage.scope !== 'string' ||
    !Array.isArray(coverage.residuals) ||
    !coverage.residuals.every((item) => typeof item === 'string') ||
    (value.note !== undefined && typeof value.note !== 'string')
  ) {
    return false;
  }
  return true;
}

/** Persistent query answers with byte-weighted resident LRU. Disk entries are
 * reloadable; oversize snapshots/logs are compacted instead of being read into
 * unbounded memory. */
export class ResultCacheStore {
  private readonly options: ResultCacheOptions;
  private readonly residents = new WeakMap<Cache, CacheResident>();
  private readonly caches: ByteLru<string, Cache>;
  private readonly dirty = new Map<string, DirtyCache>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(options: ResultCacheOptions) {
    this.options = options;
    this.caches = new ByteLru(
      options.maxBytes,
      options.idleMs,
      (root, cache) => {
        this.persistEvicted(root, cache);
      },
    );
  }

  private digest(root: string): string {
    return createHash('sha256')
      .update(root)
      .digest('hex')
      .slice(0, HASH_HEX_LENGTH);
  }

  private cacheFile(root: string): string {
    return join(this.options.directory, `${this.digest(root)}.json`);
  }

  private cacheLogFile(root: string): string {
    return join(this.options.directory, `${this.digest(root)}.jsonl`);
  }

  private emptyCache(): Cache {
    const cache = {
      schema: this.options.schema,
      epoch: '',
      entries: {},
    };
    this.residents.set(cache, {
      bytes: CACHE_ENTRY_OVERHEAD_BYTES,
      entryBytes: new Map(),
    });
    return cache;
  }

  private isCache(value: unknown): value is Cache {
    return (
      isObjectRecord(value) &&
      value.schema === this.options.schema &&
      typeof value.epoch === 'string' &&
      isObjectRecord(value.entries)
    );
  }

  private isCacheDelta(value: unknown): value is CacheDelta {
    return (
      isObjectRecord(value) &&
      value.schema === this.options.schema &&
      typeof value.epoch === 'string' &&
      typeof value.key === 'string' &&
      'value' in value
    );
  }

  private valueBytes(key: string, value: unknown): number {
    try {
      const serialized = JSON.stringify(value);
      return (
        Buffer.byteLength(key) +
        (serialized ? Buffer.byteLength(serialized) : 0) +
        CACHE_ENTRY_OVERHEAD_BYTES
      );
    } catch {
      return this.options.maxBytes + CACHE_ENTRY_OVERHEAD_BYTES;
    }
  }

  private residentFor(cache: Cache): CacheResident {
    let resident = this.residents.get(cache);
    if (resident) return resident;
    resident = {
      bytes:
        CACHE_ENTRY_OVERHEAD_BYTES +
        Buffer.byteLength(cache.epoch) +
        NUMBER_STORAGE_BYTES,
      entryBytes: new Map(),
    };
    for (const [key, value] of Object.entries(cache.entries)) {
      const bytes = this.valueBytes(key, value);
      resident.entryBytes.set(key, bytes);
      resident.bytes += bytes;
    }
    this.residents.set(cache, resident);
    return resident;
  }

  private reset(cache: Cache, epoch: string): void {
    cache.epoch = epoch;
    cache.entries = {};
    this.residents.set(cache, {
      bytes:
        CACHE_ENTRY_OVERHEAD_BYTES +
        Buffer.byteLength(epoch) +
        NUMBER_STORAGE_BYTES,
      entryBytes: new Map(),
    });
  }

  private setEntry(cache: Cache, key: string, value: unknown): boolean {
    const resident = this.residentFor(cache);
    const previousBytes = resident.entryBytes.get(key) ?? 0;
    const bytes = this.valueBytes(key, value);
    cache.entries[key] = value;
    resident.entryBytes.delete(key);
    resident.entryBytes.set(key, bytes);
    resident.bytes += bytes - previousBytes;
    let trimmed = false;
    while (
      resident.bytes > this.options.maxBytes &&
      resident.entryBytes.size > 0
    ) {
      const oldest = resident.entryBytes.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.deleteEntry(cache, oldest);
      trimmed = true;
    }
    return trimmed;
  }

  private deleteEntry(cache: Cache, key: string): boolean {
    if (!Object.hasOwn(cache.entries, key)) return false;
    const resident = this.residentFor(cache);
    const removedBytes = resident.entryBytes.get(key) ?? 0;
    resident.entryBytes.delete(key);
    delete cache.entries[key];
    resident.bytes -= removedBytes;
    return true;
  }

  private pruneInvalidEntries(cache: Cache): boolean {
    let pruned = false;
    for (const [key, value] of Object.entries(cache.entries)) {
      if (isCachedOracleResult(value)) continue;
      this.deleteEntry(cache, key);
      pruned = true;
    }
    return pruned;
  }

  private touchEntry(cache: Cache, key: string): void {
    const resident = this.residentFor(cache);
    const bytes = resident.entryBytes.get(key);
    if (bytes === undefined) return;
    resident.entryBytes.delete(key);
    resident.entryBytes.set(key, bytes);
  }

  private cacheWeight(root: string, cache: Cache): number {
    return (
      Buffer.byteLength(root) +
      this.residentFor(cache).bytes +
      CACHE_ENTRY_OVERHEAD_BYTES
    );
  }

  private readBounded(path: string, maxBytes: number): BoundedCacheText {
    try {
      const info = statSync(path);
      if (info.size > maxBytes) {
        return { text: null, bytes: 0, oversized: true };
      }
      const text = readFileSync(path, 'utf8');
      return { text, bytes: Buffer.byteLength(text), oversized: false };
    } catch {
      return { text: null, bytes: 0, oversized: false };
    }
  }

  private load(root: string): Cache {
    let cache = this.caches.get(root);
    if (cache) return cache;
    let reset = false;
    const snapshot = this.readBounded(
      this.cacheFile(root),
      this.options.maxBytes,
    );
    if (snapshot.oversized) reset = true;
    if (snapshot.text !== null) {
      try {
        const parsed: unknown = JSON.parse(snapshot.text);
        if (this.isCache(parsed)) {
          cache = parsed;
          if (this.pruneInvalidEntries(cache)) reset = true;
        } else {
          cache = this.emptyCache();
          reset = true;
        }
      } catch {
        cache = this.emptyCache();
        reset = true;
      }
    } else {
      cache = this.emptyCache();
    }

    const resident = this.residentFor(cache);
    for (const [key] of Object.entries(cache.entries)) {
      if (resident.bytes <= this.options.maxBytes) break;
      const removedBytes = resident.entryBytes.get(key);
      if (removedBytes === undefined) continue;
      resident.entryBytes.delete(key);
      delete cache.entries[key];
      resident.bytes -= removedBytes;
      reset = true;
    }

    const remainingLogBytes = Math.max(
      0,
      this.options.maxBytes - snapshot.bytes,
    );
    const logFile = this.readBounded(
      this.cacheLogFile(root),
      remainingLogBytes,
    );
    if (logFile.oversized) reset = true;
    if (logFile.text !== null) {
      let start = 0;
      while (start < logFile.text.length) {
        let end = logFile.text.indexOf('\n', start);
        if (end === -1) end = logFile.text.length;
        const line = logFile.text.slice(start, end).trim();
        start = end + 1;
        if (!line) continue;
        try {
          const delta: unknown = JSON.parse(line);
          if (
            this.isCacheDelta(delta) &&
            delta.epoch === cache.epoch &&
            typeof delta.key === 'string'
          ) {
            if (!isCachedOracleResult(delta.value)) {
              reset = true;
              continue;
            }
            if (this.setEntry(cache, delta.key, delta.value)) reset = true;
          }
        } catch {
          /* an interrupted final append is safe to ignore */
        }
      }
    }
    if (reset) this.schedulePersist(root, '', true);
    this.caches.set(root, cache, this.cacheWeight(root, cache));
    return cache;
  }

  private persist(
    root: string,
    dirty: DirtyCache,
    cache = this.caches.peek(root),
  ): void {
    if (!cache) return;
    try {
      if (this.pruneInvalidEntries(cache)) {
        dirty.reset = true;
        dirty.keys.clear();
      }
      mkdirSync(this.options.directory, { recursive: true });
      if (dirty.reset) {
        writeFileSync(this.cacheFile(root), JSON.stringify(cache));
        try {
          unlinkSync(this.cacheLogFile(root));
        } catch {
          /* no prior log */
        }
        return;
      }
      const records: string[] = [];
      for (const key of dirty.keys) {
        const value = cache.entries[key];
        if (isCachedOracleResult(value)) {
          records.push(
            JSON.stringify({
              schema: this.options.schema,
              epoch: cache.epoch,
              key,
              value,
            } satisfies CacheDelta),
          );
        }
      }
      if (records.length) {
        appendFileSync(this.cacheLogFile(root), `${records.join('\n')}\n`);
      }
    } catch {
      /* best effort */
    }
  }

  private persistEvicted(root: string, cache: Cache): void {
    const dirty = this.dirty.get(root);
    if (!dirty) return;
    this.persist(root, dirty, cache);
    this.dirty.delete(root);
  }

  private schedulePersist(root: string, key: string, reset: boolean): void {
    let dirty = this.dirty.get(root);
    if (!dirty) {
      dirty = { reset, keys: new Set() };
      this.dirty.set(root, dirty);
    } else if (reset) {
      dirty.reset = true;
      dirty.keys.clear();
    }
    if (!dirty.reset) dirty.keys.add(key);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.flush();
    }, this.options.persistDelayMs);
    this.persistTimer.unref();
  }

  lookup(root: string, epoch: string, key: string): ResultCacheLookup {
    const cache = this.load(root);
    if (cache.epoch !== epoch || !Object.hasOwn(cache.entries, key)) {
      return { hit: false };
    }
    const value = cache.entries[key];
    if (!isCachedOracleResult(value)) {
      this.deleteEntry(cache, key);
      this.schedulePersist(root, '', true);
      this.caches.set(root, cache, this.cacheWeight(root, cache));
      return { hit: false };
    }
    this.touchEntry(cache, key);
    return { hit: true, value };
  }

  invalidateWhere(
    root: string,
    epoch: string,
    predicate: (value: CachedOracleResult) => boolean,
  ): number {
    const cache = this.load(root);
    if (cache.epoch !== epoch) return 0;
    let invalidated = 0;
    for (const [key, value] of Object.entries(cache.entries)) {
      if (!isCachedOracleResult(value) || !predicate(value)) continue;
      if (this.deleteEntry(cache, key)) invalidated++;
    }
    if (invalidated === 0) return 0;
    // Delta records are append-only, so persist a bounded replacement snapshot
    // instead of letting an older on-disk zero answer reappear after restart.
    this.schedulePersist(root, '', true);
    this.caches.set(root, cache, this.cacheWeight(root, cache));
    return invalidated;
  }

  store(root: string, epoch: string, key: string, value: unknown): void {
    if (!isCachedOracleResult(value)) return;
    const cache = this.load(root);
    const reset = cache.epoch !== epoch;
    if (reset) this.reset(cache, epoch);
    const trimmed = this.setEntry(cache, key, value);
    this.schedulePersist(root, key, reset || trimmed);
    this.caches.set(root, cache, this.cacheWeight(root, cache));
  }

  flush(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    for (const [root, dirty] of this.dirty) this.persist(root, dirty);
    this.dirty.clear();
  }

  dispose(): void {
    this.flush();
    this.caches.clear();
  }

  stats(): ByteLruStats {
    return this.caches.stats();
  }
}

type SourceIndex = {
  token: string;
  text: string;
  starts: number[];
  readError: string | null;
};

export type SourceLineResult = { preview: string; readError: string | null };

export class SourceLineCache {
  private readonly cache: ByteLru<string, SourceIndex>;
  private readonly previewLength: number;

  constructor(maxBytes: number, idleMs: number, previewLength: number) {
    this.previewLength = previewLength;
    this.cache = new ByteLru(maxBytes, idleMs);
  }

  private indexBytes(file: string, index: SourceIndex): number {
    return (
      Buffer.byteLength(file) +
      Buffer.byteLength(index.token) +
      Buffer.byteLength(index.text) +
      Buffer.byteLength(index.readError ?? '') +
      index.starts.length * NUMBER_STORAGE_BYTES +
      CACHE_ENTRY_OVERHEAD_BYTES
    );
  }

  lineResult(file: string, line0: number, token: string): SourceLineResult {
    let cached = this.cache.get(file);
    if (!cached || cached.token !== token) {
      let text = '';
      let readError: string | null = null;
      try {
        text = readFileSync(file, 'utf8');
      } catch (error) {
        readError = error instanceof Error ? error.message : String(error);
      }
      const starts = [0];
      for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) === LINE_FEED_BYTE) starts.push(index + 1);
      }
      cached = { token, text, starts, readError };
      this.cache.set(file, cached, this.indexBytes(file, cached));
    }
    const start = cached.starts[line0];
    if (start === undefined) {
      return { preview: '', readError: cached.readError };
    }
    const end = cached.starts[line0 + 1] ?? cached.text.length;
    return {
      preview: cached.text
        .slice(start, end)
        .trim()
        .slice(0, this.previewLength),
      readError: cached.readError,
    };
  }

  line(file: string, line0: number, token: string): string {
    return this.lineResult(file, line0, token).preview;
  }

  clear(): void {
    this.cache.clear();
  }

  stats(): ByteLruStats {
    return this.cache.stats();
  }
}
