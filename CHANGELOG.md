# Changelog

This project follows [Semantic Versioning](https://semver.org/).

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
