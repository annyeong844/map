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
| **Drift-safe READ** (`read`) | **Strongest, verified.** After heavy churn, no re-index: **0 silently-wrong bytes**, 94.5% recovery (re-anchored by signature) vs naive line-caching at **100% silent**. Reproduced. | **kept** |
| **Drift-safe EDIT** (`read --snippet` / `aim`) | **Verified.** Quoted snippet → its *current* char range after churn: **0 silent mistargets**, 94.5% vs naive char-offset at **100% mistarget** — patch lands even as the file moved. | **kept** |
| **Caller precision** (`code-oracle`, separate) | **31% fewer files to read** for blast-radius (40–75% on common/colliding names); grep can't say *which* class's method, the type checker can. LSP-warmup cost → a separate sibling. | **kept (sibling)** |
| **Read — turns** (`read`) | **Win (K=30, CI clear of 0).** −25–30% agent *turns* at N=6, both models. | **kept** |
| **Read — single-read tokens** (`read`) | **Retracted.** The K=5 "−16–35% tokens" was noise; *single* read at K=30 ~0 (Opus −11%, worse). | corrected |
| **Read — `refs` batch tokens** (`read`) | **Win, wired & model-dependent.** Batch many known symbols in one call → **−30% logical / −26% cost / −72% turns vs grep on codex** (corrected metric incl. cache_read); ~−30% Sonnet; **a loss on Opus** (native read already lean). The cut tracks the symbols' *grep-noise*, not count. | **kept** |
| **Search / semantic / light call-graph** | Tie or lose to `grep` (search ties; embeddings rejected 3 ways; structural graph loses on recall). | removed |

