/**
 * The map stores COORDINATES, never meaning.
 *
 * Every field here is mechanically verifiable against the source tree:
 * a path, a line, a char-offset range, a content hash, an anchor snippet.
 * There is deliberately no `summary`, `intent`, or `description` field —
 * that interpretation is the LLM's job, performed fresh from the raw bytes
 * that `read()` hands back. The map's only promise is: it routes you to the
 * exact spot. What the spot *means* is never the map's claim.
 */

/** One routed location — a "착탄 지점" (impact point). */
export interface MapEntry {
  /** Handle returned by locate(), accepted by read(). Unique within an index. */
  id: string;
  /** Symbol name as written in source. */
  name: string;
  /** AST node kind, verbatim from the parser (FunctionDeclaration, ClassMethod, ...). */
  kind: string;
  /** Source path, POSIX-normalized, relative to the index root. */
  file: string;
  /** 1-based start line. */
  line: number;
  /** 1-based end line, when derivable. */
  endLine?: number;
  /**
   * UTF-16 code-unit offsets into the file text (NOT byte offsets).
   * Present for top-level definitions; absent for class methods (line-only).
   * read() slices `fileText.slice(charStart, charEnd)` for an exact extract.
   */
  charStart?: number;
  charEnd?: number;
  /**
   * The declaration's first line, trimmed. This is the drift anchor: if the
   * file changed and offsets no longer hold, read() re-locates by searching
   * for this string. Line numbers drift; a signature line rarely does.
   */
  searchText: string;
  /** Class context for methods. */
  className?: string;
  visibility?: string;
  static?: boolean;
  /**
   * Cross-module call-site count — a structural ranking tiebreaker (not
   * interpretation). Reserved: currently always 0 until computed natively
   * (resolve imports, count cross-file references).
   */
  fanIn?: number;
  /** Synthesized id `file#kind:start-end`, for traceability. */
  definitionId?: string;
}

export interface MapIndex {
  meta: {
    tool: 'code-map';
    version: number;
    /** When this index was built (ISO). */
    generated: string;
    /** Build timestamp in ms — used for incremental reuse decisions. */
    builtAtMs: number;
    /** Absolute source root these coordinates resolve against. */
    root: string;
    entryCount: number;
  };
  /**
   * file -> short content hash. This is the sourceVersionToken: read() compares
   * the live file's hash against this to decide whether the stored coordinates
   * are still trustworthy, or whether it must fall back to the searchText anchor.
   */
  fileTokens: Record<string, string>;
  /**
   * Per-file change signature for incremental rebuilds: filesystem stat
   * (mtime + size) — a read-free change signal. A file's coordinates depend only
   * on its own bytes, so an unchanged stat means its entries can be reused as-is.
   */
  fileStats: Record<string, FileStat>;
  /**
   * Per-file import/re-export edges (`{ source, name }`), cached so incremental
   * rebuilds can recompute global fan-in without re-reading unchanged files.
   */
  fileImports: Record<string, { source: string; name: string }[]>;
  entries: MapEntry[];
}

export interface FileStat {
  mtimeMs: number;
  size: number;
}

export interface LocateHit {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine?: number;
  /** The signature/declaration line — context, not interpretation. */
  signature: string;
  /** Why this ranked where it did (exact | ci-exact | prefix | substring | fuzzy). */
  match: string;
  score: number;
  /** Call-site count; the within-tier tiebreaker. */
  fanIn: number;
}

export type ReadStatus =
  | 'exact' // file unchanged, sliced precisely from stored coordinates
  | 'relocated' // file changed, re-anchored via searchText (verify boundaries)
  | 'ambiguous' // searchText matched multiple sites; candidates returned
  | 'grep-fallback' // anchor lost; name-grep matches returned instead
  | 'not-found'; // nothing found

export interface ReadResult {
  status: ReadStatus;
  id: string;
  file: string;
  /** 1-based line range actually returned (best-effort when relocated). */
  line: number;
  endLine?: number;
  /** The raw source. The evidence. null only for grep-fallback/not-found. */
  raw: string | null;
  /** Human-facing caveat when the result is not a clean exact slice. */
  note?: string;
  /** Candidate locations for ambiguous / grep-fallback statuses. */
  candidates?: { line: number; preview: string }[];
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}
