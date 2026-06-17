# code-map

**지도는 정밀하게 만들지 않는다. 착탄 지점만 정밀하게 만들고, 의미는 LLM이 raw를 보고 매번 새로 판정한다.**

A code map that stores **coordinates, never meaning**. It guides you to the exact
spot — a path, a line, a char range — and then hands back the raw source. What the
code *means* is never the map's claim; that interpretation is the consumer's job,
done fresh from the evidence every time.

---

## Why this shape

A map that tries to store *meaning* (intent prose, summaries, "what this function
does") has to defend that meaning against being wrong — so it grows producers,
adversarial verifiers, completeness gates, drift flags, regeneration pipelines.
Most of that machinery exists to guard one problem: *the stored interpretation
might be false.*

Decide not to store interpretation at all, and the machinery disappears. What is
left is only what a machine can verify:

- a **coordinate index** (`path` / `line` / `charStart`–`charEnd`)
- one **token per file** to tell whether those coordinates still hold
- a **search primitive** (`grep` + read-raw)

The only question left — *"is this coordinate correct?"* — has an answer. The
unanswerable question — *"is this description right?"* — is never asked. That is
why retrieval collapses to roughly `grep + grep + read_file`.

### The honest trade-offs

1. **Simplicity isn't free — it moves.** Build-time interpretation (write + verify
   docs) becomes query-time interpretation (the LLM reads raw each time). Good when
   code changes often; a stored cache wins when it's stable and widely read.
2. **Everything rests on routing precision.** If the coordinate narrows to *this
   function, this line*, the LLM reads a small slice and judges. If it's vague
   ("somewhere in this file"), the LLM burns context reading the whole file and the
   map added nothing. So all the effort goes where it's verifiable — the coordinate
   — and none goes where it isn't — the meaning.

---

## Where the coordinates come from

Coordinates come from two sources, and the map only ever **reads** the source tree:

1. **Lumin's symbol graph** (`build-symbol-graph.mjs`'s `.audit/symbols.json`) — the
   **export surface**. Every `defIndex` entry already carries `path`, `line`, and a
   `definitionId` encoding the **char-offset range** (e.g.
   `_lib/alias-map.mjs#FunctionDeclaration:1289-2609`), plus `fanInByIdentity` for
   ranking. Class methods come from `classMethodIndex` (line-only, bounded by their
   next sibling). Lumin is treated as read-only reference and is never modified.

2. **The map's own oxc pass** — the **module-private surface** Lumin omits (it indexes
   only exports, since that is all dead-export / fan-in analysis needs). For each
   TS/JS file the map parses it with `oxc-parser` and adds every top-level definition
   that isn't already exported (`visibility: "module-private"`, fan-in 0). oxc returns
   UTF-16 char offsets — the same convention — so these slice exactly like exports.
   This is why `locate` can route to an internal helper, not just the public API.

> Offsets are **UTF-16 char offsets**, not bytes. `read` slices the file as a string,
> so a multibyte-heavy file stays exact.

The transform throws away everything semantic and keeps only what's verifiable,
adding three derived fields per symbol:

- `searchText` — the declaration's first line, the **drift anchor**.
- a per-file content **token** — the `sourceVersionToken`.
- `fanIn` — call-site count (from `fanInByIdentity`), the ranking tiebreaker below.

---

## How `read` survives drift

```
1. file token matches index   →  exact char-offset slice          [exact]
2. file changed               →  re-anchor on searchText, re-slice [relocated]
3. anchor matches many sites  →  return the candidate locations    [ambiguous]
4. anchor is gone             →  grep the name, return matches      [grep-fallback]
```

Line numbers drift; a signature line rarely does. When offsets go stale, the anchor
re-finds the symbol and the result is flagged so the consumer verifies the boundary.
Nothing is silently trusted.

## How `locate` ranks

