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
3. **No embeddings — routing is purely lexical + structural.** `locate` matches
   tokens and structure, not concepts. *"Where is auth handled?"* only routes if an
   `auth` / `authenticate` token actually appears in the code; a query whose words
   aren't in the source won't find it. Usually fine — an LLM consumer can phrase good
   lexical queries — but it is the **ceiling** of this approach, and a deliberate
   non-goal (concept search is what embeddings are for; this stays unmeasured).
4. **fan-in is honest about its scope.** It counts named/default references through
   *resolved* import edges; namespace imports (`import * as x`), `export *`, and
   re-aliased specifiers are **not** attributed. On barrel-heavy codebases the
   cross-module count — and so the ranking tiebreak — is therefore blunter.

---

## Where the coordinates come from

The map parses the source tree itself — no external symbol graph, no precomputed
artifact. It only ever **reads** the source.

1. **File enumeration.** In a git repo it asks git for tracked + untracked-not-ignored
   files (`git ls-files --cached --others --exclude-standard`), so `.gitignore` is
   respected for free and generated/vendored trees stay out. Outside git it walks and
   skips the usual generated directories.

2. **Parsing.** Each TS/JS file is parsed with `oxc-parser`. Every top-level
   declaration — exported **or** module-private — and every class method is recorded
   with its exact **char-offset range** (e.g. `lib/alias-map.mjs#FunctionDeclaration:...`).
   `locate` routes to an internal helper just as well as to the public API.

   **Python** (`.py` / `.pyi`) is parsed by a stdlib-`ast` backend (`src/py/extract.py`),
   auto-detected by extension. It emits the *same* per-file primitives the oxc path
   does, so build-index runs Python through the identical pipeline — stable ids,
   exact reads (char offsets + content token match), native fan-in, and the Level-1
   call graph (direct + from-import + `self.m()`). The only requirement is `python3`
   on `PATH` (override with `CODE_MAP_PYTHON`); absent, Python files are skipped. The
   optional type oracle on top is `ty` (see *code-oracle*), as tsgo is for TS.

> oxc returns **UTF-16 char offsets**, not bytes — exactly what `read` slices by
> (`fileText.slice(charStart, charEnd)`), so a multibyte-heavy file stays exact.

Per symbol the map keeps only what's mechanically verifiable, plus two derived fields:

- `searchText` — the declaration's first line, the **drift anchor**.
- a per-file content **token** — the `sourceVersionToken`.

(`fanIn` — a cross-module reference count for ranking ties — is computed natively
from the import graph; see *Ranking*.)

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
anything else). Ties *within* a tier break by **fan-in**, then closest-length name,
then path order.

Fan-in is computed natively: the map enumerates every named/default import and
re-export edge, resolves the **relative** ones against the indexed file set (no
filesystem access — path math + membership), and counts the distinct importing files
per `target::name`. So the symbol the codebase actually depends on floats up — a
canonical definition over a vendored copy. (Honest scope: namespace imports,
`export *`, and package/tsconfig-alias specifiers aren't attributed — resolving those
fully is a module resolver's job, out of scope. Fan-in only sharpens *ranking*; `read`
still refuses to guess between two genuinely distinct files, returning the ranked
candidates instead.)

---

## Usage

Requires Node ≥ 23.6 (runs TypeScript directly — no build step) and one **runtime**
dependency, `oxc-parser` (the parser). `ripgrep` is used when present, with a pure-JS
fallback. Dev-only: `typescript` + `@types/node` for `npm run typecheck` (strict, no
emit); `npm run lint` runs oxlint via npx (no dependency). Python needs `python3` on
`PATH` for its backend. CI (`.github/workflows/ci.yml`) runs typecheck + tests + lint.

### Index

```bash
# Writes ./.map-index.json; --root defaults to the current directory.
node src/cli/main.ts index --root .
node src/cli/main.ts index --root ../target-repo --out ../target-repo/.map-index.json
node src/cli/main.ts index --root ../target-repo --force   # ignore prior index, rebuild all
```

**Incremental.** A rebuild reuses every file whose bytes are unchanged (filesystem
`mtime`+`size`, a read-free check), re-reading and re-parsing only what actually
changed; a true no-op leaves the index untouched. Detection (`stat`) is cheaper than
the work it skips. On a ~700-file repo over a Windows mount: full build ~5s, no-op
incremental ~2s (the floor is fixed cost — statting every file, writing the index —
and is far cheaper on a native filesystem).

### Locate → Read → Grep

```bash
node src/cli/main.ts locate buildAliasMap --limit 3
node src/cli/main.ts locate handler --kind method --file routes
node src/cli/main.ts locate compute the diff                   # multi-word concept (no quotes needed)

node src/cli/main.ts read "_lib/alias-map.mjs#buildAliasMap"   # id from locate
node src/cli/main.ts read buildAliasMap                        # bare name (errors if ambiguous)

node src/cli/main.ts grep "buildAliasMap(" --fixed --file alias-map
node src/cli/main.ts grep "export (async )?function \w+" --limit 20

node src/cli/main.ts graph buildAliasMap                # who calls it (+ floor); default callers
node src/cli/main.ts graph computeDiff --callees        # what it calls
node src/cli/main.ts graph parseProject --depth 3       # transitive blast radius

node src/cli/main.ts dead --file src/    # exported + no cross-file importer (dead-code vs dead-export)
node src/cli/main.ts stats
```

