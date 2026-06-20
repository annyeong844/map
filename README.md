# code-map

**좌표만 정밀하게. 의미는 LLM이 raw를 보고 매번 새로 판정한다.**

A **drift-safe coordinate cache**: hand it a symbol's coordinate and `read` returns
that symbol's exact slice — re-anchoring on the signature line when the file has
changed, so a **stale coordinate never silently returns the wrong bytes** (measured: 0
silent at heavy churn scale; a naive line-cache is ~100 % wrong). It stores
**coordinates, never meaning** — the consumer judges the raw bytes fresh, every time.

code-map is deliberately small: **one tool, `read`.** Search with your normal `grep`;
reuse a symbol's coordinate across turns and `read` keeps it honest (and lands it in
fewer agent turns than grep-then-read).

---

## What this is — and what the measurements say it isn't

This started broad (locate, grep, graph, hotspots, semantic search) and was then
**benchmarked honestly against `grep` + a strong agent** (Sonnet/Opus, headless, on
real repos — `cline`, `django`, `requests` from SWE-bench). The measurements ate most
of it, and the surface was cut to match. The rigor — *keeping only what beat the
baseline* — is the point.

| Capability | Measured vs `grep` + strong agent | Verdict |
|---|---|---|
| **Search / routing** (`locate`) | **Tie.** On single "where is X" a strong model + ripgrep (100% recall) does as well; locate's name-match is narrower on concept queries. | removed |
| **Semantic embeddings** | **Worse.** CodeRankEmbed-137M & Qodo-1.5B returned plausible-but-wrong neighbours; *added* to a grep agent it **degraded** results (cannibalized the grep path) and the 1.5B model is CPU-infeasible. Rejected three independent ways. | not built |
| **Call graph / blast-radius** (`graph`) | **Lost on recall.** grep never misses a caller (the name is in every using file); the structural graph is blind to `obj.method()` dispatch + types. Type-precise callers are the *separate* `code-oracle` (LSP), not a light index. | removed |
| **Drift resistance** (`read`) | **Strongest, verified.** After heavy churn, no re-index: **0 silently-wrong bytes**, 94.5% correct recovery (re-anchored by signature) vs naive line-caching at **100% silent**. Reproduced. | **kept** |
| **Read — turns** (`read`) | **Win (K=30, CI clear of 0).** −25–30% agent *turns* at N=6, both models — `read(symbol)` vs grep-then-read. | **kept** |
| **Read — tokens** (`read`) | **Retracted.** The K=5 "−16–35% tokens" was noise; at K=30 it's ~0 (Opus −11%, worse). Token claim withdrawn. | corrected |

So code-map is, honestly: **a drift-safe coordinate cache** (0 silent / 94.5% recovery
after churn) that also cuts ~25–30% of agent *turns*. The division of labour is *grep
finds, `read` re-anchors + reads*. It does **not** save tokens at scale — that headline
didn't survive K=30. Full numbers + retractions: [code-map-bench](https://github.com/annyeong844/code-map-bench).