Matching is tiered — exact > case-insensitive exact > prefix > substring > fuzzy —
and **a better tier always wins** (an exact match outranks a fuzzy one regardless of
anything else). Ties *within* a tier break by **fan-in** (call-site count), so the
symbol the codebase actually depends on floats up — a canonical definition over a
vendored copy, for instance. Fan-in is a structural count, not interpretation, so it
sharpens routing without the map ever claiming what a symbol means. It influences
*ranking only*: `read` still refuses to guess between two genuinely distinct files,
returning fan-in-ordered candidates instead.

---

## Usage

Requires Node ≥ 23.6 (runs TypeScript directly — no build step) and one dependency,
`oxc-parser` (for the private-symbol pass). `ripgrep` is used when present, with a
pure-JS fallback otherwise.

### Index

```bash
# Reads <root>/.audit/symbols.json by default; writes ./.map-index.json
node src/cli/main.ts index --root /path/to/repo
node src/cli/main.ts index --root /path/to/repo --symbols /path/to/symbols.json --out .map-index.json
node src/cli/main.ts index --root /path/to/repo --force   # ignore prior index, rebuild all
```

**Incremental.** A rebuild reuses every file whose bytes (filesystem `mtime`+`size`)
*and* symbol-graph contribution (a per-file `srcHash`) are unchanged, re-reading and
re-parsing only what actually changed; a true no-op leaves the index untouched. The
change check is read-free (`stat`), so detection is cheaper than the work it skips.
On the reference repo this is roughly a full build ~16–23s → incremental ~6–7s (the
floor is fixed cost: loading/writing the index, statting every file, parsing the
symbol graph — all far cheaper on a native filesystem than over a Windows mount).

### Locate → Read → Grep

```bash
node src/cli/main.ts locate buildAliasMap --limit 3
node src/cli/main.ts locate handler --kind method --file routes

node src/cli/main.ts read "_lib/alias-map.mjs#buildAliasMap"   # id from locate
node src/cli/main.ts read buildAliasMap                        # bare name (errors if ambiguous)

node src/cli/main.ts grep "buildAliasMap(" --fixed --file alias-map
node src/cli/main.ts grep "export (async )?function \w+" --limit 20

node src/cli/main.ts stats
```

Add `--json` to any command for machine-readable output. Queries accept a bare name
(`buildIndex`), a path-scoped name (`alias-map#buildAliasMap`), or a path fragment
(`alias-map#`).

### As an MCP server

A model consumes the same three primitives over stdio (newline-delimited JSON-RPC,
zero deps):

```bash
MAP_INDEX=.map-index.json node src/mcp/server.ts
```

Exposes `locate`, `read`, `grep`. The server routes and quotes; it never summarizes.
It **auto-reloads** the index when the file changes (it stats the index before each
tool call), so a `map index` rebuild takes effect immediately — no client reconnect
needed. A long-lived server that only read the index at boot would otherwise serve a
stale snapshot until reconnected.

```jsonc
// settings example
{
  "mcpServers": {
    "code-map": {
      "command": "node",
      "args": ["/abs/path/map/src/mcp/server.ts"],
      "env": { "MAP_INDEX": "/abs/path/.map-index.json" }
    }
  }
}
```

---

## Architecture

```
src/
  core/            # retrieval library (only dep: oxc-parser)
    types.ts          # MapEntry / MapIndex — coordinates only, no meaning fields
    build-index.ts    # Lumin symbols.json (exports + methods) + oxc private pass → index
    extract-private.ts# oxc parse → module-private top-level defs Lumin omits
    locate.ts         # tiered ranked routing  ← the one thing that must be precise
    read.ts           # exact slice + token check + searchText re-anchoring
    grep.ts           # ripgrep wrapper, JS fallback
    store.ts          # load/save .map-index.json
  cli/main.ts      # CLI adapter
  mcp/server.ts    # MCP stdio adapter
test/map.test.ts   # exact-slice, relocation, grep-fallback, CRLF
```

```bash
node --test "test/*.test.ts"
```
