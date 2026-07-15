---
name: code-map-retrieval
description: >
  Route known symbols through code-map read and use rg only for discovery. Use
  for exact symbol reads, batching, post-edit refreshes, or stale MCP diagnosis
  in indexed repositories.
metadata:
  short-description: 'rg discovers; code-map reads exact symbols'
---

# code-map retrieval

`read` returns the exact current source slice for a symbol. The model judges
those bytes.

## Route

- Known id, name, or `path#name`: call `read` directly. Do not grep or whole-file
  read it first.
- Several independent refs: make one `refs` call (maximum 64) with
  `responseFormat: "compact"`. Keep dependent reads sequential.
- Unknown name or location: discover it with `rg`. If that output is sufficient,
  stop; otherwise read the discovered symbol once.
- After edits: use `changedOnly: true` only for a working set already returned by
  this MCP session. Do not re-read ids listed under `unchanged`.

Always pass the absolute repository `root`; keep refs repository-relative.
Windows, `/mnt/c`, native Linux, and matching `\\wsl.localhost\<distro>` roots
are accepted. Use `json` only when a machine consumer needs stable fields.

Qualify ambiguous names. Use `snippet` only to narrow one symbol, and narrow it
again if the aim is ambiguous. Treat returned raw source—not index metadata—as
the evidence.

Indexes refresh lazily. For suspected stale code or configuration, retry with
`diagnostics: true`; start a new MCP session when `restartRequired` is true or a
never-read ref is incorrectly reported unchanged. If `read` is unavailable, use
normal repository tools and say so.

Use code-oracle, when available, for type-aware callers, definitions, and
implementations; honor its reported coverage limits.
