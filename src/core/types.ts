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

export const INDEX_VERSION = 13;
/** Entries have been globally ordered by file, then line, since this format. */
export const ORDERED_ENTRIES_VERSION = 13;

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
   * UTF-16 code-unit offsets into the file text (NOT byte offsets) — present for
   * every symbol oxc extracts, including class methods. read() slices
   * `fileText.slice(charStart, charEnd)` for an exact extract. (Optional only so
   * a future line-only source could omit them.)
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
  /** Superclass name for a ClassDeclaration — lets the call graph resolve
   * inherited `this.m()` / `super.m()` up the (same-file) extends chain. */
  extends?: string;
  visibility?: string;
  static?: boolean;
  /** Exported as the module's `default` — fan-in credits `default` imports of it. */
  default?: boolean;
  /**
   * Cross-module call-site count — a structural ranking tiebreaker (not
   * interpretation). Computed natively in fan-in.ts: distinct files that import
   * this symbol (named/default imports + re-exports, relative specifiers).
   */
  fanIn?: number;
  /**
   * Occurrences of this name within its own file (AST identifier count, incl.
   * the declaration). `intraRefs <= 1` ⇒ used nowhere in its own file. Combined
   * with `fanIn`: exported + fanIn 0 + intraRefs>1 = dead *export* (code alive);
   * exported + fanIn 0 + intraRefs<=1 = dead *code* (removable).
   */
  intraRefs?: number;
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
    /** Portable root persisted relative to the index file. `root` remains the
     * resolved runtime path for consumers and older index compatibility. */
    rootRelativeToIndex?: string;
    entryCount: number;
    /** Parseable source files seen during the build. Enables an O(files) no-op
     * rebuild without mistaking a deleted symbol-less file for "unchanged". */
    fileCount?: number;
    /** Cached report counters so a true no-op rebuild never scans every symbol. */
    counts?: { defs: number; methods: number; privateDefs: number };
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
  fileImports: Record<
    string,
    { source: string; name: string; reexport?: boolean }[]
  >;
  entries: MapEntry[];
}

export interface FileStat {
  mtimeMs: number;
  size: number;
  /** Inode change time + inode number: catch a same-size edit whose mtime was
   * restored (e.g. a rename to an equal-length name + `utimes`). `ctimeMs` updates
   * on any write and can't be set back via utimes; `ino` changes on replace. */
  ctimeMs?: number;
  ino?: number;
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
  | 'anchor-lost' // file changed and the signature anchor is gone; re-index to refresh
  | 'not-found'; // nothing found

export interface ReadCandidate {
  line: number;
  preview: string;
}

export interface ReadAim {
  /** `unanchored`: the file changed and the symbol's range couldn't be re-confined,
   * so the snippet was NOT searched (a whole-file match could land in another symbol). */
  status: 'hit' | 'ambiguous' | 'not-in-symbol' | 'unanchored';
  matches: { line: number; charStart: number; charEnd: number }[];
}

interface ReadResultBase {
  id: string;
  file: string;
  /** 1-based start line actually returned (best-effort when relocated). */
  line: number;
  /**
   * Sub-symbol designator: present only when `read` was given a `snippet`. The
   * LLM designates a target line by quoting it; this resolves it to exact char
   * range(s) INSIDE the symbol. `ambiguous` = the snippet occurs more than once
   * in the symbol (another "classroom" in the same building — hold fire).
   */
  aim?: ReadAim;
}

interface ExactReadResult extends ReadResultBase {
  status: 'exact';
  /** 1-based end line actually returned. */
  endLine: number;
  /** The raw source. The evidence. */
  raw: string;
  /** Present for line-only slices whose end boundary is best-effort. */
  note?: string;
  candidates?: never;
}

interface RelocatedReadResult extends ReadResultBase {
  status: 'relocated';
  /** 1-based best-effort end line after re-anchoring. */
  endLine: number;
  raw: string;
  note: string;
  candidates?: never;
}

interface AmbiguousReadResult extends ReadResultBase {
  status: 'ambiguous';
  endLine?: never;
  raw: null;
  note: string;
  /** Candidate locations are mandatory when no single landing site is safe. */
  candidates: ReadCandidate[];
}

interface AnchorLostReadResult extends ReadResultBase {
  status: 'anchor-lost';
  endLine?: never;
  raw: null;
  note: string;
  candidates?: never;
}

interface NotFoundReadResult extends ReadResultBase {
  status: 'not-found';
  endLine?: never;
  raw: null;
  note: string;
  /** Unresolved-name responses historically serialize an empty candidate list. */
  candidates?: [];
}

export type ReadResult =
  | ExactReadResult
  | RelocatedReadResult
  | AmbiguousReadResult
  | AnchorLostReadResult
  | NotFoundReadResult;
