# Contributing

Use Node 24 or newer and Python 3 for the full test suite.

```bash
npm ci
npm run release:check
```

`release:check` runs strict type checking, 49 core tests, oxlint, version-contract and package-safety checks, builds the consumer-facing JavaScript, then installs the generated tarball into a clean temporary prefix and exercises both the CLI and stdio MCP server.

Please keep code-map coordinate-only: retrieval may store machine-checkable positions and freshness signals, but not semantic summaries. Search remains a non-goal; `grep` discovers unknown names and code-map reads known symbols.

Performance changes should include a correctness test and a relevant `npm run bench` comparison. Do not trade the common exact-read path for a faster miss path.
