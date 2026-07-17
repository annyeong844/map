/**
 * Admission, serialization, LRU and idle ownership for warm LSP sessions.
 */
import type { LspBackendSpec } from './lsp-backend.ts';
import { LspSession } from './lsp-session.ts';
import type { Lang, ProjectSnapshot } from './project-snapshot.ts';
import {
  AdmissionQueue,
  type AdmissionStats,
  positiveIntegerEnv,
} from './runtime-control.ts';

const MINUTE_MS = 60_000;
const DEFAULT_SESSION_IDLE_MINUTES = 10;

interface LspSessionPoolOptions {
  maxResident?: number;
  maxActive?: number;
  idleMs?: number;
}

type SessionEntry = {
  session: LspSession;
  inUse: number;
  idleTimer: NodeJS.Timeout | null;
};

type SessionLease = {
  session: LspSession;
  release: () => void;
};

export class LspSessionPool {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly admission: AdmissionQueue;
  private readonly maxResident: number;
  private readonly idleMs: number;
  private readonly isStopping: () => boolean;

  constructor(isStopping: () => boolean, options: LspSessionPoolOptions = {}) {
    this.isStopping = isStopping;
    this.maxResident =
      options.maxResident ?? positiveIntegerEnv('CODE_ORACLE_MAX_SESSIONS', 2);
    this.admission = new AdmissionQueue(
      options.maxActive ??
        positiveIntegerEnv('CODE_ORACLE_MAX_ACTIVE_SESSIONS', this.maxResident),
    );
    this.idleMs =
      options.idleMs ??
      positiveIntegerEnv(
        'CODE_ORACLE_SESSION_IDLE_MS',
        DEFAULT_SESSION_IDLE_MINUTES * MINUTE_MS,
      );
  }

  stats(): AdmissionStats {
    return this.admission.stats();
  }

  private disposeSession(key: string, entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (this.sessions.get(key) === entry) this.sessions.delete(key);
    entry.session.dispose();
  }

  private armIdleTimer(key: string, entry: SessionEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (entry.inUse > 0 || this.sessions.get(key) !== entry) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.inUse === 0 && this.sessions.get(key) === entry) {
        this.disposeSession(key, entry);
      }
    }, this.idleMs);
    entry.idleTimer.unref();
  }

  private trimSessions(): void {
    for (const [key, entry] of this.sessions) {
      if (this.sessions.size <= this.maxResident) return;
      if (entry.inUse === 0) this.disposeSession(key, entry);
    }
  }

  async acquire(
    root: string,
    lang: Lang,
    spec: LspBackendSpec,
    snapshot: ProjectSnapshot,
  ): Promise<SessionLease> {
    const key = `${lang}::${root}`;
    const previous = this.sessionQueues.get(key) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      unlock = resolveGate;
    });
    const queued = previous.then(() => gate);
    this.sessionQueues.set(key, queued);
    await previous;

    const finishQueue = (): void => {
      unlock();
      if (this.sessionQueues.get(key) === queued) {
        this.sessionQueues.delete(key);
      }
    };

    let releaseAdmission: (() => void) | null = null;
    const releasePermit = (): void => {
      const release = releaseAdmission;
      releaseAdmission = null;
      release?.();
    };
    let entry: SessionEntry | undefined;
    try {
      if (this.isStopping()) {
        throw new Error('code-oracle is shutting down.');
      }
      releaseAdmission = await this.admission.acquire();
      if (this.isStopping()) {
        throw new Error('code-oracle is shutting down.');
      }
      entry = this.sessions.get(key);
      if (entry?.idleTimer) clearTimeout(entry.idleTimer);
      if (entry) entry.idleTimer = null;
      if (entry) {
        const candidate = entry;
        let reusable = false;
        try {
          reusable = await candidate.session.reconcileProject(snapshot);
        } catch {
          // A failed checker is poisoned and must not remain resident.
        }
        if (!reusable) {
          this.disposeSession(key, candidate);
          entry = undefined;
        }
      }
      if (this.isStopping()) {
        throw new Error('code-oracle is shutting down.');
      }
      if (!entry) {
        entry = {
          session: new LspSession(spec, root, snapshot, lang),
          inUse: 0,
          idleTimer: null,
        };
        this.sessions.set(key, entry);
      } else {
        this.sessions.delete(key);
        this.sessions.set(key, entry);
      }
      entry.inUse++;
      this.trimSessions();

      const acquired = entry;
      let released = false;
      return {
        session: acquired.session,
        release: () => {
          if (released) return;
          released = true;
          acquired.inUse--;
          if (this.sessions.get(key) === acquired) {
            this.armIdleTimer(key, acquired);
          }
          this.trimSessions();
          finishQueue();
          releasePermit();
        },
      };
    } catch (error) {
      finishQueue();
      releasePermit();
      throw error;
    }
  }

  dispose(error: Error): void {
    this.admission.cancelQueued(error);
    for (const [key, entry] of this.sessions) {
      this.disposeSession(key, entry);
    }
    this.sessions.clear();
    this.sessionQueues.clear();
  }
}