> **Full reproducible measurements + every negative result:**
> [**code-map-bench**](https://github.com/annyeong844/code-map-bench) — the harnesses,
> the raw numbers, and the honest log of each hypothesis the data killed.

---

## Why coordinates, never meaning

A map that stores *meaning* (summaries, "what this does") must defend that meaning
against being wrong — producers, verifiers, completeness gates, regeneration. Store no
interpretation and that machinery disappears; what's left is only what a machine can
verify: a **coordinate index** (`path` / `line` / `charStart`–`charEnd`) and **one
token per file** that says whether those coordinates still hold. The only question —
*"is this coordinate correct?"* — has an answer. *"Is this description right?"* is
never asked.

### Honest trade-offs

1. **Interpretation moves to query time.** The LLM reads raw each call instead of
   trusting stored prose. Good when code changes often; a cache wins when it's stable.
2. **`read` is the value, not search.** Measured: search ties `grep`. So code-map
   doesn't try to beat `grep` at finding — it makes the *read* small and drift-proof.
   The win scales with read-heaviness (more symbols to inspect → bigger saving); on a
   single lookup it's a wash, and that's fine.
3. **No embeddings — deliberate, and now *measured* as a non-goal.** Concept search
   ("where is auth handled" with no `auth` token) is what embeddings are for; tested,
   they didn't beat lexical retrieval and hurt a strong agent. Use `grep` + the model's
   own reasoning.
4. **fan-in is honest about scope.** It ranks `read`'s name→symbol resolution by
   cross-file references through *resolved* import edges; namespace imports, `export *`,
   and alias specifiers aren't attributed (blunter ties on barrel-heavy trees).

---

## Where the coordinates come from

The map parses the source tree itself — no external symbol graph. It only ever
**reads** the source.

1. **File enumeration.** In a git repo: `git ls-files --cached --others
   --exclude-standard` (so `.gitignore` is respected, vendored trees stay out). Outside
   git it walks and skips the usual generated dirs.
2. **Parsing.** Each TS/JS file → `oxc-parser`; every top-level declaration (exported
   **or** module-private) and class method is recorded with its exact **UTF-16
   char-offset range** — exactly what `read` slices by. **Python** (`.py`/`.pyi`) →
   a stdlib-`ast` backend (`src/py/extract.py`), auto-detected, emitting the same
   per-file primitives so build-index runs it through the identical pipeline (`python3`
   on `PATH`, override `CODE_MAP_PYTHON`; absent → Python skipped).

Per symbol it keeps only the verifiable: the coordinate, `searchText` (the
declaration's first line — the **drift anchor**), and a per-file content **token**.
`fanIn` (cross-module reference count) is computed natively from the import graph and
used only to break ties when a bare name resolves to more than one symbol.

---

## How `read` survives drift

`read(symbol)` resolves the name to one symbol (via the index), then:

```
1. file token matches index   →  exact char-offset slice          [exact]
2. file changed               →  re-anchor on searchText, re-slice [relocated]
3. anchor matches many sites  →  return the candidate locations    [ambiguous]
4. anchor is gone             →  say so; re-index to refresh        [anchor-lost]
```

Line numbers drift; a signature line rarely does. When offsets go stale the anchor
re-finds the symbol and the result is **flagged** so the consumer verifies the
boundary — nothing is silently trusted. (This is `read`'s edge over a blind
`Read(file, lineRange)`: a stale line range returns the wrong bytes; `read` re-anchors
or tells you it can't.) Pass `snippet` (text quoted from inside the symbol) to get its
exact char range *within* the symbol, never escaping into another symbol.

---

## Usage

Requires Node ≥ 23.6 (runs TypeScript directly — no build step) and one **runtime**
dependency, `oxc-parser`. `ripgrep` is used by the indexer's file walk when present.
Dev-only: `typescript` + `@types/node` for `npm run typecheck`; `npm run lint` runs
oxlint via npx. Python needs `python3` on `PATH`.

```bash
# Index (writes ./.map-index.json; --root defaults to cwd). Incremental: reuses files
# whose bytes are unchanged (stat mtime+size+ctime/ino), re-parses only what changed.
node src/cli/main.ts index --root ../target-repo

# Read — the one tool. Takes a symbol id or a bare/path-scoped name (resolved internally).
node src/cli/main.ts read "alias-map.ts#buildAliasMap"
node src/cli/main.ts read buildAliasMap                 # bare name (errors if ambiguous)
node src/cli/main.ts read withRetry --snippet "req.copy()"   # sub-symbol char range

node src/cli/main.ts stats
```

Add `--json` for machine output. **Search with your own `grep`/ripgrep** — that's not
code-map's job (it ties); feed the `file:line` or symbol name you find to `read`.

### As an MCP server

```bash
npm link                                          # exposes `map` + `map-mcp` on PATH
claude mcp add code-map --scope user -- map-mcp
```

```jsonc
{ "mcpServers": { "code-map": { "command": "map-mcp" } } }
```

Exposes **one tool — `read`** (raw drift-resistant slice; optional `snippet` for a
sub-symbol range). The server **auto-detects** the index (walks up for
`.map-index.json`) and **auto-reloads** when it changes (no client reconnect). It
routes and quotes; it never summarizes.

---

## Architecture

```
src/
  core/            # retrieval library (only runtime dep: oxc-parser)
    types.ts          # MapEntry / MapIndex — coordinates only, no meaning fields
    files.ts          # enumerate source files (git ls-files, else walk)
    extract-symbols.ts# oxc parse → top-level defs + methods + import edges
    fan-in.ts         # resolve relative imports → cross-file ref counts (ranking ties)
    build-index.ts    # walk + parse + coordinates + fan-in → index (TS via oxc, Python
                      #   via the ast backend; incremental, drift-aware)
    locate.ts         # internal name→symbol resolution for read (tiered, fan-in tie-break)
    read.ts           # exact slice + token check + searchText re-anchoring  ← the value
    store.ts          # load/save .map-index.json
  py/extract.py    # Python backend: stdlib `ast` → the same per-file primitives
  cli/main.ts      # CLI: index / read / stats
  mcp/server.ts    # MCP stdio adapter — the single `read` tool, auto-reload
test/              # extract, exact-slice, methods, relocation, anchor-lost, incremental,
                   #   fan-in, snippet-aim, path-traversal refusal, Python
```

```bash
node --test "test/*.test.ts"
```

> **What was removed (and why):** `locate`/`grep`/`graph`/`hotspots`/`dead` as exposed
> tools, and the call-graph / git-history / dead-export / embedding code behind them —
> all measured to tie or lose to `grep` + a strong agent, so they earned no place on
> the surface. `locate`'s ranking logic survives *inside* `read` (name → symbol). The
> benchmark harnesses + raw results + negative-result log live in a separate repo:
> [**code-map-bench**](https://github.com/annyeong844/code-map-bench).

### `code-oracle/` — the optional type oracle (a sibling, not the core)

`grep` and the (now-internal) structural pass cannot resolve `obj.method()` dispatch —
that needs types. `code-oracle/` is a **separate MCP** that answers *who calls this /
what implements this / where is this defined* at **type-checker grade** over a warm LSP
session (tsgo for TS/JS, `ty` for Python; picked by extension). It's the type-precise
answer to blast-radius that a light index can't give — and it's kept separate on
purpose: a heavy pinned preview dependency, seconds of warmup, a stateful session, the
*opposite* profile to code-map's "one dependency, no machinery". Honest bounds: tsgo is
solid; `ty` (early preview) resolves `definition` cross-file but `references` intra-file
(Python `callers` carry `incomplete: true`); truly dynamic dispatch (token-only DI,
`Proxy`, `obj[k]()`) is invisible to any checker. Its own `package.json` + tests
(`cd code-oracle && npm test`).
