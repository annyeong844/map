# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## Unreleased

- Repair global GitHub installs by resetting npm's inherited global lifecycle config and bootstrapping only the build dependencies needed to produce `dist`.
- Preserve the complete `export` / `export default` wrapper in exact top-level symbol reads and force legacy indexes to rebuild.
- Keep distinct same-line Oracle references, close LSP document overlays after each query transaction, never cache checker zeroes, and stage positive answers until a later snapshot validates their epoch without an extra scan.
- Make exact `path#name` reads fail closed instead of promoting a different fuzzy symbol, and add slash-delimited lexical refs for class methods and nested Python declarations without breaking legacy canonical IDs.
- Preserve Python decorators in fresh and relocated exact slices, retain last-known-good symbols while a Python file is syntax-invalid, show selectable canonical IDs when lexical aliases collide, and make changed-file selection linear.
- Cut large Python rebuild latency with one exact reference walk plus memory-aware, size-balanced short-lived workers; keep small edits single-process and leave no resident worker behind.
- Add a pinned, prebuilt Ruff-based Python extractor with exact stdlib-backend parity, bounded in-process parallelism, a file-grouped compact wire format, five smoke-tested release artifacts (static musl on Linux), and an explicit stdlib fallback; preserve CRLF hashes and coordinates in both paths.
- Index AST-proven Python module assignments, annotations, and PEP 695 type aliases; support UTF-8 BOM and bare-CR source coordinates, report non-UTF-8 source as degraded instead of missing, resolve named imports from `.pyi` modules, and never substitute a later mixin for an unsupported primary base.
- Validate both Python extractor wire formats without `any` escapes, including safe coordinates, bounded anchors, compact tuple shapes, and non-negative reference counts.
- Preserve renamed re-export identities through mixed wildcard barrels; index namespace, side-effect, import-equals, export-assignment, overload, merged, destructured, abstract/private, anonymous-default, and arbitrary string-named TypeScript/JavaScript declarations without inventing dynamic computed names.

## 0.9.0-rc.1 — 2026-07-14

First public release candidate.

- Keep exact and path-scoped reads near O(1) warm / O(K) per file instead of scanning every symbol.
- Add bounded warm lookups, allocation-light fuzzy matching, incremental fan-in reuse, and logarithmic line boundaries.
- Support TypeScript, JavaScript, and Python across Windows, Linux, macOS, and WSL path spellings.
- Add `map setup codex|claude|gemini`, `map --version`, and a single-source runtime version contract.
- Bridge matching UNC roots on WSL-hosted MCPs, keep UNC/native Git corpora identical across hosts, and add an opt-in compact model-facing read format.
- Treat tracked-but-deleted working-tree paths as absent instead of retriggering automatic indexing forever.
- Tolerate sub-microsecond Windows/WSL timestamp rounding while retaining ctime/inode edit guards.
- Add fresh-tarball CLI/MCP smoke tests, three-OS CI, CodeQL, package safety checks, and npm provenance publishing.
- Update the optional source-checkout `code-oracle` sibling for the current extensionless `tsgo` launcher.

The npm package intentionally contains core code-map only. `code-oracle` remains an optional, separately installed sibling during the release-candidate cycle.