Add `--json` to any command for machine-readable output. Queries accept a bare name
(`buildIndex`), a path-scoped name (`alias-map#buildAliasMap`), or a path fragment
(`alias-map#`).

### As an MCP server

A model consumes the same primitives over stdio (newline-delimited JSON-RPC).
Install once so it's on `PATH` (no absolute paths in any config):

```bash
npm link            # exposes the `map` and `map-mcp` bins
```

Then register it — globally (every project) or per-project:

```bash
claude mcp add code-map --scope user -- map-mcp
```

```jsonc
// or by hand — no paths, no env
{ "mcpServers": { "code-map": { "command": "map-mcp" } } }
```

Exposes five tools — `locate`, `read`, `grep`, `graph` (call-graph navigation:
`direction` callers/callees, `depth` for transitive; the `callers` result carries a
`floor` — a lower bound, since `obj.method()` dispatch isn't in the graph, so it's
never "clear"), and `hotspots` (bug-risk impact points with their evidence — bug-fix
recurrence + churn + spatial locality + coupling/size; evidence, not a verdict). The
server **auto-detects** the index: it walks up
from the working directory for `.map-index.json`, so one global server serves whatever
project it's launched in — just run `map index` in that project. It **auto-reloads**
when the index changes (stats it before each tool call), so a rebuild (or the first
build in a fresh project) takes effect with no client reconnect; a project with no
index yet stays connected and the tools say so. The server routes and quotes; it
never summarizes.

---

## Architecture

```
src/
  core/            # retrieval library (only dep: oxc-parser)
    types.ts          # MapEntry / MapIndex — coordinates only, no meaning fields
    files.ts          # enumerate source files (git ls-files, else walk)
    extract-symbols.ts# oxc parse → top-level defs (exported/private) + methods + import edges
    fan-in.ts         # resolve relative imports → cross-file reference counts
    build-index.ts    # walk + parse + coordinates + fan-in → index (TS via oxc, Python via the
                      #   ast backend; incremental, drift-aware)
    locate.ts         # tiered ranked routing  ← the one thing that must be precise
    read.ts           # exact slice + token check + searchText re-anchoring
    grep.ts           # ripgrep wrapper, JS fallback
    store.ts          # load/save .map-index.json
  py/extract.py    # Python backend: stdlib `ast` → the same per-file primitives oxc emits
  cli/main.ts      # CLI adapter
  mcp/server.ts    # MCP stdio adapter (auto-reloads on index change)
test/map.test.ts   # extract, exact-slice, methods, relocation, grep-fallback, incremental, CRLF
test/python.test.ts# Python: symbols, exact read, fan-in, from-import + self.m() edges
```

```bash
node --test "test/*.test.ts"
```

### `code-oracle/` — the optional type oracle (a sibling, not the core)

The core resolves the call graph *structurally* — direct calls and `this`/`super`,
instant and light. It deliberately does **not** resolve `obj.method()` dispatch,
which needs types; `graph`'s `floor` says so honestly (a lower bound, name-matched
& unverified) and now points here to verify. `code-oracle/` is a **separate MCP**
that answers *who calls this / what implements this / where is this defined* at
type-checker grade over a warm LSP session:

- **`callers` · `definition` · `implementations`.** `implementations` is type-aware
  Class Hierarchy Analysis (interface → every concrete impl) — the over-approximate
  set that is sound for blast radius, including DI-injected impls a structural graph
  can't draw. Fan-out can be wide (N impls = N sites); that breadth is the nature of
  dispatch, biased safely toward over-inclusion.
- **Multi-language:** tsgo (TypeScript-Go) for TS/JS, `ty` for Python — picked by
  file extension; both speak LSP, so the warm session, persistent answer-cache, and
  readiness logic are shared.
- **Why it's separate.** It has the *opposite* profile to the core: a heavy, pinned
  preview dependency, seconds of project warmup, a stateful LSP session. Isolating it
  keeps the core's "one dependency, no machinery" promise intact, and lets the backend
  be swapped later (LSP today → a stable typed API) without touching the core. The
  seam is the call-graph `floor` (lower bound) → oracle (checker-confirmed set).
- **Honest bounds.** tsgo is solid; `ty` (early preview) currently resolves
  `definition` cross-file but `references`/`implementations` intra-file only, so
  Python `callers` carry `incomplete: true`. Truly dynamic dispatch (token-only DI,
  `Proxy`, `obj[k]()`) is invisible to any checker — a residual for the reader.

`code-oracle/` has its own `package.json` (its preview dep is pinned exact) and
tests (`cd code-oracle && npm test` — the interface-dispatch fixture asserts
`implementations` returns every concrete impl).
