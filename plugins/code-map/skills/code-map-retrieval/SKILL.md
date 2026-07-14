---
name: code-map-retrieval
description: >
  Codex-first routing for the code-map `read` MCP tool in repositories with a
  `.map-index.json`. Use when inspecting a known function, class, method, or
  symbol, refreshing known references after edits, or choosing between `rg`
  discovery and exact symbol retrieval. Prevents redundant grep-then-read calls.
metadata:
  short-description: "Codex: rg discovers, code-map read retrieves exact symbols"
---

# Codex code-map retrieval

Use this skill when the repository has `.map-index.json` and the `code-map` MCP
server exposes its `read` tool. `read` returns the exact source bytes for a
symbol, not a summary or a search result. The model interprets those bytes.

## Repository selection

Pass `root` on every MCP read as the absolute directory of the repository whose
`.map-index.json` you are using. A global MCP process often starts from the user
home, so its process cwd is not evidence of the active workspace. The server
accepts native Linux paths, Windows paths, and equivalent Windows/WSL spellings
such as `C:\work\repo` and `/mnt/c/work/repo`.

## Routing rules

1. **The symbol is already known** — call the `read` tool directly with its id,
   bare name, or `path#name`. Do not run `rg`, `cat`, `sed`, or another shell
   read first.

2. **Several independent symbols are already known** — make one batched call:
   `read({ root: "/absolute/repo", refs: ["path#a", "path#b"] })`. Batch up to
   64 refs. Use sequential calls only when a later read depends on an earlier
   result.

3. **The location or symbol name is unknown** — use `rg` for discovery. If the
   search output answers the question, stop there; do not add a redundant
   `read` call.

4. **Discovery found a name but not the body** — make exactly one `read` call for
   that symbol. Never fetch the same target once through `rg` and again as a
   whole-file shell read.

5. **Refreshing a previous working set** — call
   `read({ root: "/absolute/repo", refs: [...], changedOnly: true })`. Use the
   returned `unchanged` ids as authoritative and re-read only the changed
   results.

## Precision and fallback

- A bare name resolves to one symbol. If it is ambiguous, use `path#name` or a
  precise symbol id; do not guess from candidates.
- `snippet` narrows to text inside one symbol. If `aim.status` is `ambiguous`,
  stop and narrow the snippet before targeting it.
- `read` is drift-resistant: after edits it re-anchors on the signature or
  reports `anchor-lost`; it must never silently return stale bytes.
- If the `code-map` MCP `read` tool is unavailable, do not pretend it was used.
  Use normal repo tools as a fallback and say that exact code-map retrieval was
  unavailable.
- If a read reports `No code-map index`, verify that `root` is the absolute
  directory containing `.map-index.json`. Do not search the home directory for
  child repositories or pin a global server to one repo.
- If a read reports `File not readable`, check the index root first. Current
  indexes persist a root relative to `.map-index.json` and rebase across
  Windows/WSL checkouts. Rebuild once with a current `map index` if the file was
  produced by an older version or lives at a custom output path.
- `read` is for retrieval, not search. Keep `rg` for unknown locations and
  `code-oracle` for type-aware callers, definitions, or implementations when
  that sibling MCP is available and the name is common or colliding.

Coordinates, not meaning: retrieve the smallest exact slice and judge it from
the current bytes.
