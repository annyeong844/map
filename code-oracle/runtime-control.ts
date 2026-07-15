export function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface AdmissionStats {
  limit: number;
  active: number;
  queued: number;
  maxActive: number;
  maxQueued: number;
}

interface AdmissionWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

/** Fair active-work admission. Map preserves FIFO order while keeping queued
 * cancellation O(1) average instead of shifting an array. */
export class AdmissionQueue {
  readonly limit: number;
  private active = 0;
  private maxActive = 0;
  private maxQueued = 0;
  private nextWaiterId = 1;
  private readonly waiters = new Map<number, AdmissionWaiter>();

  constructor(limit: number) {
    this.limit = limit;
  }

  private abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new Error('Queued work was aborted.', { cause: signal.reason });
  }

  private grant(): () => void {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.waiters.size > 0) {
      const next = this.waiters.entries().next();
      if (next.done) return;
      const [id, waiter] = next.value;
      this.waiters.delete(id);
      if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener('abort', waiter.abort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(this.abortError(waiter.signal));
        continue;
      }
      waiter.resolve(this.grant());
    }
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(this.abortError(signal));
    if (this.active < this.limit) return Promise.resolve(this.grant());
    return new Promise((grantWaiter, reject) => {
      const id = this.nextWaiterId++;
      const waiter: AdmissionWaiter = {
        resolve: grantWaiter,
        reject,
        signal,
      };
      if (signal) {
        const abort = () => {
          if (!this.waiters.delete(id)) return;
          signal.removeEventListener('abort', abort);
          reject(this.abortError(signal));
        };
        waiter.abort = abort;
        signal.addEventListener('abort', abort, { once: true });
      }
      this.waiters.set(id, waiter);
      this.maxQueued = Math.max(this.maxQueued, this.waiters.size);
    });
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  cancelQueued(error: Error): void {
    for (const [id, waiter] of this.waiters) {
      this.waiters.delete(id);
      if (waiter.signal && waiter.abort) {
        waiter.signal.removeEventListener('abort', waiter.abort);
      }
      waiter.reject(error);
    }
  }

  stats(): AdmissionStats {
    return {
      limit: this.limit,
      active: this.active,
      queued: this.waiters.size,
      maxActive: this.maxActive,
      maxQueued: this.maxQueued,
    };
  }
}

type ByteLruEvictionReason = 'capacity' | 'idle' | 'delete';
interface ByteLruEntry<V> {
  value: V;
  bytes: number;
  lastUsedAt: number;
}
export interface ByteLruStats {
  maxBytes: number;
  residentBytes: number;
  maxObservedBytes: number;
  entries: number;
  evictions: number;
  idleEvictions: number;
}

/** Byte-weighted, insertion-ordered LRU. Map keeps touch/insert/delete O(1)
 * average; eviction work is charged once to the entry being released. */
export class ByteLru<K, V> {
  private readonly values = new Map<K, ByteLruEntry<V>>();
  readonly maxBytes: number;
  private readonly idleMs: number;
  private readonly onEvict?: (
    key: K,
    value: V,
    reason: ByteLruEvictionReason,
  ) => void;
  private residentBytes = 0;
  private maxObservedBytes = 0;
  private evictions = 0;
  private idleEvictions = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    maxBytes: number,
    idleMs: number,
    onEvict?: (key: K, value: V, reason: ByteLruEvictionReason) => void,
  ) {
    this.maxBytes = maxBytes;
    this.idleMs = idleMs;
    this.onEvict = onEvict;
  }

  private oldestKey(): K | undefined {
    return this.values.keys().next().value;
  }

  private remove(
    key: K,
    reason: ByteLruEvictionReason,
    notify: boolean,
  ): V | null {
    const entry = this.values.get(key);
    if (!entry) return null;
    this.values.delete(key);
    this.residentBytes -= entry.bytes;
    if (notify) {
      this.evictions++;
      if (reason === 'idle') this.idleEvictions++;
      this.onEvict?.(key, entry.value, reason);
    }
    return entry.value;
  }

  private scheduleIdleSweep(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.idleMs <= 0) return;
    const oldest = this.values.values().next().value as
      | ByteLruEntry<V>
      | undefined;
    if (!oldest) return;
    const delay = Math.max(1, this.idleMs - (Date.now() - oldest.lastUsedAt));
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.pruneExpired();
    }, delay);
    this.idleTimer.unref();
  }

  pruneExpired(now = Date.now()): void {
    if (this.idleMs <= 0) return;
    for (;;) {
      const key = this.oldestKey();
      if (key === undefined) break;
      const entry = this.values.get(key)!;
      if (now - entry.lastUsedAt < this.idleMs) break;
      this.remove(key, 'idle', true);
    }
    this.scheduleIdleSweep();
  }

  get(key: K): V | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (this.idleMs > 0 && Date.now() - entry.lastUsedAt >= this.idleMs) {
      this.remove(key, 'idle', true);
      this.scheduleIdleSweep();
      return undefined;
    }
    const touchedOldest = this.oldestKey() === key;
    this.values.delete(key);
    entry.lastUsedAt = Date.now();
    this.values.set(key, entry);
    if (touchedOldest) this.scheduleIdleSweep();
    return entry.value;
  }

  peek(key: K): V | undefined {
    return this.values.get(key)?.value;
  }

  set(key: K, value: V, bytes: number): void {
    const touchedOldest = this.oldestKey() === key;
    this.remove(key, 'delete', false);
    const normalizedBytes = Math.max(0, Math.ceil(bytes));
    this.values.set(key, {
      value,
      bytes: normalizedBytes,
      lastUsedAt: Date.now(),
    });
    this.residentBytes += normalizedBytes;
    while (this.residentBytes > this.maxBytes && this.values.size > 0) {
      const oldest = this.oldestKey();
      if (oldest === undefined) break;
      this.remove(oldest, 'capacity', true);
    }
    this.maxObservedBytes = Math.max(this.maxObservedBytes, this.residentBytes);
    if (touchedOldest || this.values.size === 1) this.scheduleIdleSweep();
  }

  delete(key: K, notify = false): boolean {
    const touchedOldest = this.oldestKey() === key;
    const removed = this.remove(key, 'delete', notify) !== null;
    if (removed && touchedOldest) this.scheduleIdleSweep();
    return removed;
  }

  clear(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.values.clear();
    this.residentBytes = 0;
  }

  stats(): ByteLruStats {
    this.pruneExpired();
    return {
      maxBytes: this.maxBytes,
      residentBytes: this.residentBytes,
      maxObservedBytes: this.maxObservedBytes,
      entries: this.values.size,
      evictions: this.evictions,
      idleEvictions: this.idleEvictions,
    };
  }
}