So code-map is, honestly: **a guess-free coordinate layer that stays correct under
churn** — for *reading* (`read`, 0 silent) and *editing* (`aim`, 0 mistarget) — plus a
separate type-oracle that narrows a refactor's read-set. It is **not** a search tool
(grep ties it). On tokens it's conditional: *single* reads are ~0, but **`refs` batch
cuts −30% (logical & cost) on codex when wired** — because the real cost is *round-trips*
(context re-processing), not bytes, and batching collapses them. That win scales with how
round-trip-heavy/grep-noisy the agent's native read is (big on codex, a loss on Opus). Full
numbers, retractions, the round-trip law, and the adoption ladder:
**[code-map-bench](https://github.com/annyeong844/code-map-bench)** —
[RESULTS.md](https://github.com/annyeong844/code-map-bench/blob/main/RESULTS.md) (drift/edit/oracle)
+ [EFFICIENCY-CODEX.md](https://github.com/annyeong844/code-map-bench/blob/main/EFFICIENCY-CODEX.md) (batch/cross-model/adoption).

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

## Install

Requires Node ≥ 23.6 (runs TypeScript directly — no build step) and one **runtime**
dependency, `oxc-parser`. `ripgrep` is used by the indexer's file walk when present.
Dev-only: `typescript` + `@types/node` for `npm run typecheck`; `npm run lint` runs
oxlint via npx. Python needs `python3` on `PATH`.

Once published to npm:

```bash
npm install -g @annyeong844/code-map
```

Until the npm package is published, install directly from GitHub (requires access
to the repository):

```bash
npm install -g github:annyeong844/map
```

For local development from a checkout:

```bash
git clone https://github.com/annyeong844/map.git
cd map
npm install
npm link
```

All three paths expose two commands on `PATH`: `map` and `map-mcp`.

## Usage

```bash
# Index (writes ./.map-index.json; --root defaults to cwd). Incremental: reuses files
# whose bytes are unchanged (stat mtime+size+ctime/ino), re-parses only what changed.
map index --root ../target-repo

# Read — the one tool. Takes a symbol id or a bare/path-scoped name (resolved internally).
map read "alias-map.ts#buildAliasMap"
map read buildAliasMap                 # bare name (errors if ambiguous)
map read withRetry --snippet "req.copy()"   # sub-symbol char range

map stats
```

Add `--json` for machine output. **Search with your own `grep`/ripgrep** — that's not
code-map's job (it ties); feed the `file:line` or symbol name you find to `read`.

### As an MCP server

Build an index in the repo you want the assistant to inspect:

```bash
cd /path/to/target-repo
map index --root .
```

Then add the stdio server to your MCP client.

Codex:

```bash
codex mcp add code-map -- map-mcp
```

If your Codex client starts MCP servers outside the target repo, pin the index in
`~/.codex/config.toml` (or project `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.code-map]
command = "map-mcp"

[mcp_servers.code-map.env]
MAP_INDEX = "/path/to/target-repo/.map-index.json"
```

Claude:

```bash
claude mcp add code-map --scope user -- map-mcp
```

Generic MCP JSON:

```jsonc
{ "mcpServers": { "code-map": { "command": "map-mcp" } } }
```

Exposes **one tool — `read`** (raw drift-resistant slice; optional `snippet` for a
sub-symbol range). The server **auto-detects** the index (walks up for
`.map-index.json`) and **auto-reloads** when it changes (no client reconnect). It
routes and quotes; it never summarizes.

The MCP server also returns server-wide instructions during initialization so
agents are nudged to use `read` for exact symbol slices even when the user did
not explicitly say "use read". Tool choice is still model behavior, so the
benchmark harness verifies the route from event logs instead of trusting intent.

For Codex specifically, server instructions are not strong enough to guarantee
routing by themselves (measured: ~67% adoption, mixes in shell reads). **Two wirings
reach 100% reliable adoption** — pick one:

- **A skill (zero per-project setup).** Drop a `code-map` skill into `~/.codex/skills/`
  so it ships globally and Codex self-routes everywhere — no per-repo file. Measured:
  17% → **100%** adoption. Costs a one-time `cat SKILL.md` load round-trip per session
  (≈ one extra context re-process). Copyable skill:
  [`integrations/codex-skill/SKILL.md`](https://github.com/annyeong844/code-map-bench/blob/main/integrations/codex-skill/SKILL.md).

  ```bash
  mkdir -p ~/.codex/skills/code-map
  curl -sL https://raw.githubusercontent.com/annyeong844/code-map-bench/main/integrations/codex-skill/SKILL.md \
    -o ~/.codex/skills/code-map/SKILL.md
  ```

- **A project `AGENTS.md` line (zero load cost, per-repo).** Slightly leaner (no skill-load
  round-trip) but you add it per project. See `bench/codex-headless/AGENTS.code-map.md` for
  a copyable snippet.

Either says, in effect: *"read known symbols via code-map `read` (batch independent refs
in one call); use grep only to discover."* The win is **−30% tokens/cost on read-heavy
known-ref tasks** once routing is reliable.

### Benchmarking retrieval strategies

The repo includes a Codex headless benchmark harness for comparing native
`rg`/read workflows against code-map batched `read({ refs: [...] })` workflows:

```bash
codex login --device-auth
map-bench --run --passes 30 --auth chatgpt --strategies native,map-batch
```

See `bench/codex-headless/README.md` for the pass@30 setup, task format, and
usage metrics captured from `codex exec --json`. The harness defaults to saved
ChatGPT/OAuth Codex auth and removes `CODEX_API_KEY` / `OPENAI_API_KEY` from
child `codex exec` processes. Each pass also runs one no-op cache warm-up
resume turn before scored tasks. The main comparison table uses scored task
turns only and reports adjusted input as `input_tokens - cached_input_tokens`,
so repeated cached prompt prefix can be excluded as a diagnostic. It also reports
cache-aware `effective_input_tokens = uncached + cached * cached_input_weight`
for the practical "cache really applies" view. Scoring checks the route: native
rows fail if they use MCP, and map-batch rows fail if they do not complete a
batched code-map `read({ refs: [...] })` call.

Current Codex routing probes show the honest ladder:

| Routing mechanism | Codex behavior | Token/time expectation |
|---|---|---|
| No project hint | often pure `rg`/file reads | no reliable savings |
| MCP server instructions only | partial adoption; can mix `read` and shell | noisy, sometimes worse |
| Strong MCP routing rules | fewer shell reads, still not guaranteed | modest average gain, high variance |
| `AGENTS.md` project hint | reliable use of code-map for known refs | stable gains on read-heavy known-ref tasks |
| Literal one-call prompt | best possible batching | useful ceiling, not normal agent behavior |

This does **not** mean code-map saves tokens everywhere. It is strongest when
the agent already knows several independent symbol refs and can batch them in
one `read({ refs: [...] })` call. It is often a wash on one-symbol lookups, and
discovery-heavy or whole-file tasks may still be better served by `rg` plus a
small direct read. Use `bench/codex-headless/tasks.diverse.json` and the
`By Scenario` table in `summary.md` to keep those cases separate.

### Publishing checklist

For maintainers publishing the npm package:

```bash
npm test
npm run typecheck
npm run check:package
npm pack --dry-run
npm publish --access public
```

`npm publish` also runs `npm run check:package` through `prepublishOnly`.
The safety check inspects the exact dry-run package file list and fails if local
env/config paths (`.env`, `.codex`, `.audit`, `.bench`, `auth.json`,
`config.toml`, etc.) or likely token values are present.

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
*opposite* profile to code-map's "one dependency, no machinery". Honest bounds (measured
2026-06 on a real typed Python project, `ouroboros`): tsgo is solid; **`ty` (0.0.50)
resolves `definition` cross-file and accurately, but `references` is INTRA-FILE ONLY** — so
Python `callers`/`implementations` are a lower-bound intra-file screen, flagged
`incomplete: true` (verified: a function with 2 cross-file callers returned only its 1
intra-file caller). This is a maturity gap in ty's reference subsystem (type-checking and
project-wide find-references are different problems), not a speed issue — ty is fast (~6 s
warm). **For complete Python callers, use `grep`** (100 % recall — the name is in every
calling file); we deliberately do NOT add a Python references backend (jedi/pyright) — the
dependency cost isn't worth the marginal precision over grep, and it would break the
one-dep thesis. Use `ty` for Python `definition` (trustworthy); use `grep` for "who calls
this". When ty ships cross-file references, `callers` can switch to it (fast AND complete).
Truly dynamic dispatch (token-only DI, `Proxy`, `obj[k]()`) is invisible to any checker.
Its own `package.json` + tests (`cd code-oracle && npm test`).
