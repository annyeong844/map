# code-map

> 🇰🇷 **한국어로 읽으시려면 → [README.ko.md](./README.ko.md)** &nbsp;·&nbsp; 🇬🇧 English below.

> **Hand your AI agent the exact slice of code it needs — by coordinate, not by guessing.**
> _좌표만 정밀하게. 의미는 LLM이 raw를 보고 매번 새로 판정한다._

![Node](https://img.shields.io/badge/node-%E2%89%A523.6-green)
![langs](https://img.shields.io/badge/TS%2FJS-%2B%20Python-blue)
![deps](<https://img.shields.io/badge/runtime%20deps-1%20(oxc--parser)-brightgreen>)
![tool](https://img.shields.io/badge/tools-just%20%60read%60-ff69b4)
![release](https://img.shields.io/badge/release-0.9.0--rc.1-orange)

---

## Sound familiar? 😅

Your agent needs to read `createMessage`. So it greps — and gets **40 hits** across
providers. It opens whole files to find the right one, burning tokens on code it won't
use. Next turn it "remembers" the function was at line 120 — but your last edit pushed it
to 138, so it reads the **wrong lines** and never notices. 😱

With code-map riding along, the agent just:

> `read({ refs: ["anthropic.ts#createMessage", "openai.ts#createMessage"] })`
> → both exact slices, **one call**, still correct **even after the file moved.**

`grep` still does the _finding_ — it's great at that. **code-map does the _reading_:**
small, exact, drift-proof. That's the whole idea.

---

## What you get — measured, not promised

|                                  |                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 🎯 **Never silently wrong**      | After heavy edits with no re-index, `read` re-anchors on the signature line: **0 silently-wrong bytes** (a naive "line number" cache is ~100% wrong). It returns the right code or tells you it can't — never the wrong bytes.                                                                                                                                                       |
| ⚡ **Fewer tokens, fewer steps** | Direct known-ref run (**GPT-5.6 Sol, pass@30, 180 tasks, forced real-`rg` baseline**): **−22.4% effective input, −26.3% raw input, −14.7% time, −67.9% calls**, with semantic correctness tied. A newer **paired n=10 multi-stage pilot** measured **−31.8% effective / −40.4% raw input, −14.7% time, and −74.6% calls** across 240 scored stages; pass@30 confirmation is pending. |
| 🧭 **Routing is the lever**      | Agents won't reach for `read` on their own (~17%). The bundled **plugin/skill** makes them: it flips discovery from a _loss_ to **−31%** by killing the double-call, and turns vague usage (erratic, **+61%** worse on one task) into a steady win — **30/30 pass**.                                                                                                                 |
| 🧩 **Tiny & drop-in**            | Node + **one installed runtime dependency** (`oxc-parser`), no manual build step. TS/JS **and** Python. MCP server + a one-line skill — install for Claude, Codex, grok, or Antigravity.                                                                                                                                                                                             |

> **Honest about the edges** (this repo's whole point): code-map does **not** beat `grep` at
> _searching_ — it ties, so keep grepping. And it's **not** a universal token-saver — the win
> is large for reading _known_ symbols **with routing**, but model/task-dependent (an older
> Sonnet/Opus isolated read was ~0 or worse; GPT-5.6 Sol known-single is now −20% effective),
> and a _loss_ on raw discovery unless the skill routes it. Every number, every retraction, the
> model/metric caveats, and a one-command verifier:
> **[code-map-bench](https://github.com/annyeong844/code-map-bench)**.

**TL;DR — grep finds, `read` reads.**

> **Release status:** `0.9.0-rc.1` is the public release candidate. The core is ready for
> real projects; the RC label leaves room to harden installation reports before freezing 1.0.

### Package compatibility

This RC intentionally has no `exports` map. Every module and named export emitted under
`dist/` is therefore part of the package's compatibility surface, including deep imports.
Do not remove or hide one merely because repository-local analysis finds no consumer.
Restricting that surface requires a documented, versioned breaking release with migration
notes.

---

## Quick start

```bash
# 1. install the release candidate (`next` after the first npm release)
npm install -g @annyeong844/code-map@next
# Before that release exists (verified prebuilt JS from GitHub):
npm install -g https://github.com/annyeong844/map/archive/refs/heads/main.tar.gz

# 2. wire both the routing plugin/rules and MCP (dry-run without --apply)
map setup codex --apply
# Other hosts: map setup claude --apply  |  map setup gemini --apply

# 3. optional eager warm-up (the first MCP read can create this automatically)
cd /path/to/your-repo && map index --root .  # writes ./.map-index.json
```

That's it — your agent now has one tool, `read`. For the **−19% / −67%** efficiency win on
Codex you also tell it _when_ to use code-map (one line); see _Wiring it for real_ below.
When launched inside a repo, the MCP server auto-detects its index. A global server can serve
many repos: each `read` selects one with `root` (the bundled skill supplies it). A missing or
incompatible index is built lazily. Source changes only mark an O(1) dirty generation; the next
read performs one shared O(files) stat scan and rebuilds when drift reaches
`ceil(sqrt(project files))`. A new-symbol miss also rebuilds smaller drift and retries once.
MCP `initialize` never parses or prepares an index, so repository size cannot block the handshake;
the first `read` owns that work and stdout backpressure bounds queued response bytes.
There is no background parser or polling child to orphan. Set `CODE_MAP_AUTO_INDEX=off` to opt out;
`CODE_MAP_AUTO_INDEX_POLL_MS` changes the on-call fallback interval (default 2000 ms).

---

## Who is this for?

### ✅ Great fit if you

- run an **AI coding agent** (Codex, Claude Code, …) that reads a lot of code
- have a repo big enough that `grep` returns noise and reads pull whole files
- work in **TypeScript / JavaScript or Python**
- want reads that **stay correct as the code changes under the agent**

### ❌ Not the tool (yet) if you

- want a better _search_ — `grep`/ripgrep already ties it; code-map is for _reading_
- have a 1–2 file project — the read savings won't show up
- want "where is auth handled?" concept search — that's embeddings (a measured non-goal here)

---

## The one tool: `read`

```bash
map read "alias-map.ts#buildAliasMap"        # path-scoped name → exact slice
map read "server.py#Outer/Inner/run"          # exact lexical path for nested symbols
map read buildAliasMap                       # bare name (errors if ambiguous)
map read withRetry --snippet "req.copy()"    # char range *inside* the symbol
map read --refs "getModel,createMessage,withRetry"   # batch: many symbols, one call
map stats                                    # index overview
```

Add `--json` for machine output. **Search with your own `grep`** — feed the `file:line` or
symbol name you find to `read`. As an MCP tool it's the same `read` (absolute repo `root`, single
`ref`, a `refs` array for batch, optional `snippet`). Windows and `/mnt/<drive>/...` WSL root
spellings are interchangeable. If a Windows-hosted MCP reads a repo on native WSL ext4, pass the
repo's `\\wsl.localhost\<distro>\...` UNC path as `root`; a WSL-hosted server also accepts the
matching current-distro UNC spelling. `ref` stays repo-relative (`path#symbol`).
An existing file's `path#symbol` form is strict: if that exact symbol or lexical path is absent,
`read` returns candidates/failure instead of silently promoting a different fuzzy name. Class
methods and nested Python declarations also accept `path#Outer/Inner/method`; previously exposed
leaf IDs remain valid.
Python module bindings proven by the AST—plain/annotated assignments and PEP 695 `type` aliases—are
indexed too, while function locals and class fields stay outside the symbol surface.
Exact slices require UTF-8 source (a UTF-8 BOM is supported); other source encodings are reported
as degraded instead of being misdecoded or mislabeled as missing.
Python slices include their leading decorators (`@dataclass`, `@property`, and so on). If a
half-written Python file is temporarily syntax-invalid, incremental indexing keeps its
last-known-good symbols stale rather than silently deleting them; CLI and MCP diagnostics expose
the degraded file until its next valid edit.
For UNC repositories, the Windows server asks that WSL distro's native Git for the
gitignore-aware file list. This keeps the Windows and Linux corpus identical instead of making
the two hosts rebuild the shared index back and forth.

For ordinary LLM retrieval, add `responseFormat: "compact"`. It keeps the safety status, source
coordinates, notes, and raw source while dropping repeated JSON keys and file metadata; `json`
remains the default for machine consumers. On a representative two-function read, this reduced
the response from 2,453 to 2,144 bytes (12.6%). The source body dominates, so this is a modest
packaging win rather than a magical order-of-magnitude token cut.

To refresh a prior MCP working set after edits, send the same `refs` with
`changedOnly: true`. The long-lived server compares against the slices it actually returned,
so an automatic index rebuild cannot turn an edited symbol into a false `unchanged`; a ref with
no session baseline is returned conservatively. The one-shot `map changed` CLI remains
index-relative because it has no prior session.

Index bytes hot-reload; MCP server code and client configuration do not. If a session may still
be running an older command or file, pass `diagnostics: true`. The response reports the live
instance id, pid, start time, entrypoint, server file, source identities, and `restartRequired`.
When that flag is true—or the reported entrypoint is not the one you configured—start a new MCP
session before using the result as evidence.

---

<details>
<summary><b>🧪 The honest scorecard — what we kept, and what the data made us cut</b></summary>

code-map started broad (locate, grep, graph, hotspots, semantic search) and was
**benchmarked honestly against `grep` + a strong agent** (Sonnet/Opus, headless, on real
repos — `cline`, `django`, `requests`). The measurements ate most of it; the surface was
cut to match. Keeping only what beat the baseline _is the point_.

| Capability                                             | Measured vs `grep` + strong agent                                                                                                                                                                                                                                                                                          | Verdict             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **Drift-safe READ** (`read`)                           | After heavy churn, no re-index: **0 silently-wrong bytes**, 94.5% recovery vs naive line-caching at **100% silent**. Reproduced.                                                                                                                                                                                           | **kept**            |
| **Drift-safe EDIT** (`read --snippet`)                 | Quoted snippet → its _current_ char range after churn: **0 silent mistargets** vs naive **100%**.                                                                                                                                                                                                                          | **kept**            |
| **`refs` batch tokens**                                | Pass@30, 150 tasks, real plugin env (codex): **−18.6% effective tokens, −67% shell commands, tied pass@30, 0 MCP fails.** Biggest where it fully replaces grep (known-cross-file −25% tok / −44% time); a wash/slower where it only supplements (discovery, multi-symbol batch). **A loss on Opus** (native already lean). | **kept**            |
| **GPT-5.6 Sol known refs**                             | Pass@30, 180 tasks vs forced real `rg`: **−22.4% effective / −26.3% raw input, −14.7% time, −67.9% calls, −58.4% retrieval payload**; semantic answers tied 90/90 per strategy. Known-single alone: **−20.0% effective input**.                                                                                            | **kept**            |
| **GPT-5.6 Sol multi-stage workflows**                  | Paired **n=10 pilot**, 3 four-stage workflows / 240 scored stages: **−31.8% effective / −40.4% raw input, −14.7% time, −74.6% calls, −25.5% payload**; semantic answers tied 120/120 per strategy. **Not pass@30 yet.**                                                                                                    | **promising pilot** |
| **Read — turns**                                       | −25–30% agent _turns_ (K=30, both models, CI clear of 0).                                                                                                                                                                                                                                                                  | **kept**            |
| **Caller precision** (`code-oracle`, separate sibling) | **31% fewer files to read** for blast-radius (40–75% on common names); the type checker disambiguates which class's method. LSP-warmup cost.                                                                                                                                                                               | **kept (sibling)**  |
| **Single-read tokens**                                 | The early blanket "−16–35%" was K=5 noise and was correctly retracted for its Sonnet/Opus task (~0 / worse). It was too broad to imply no savings generally: GPT-5.6 Sol known-single now measures **−20.0% effective / −24.1% raw input**.                                                                                | **scope corrected** |
| **Search / `locate`**                                  | **Ties** `grep` (100% recall).                                                                                                                                                                                                                                                                                             | removed             |
| **Semantic embeddings**                                | **Worse** — rejected three independent ways; degraded a grep agent.                                                                                                                                                                                                                                                        | not built           |
| **Light call-graph**                                   | **Loses to `grep` on recall** (blind to dispatch/types).                                                                                                                                                                                                                                                                   | removed             |

Full numbers, the round-trip law, the adoption ladder, and every retraction live in
**[code-map-bench](https://github.com/annyeong844/code-map-bench)** —
[RESULTS.md](https://github.com/annyeong844/code-map-bench/blob/main/RESULTS.md) (drift/edit/oracle)
and [EFFICIENCY-CODEX.md](https://github.com/annyeong844/code-map-bench/blob/main/EFFICIENCY-CODEX.md)
(batch/cross-model/adoption). `node verify.mjs` there re-derives the committed headlines —
the codex & grok pass@30 top-lines included — from the raw run data, and prints the few it can't.

</details>

<details>
<summary><b>🧭 How <code>read</code> survives drift (the core trick)</b></summary>

`read(symbol)` resolves the name to one symbol, then:

```
1. file token matches index   →  exact char-offset slice          [exact]
2. file changed               →  re-anchor on the signature, re-slice [relocated]
3. anchor matches many sites  →  return the candidate locations    [ambiguous]
4. anchor is gone             →  say so; re-index to refresh        [anchor-lost]
```

Line numbers drift; a signature line rarely does. When offsets go stale, `read` re-finds
the symbol on its signature and **flags** the result so you verify the boundary — nothing
is silently trusted. That's its edge over a blind `Read(file, lineRange)`: a stale line
range returns the wrong bytes; `read` re-anchors or tells you it can't. `--snippet` gets a
char range _inside_ the symbol, never escaping into a neighbour.

</details>

<details>
<summary><b>🧱 Why coordinates, never meaning</b></summary>

A map that stores _meaning_ (summaries) must defend it against going stale — producers,
verifiers, regeneration. Store no interpretation and that machinery disappears; what's left
is only what a machine can verify: a **coordinate index** (`path`/`line`/`charStart–charEnd`)
plus **one token per file** that says whether those coordinates still hold. The only
question — _"is this coordinate correct?"_ — has an answer. _"Is this description right?"_ is
never asked. The LLM reads the raw bytes and judges them fresh, every call.

**Where the coordinates come from:** code-map parses the source tree itself (no external
graph). Git-tracked files (`git ls-files`, so `.gitignore` is respected) → **TS/JS via
`oxc-parser`**, **Python via a packaged native Ruff parser** (with an exact stdlib-`ast`
fallback) — both emit the same per-file
primitives (symbol coordinate + a `searchText` drift-anchor + a content token). `fanIn`
(cross-file reference count) only breaks ties when a bare name resolves to more than one
symbol. The native extractor parses files in one bounded parallel process; unsupported source
platforms fall back to memory-aware, size-balanced short-lived Python workers. No parser process
is resident after a build, and packaged installs need no Python runtime. Honest scope: namespace /
`export *` / alias imports aren't attributed.

</details>

<details>
<summary><b>🔌 Wiring it for real (install options + the efficiency win)</b></summary>

**Requirements:** Node ≥ 23.6, one installed npm runtime dependency (`oxc-parser`); `ripgrep`
used for the file walk when present. Published tarballs need no install-time build. The temporary
GitHub source route uses the same reviewed `dist`, committed and checked against source in CI. Supported packages include the
native Python extractor. Release CI builds and executes prebuilt binaries for Windows x64,
Linux x64/arm64 (static musl), and macOS x64/arm64; npm installs never compile Rust. On an
unsupported/source-only install, Python 3 is auto-detected as
`python3`/`python` on Unix and `py -3`/`python3`/`python` on Windows. `CODE_MAP_PY_BACKEND=stdlib`
forces that fallback, `CODE_MAP_PYTHON` selects its interpreter, and `CODE_MAP_PY_NATIVE` selects
an explicit native executable. Source contributors can stage their host binary with
`npm run build:native`.
For a native WSL install, check `node --version` _inside WSL_—a current Windows Node does not
upgrade a stale WSL Node, and code-map requires ≥23.6 in the environment that launches it.

**Install:** `npm install -g @annyeong844/code-map@next` (RC channel) ·
`npm install -g https://github.com/annyeong844/map/archive/refs/heads/main.tar.gz` (before npm release) · or clone + `npm install && npm link`.
All expose `map` and `map-mcp`.
The GitHub archive route is source-only: its JavaScript is prebuilt without an install lifecycle script,
while Python uses the documented stdlib fallback unless you explicitly stage a native extractor.
Do not substitute npm's `github:annyeong844/map` Git-dependency shorthand: npm 11.18 can return
success while leaving its global package junction pointed at a deleted preparation directory.

`oxc-parser` includes an OS-native binding, so Windows and WSL must not share one
`node_modules` tree. In particular, never `npm link` a WSL `map-mcp` to a Windows checkout under
`/mnt/c`; it will exit before MCP `initialize` while looking for the Linux binding. Pick one owner:

```bash
# Native WSL owner (best for repositories in the WSL ext4 filesystem)
npm install -g @annyeong844/code-map@next
codex mcp add code-map -- "$(command -v map-mcp)"
# The resolved package target must stay in the WSL filesystem, not /mnt/c.

# Windows owner reached through WSL interop (best for repositories under /mnt/c)
codex mcp add code-map -- /mnt/c/path/to/node.exe \
  'C:\path\to\node_modules\@annyeong844\code-map\dist\mcp\server.js'
```

Do not mix the two owners against one index in parallel: Windows and Linux expose different file
identity metadata. For `/mnt/c` repositories the Windows owner also avoids the drvfs stat tax; in a
measured 42-file smoke here, a fresh exact read was about 0.2 s instead of 27 s.

`map setup codex --apply` recognizes native `map-mcp`, the Windows-package interop form above, and
the `cmd.exe /d /c map-mcp` wrapper. It probes a real `initialize` exchange and repairs other
command/args. A broken cross-OS launcher now fails setup with its native-binding stderr instead of
surviving until the next Codex restart.

Then use `map setup codex|claude|gemini`. It prints an inspectable dry run; add `--apply` to
make the idempotent user-level changes. This installs both halves that measurements require:
the routing rules/plugin and the MCP server.

**MCP config** — one global server can switch repositories per call:

```jsonc
{ "root": "/absolute/path/to/repo", "refs": ["path#a", "path#b"] }
```

`root` is the recommended multi-repo path. Pin `MAP_INDEX` only for a single-repo client that
cannot supply tool arguments:

```toml
# ~/.codex/config.toml  (or project .codex/config.toml)
[mcp_servers.code-map]
command = "map-mcp"
[mcp_servers.code-map.env]
MAP_INDEX = "/path/to/target-repo/.map-index.json"
```

```jsonc
// generic MCP client
{ "mcpServers": { "code-map": { "command": "map-mcp" } } }
```

**The efficiency win needs adoption.** Agents won't pick code-map over grep on their own
(measured: ~17%). Wirings that reach **100% reliable** use — pick one:

- **The bundled Codex plugin/skill (recommended for Codex):** this repo ships a
  Codex-first routing skill at `plugins/code-map/skills/code-map-retrieval/`, a
  `.codex-plugin/plugin.json` manifest, and `.agents/plugins/marketplace.json`.
  ```bash
  map setup codex --apply
  map setup claude --apply
  grok plugin install annyeong844/map          # Grok (or a local path)
  ```
  It carries the **discovery double-call guard** — for discovery, grep and _stop_; don't add a
  `read` on top — which a 3-arm benchmark showed flips discovery from a loss to a win.
- **An `AGENTS.md` line (per-repo, zero load cost):** see [code-map-bench/integrations/AGENTS.code-map.md](https://github.com/annyeong844/code-map-bench/blob/main/integrations/AGENTS.code-map.md).
- **Antigravity / Gemini:** `map setup gemini --apply` merges the bundled `GEMINI.md` routing
  block into `~/.gemini/GEMINI.md` and the MCP into `~/.gemini/config/mcp_config.json` without
  replacing unrelated settings. The resulting MCP entry is:
  ```jsonc
  { "mcpServers": { "code-map": { "command": "map-mcp" } } }
  ```
  On Windows + WSL, install code-map with the _Windows_ Node (≥23.6) so `map-mcp` is a native
  command (`{ "command": "cmd", "args": ["/d","/c","map-mcp"] }`). `read.root` accepts either
  `C:\...` or `/mnt/c/...`; native Linux servers and paths work directly too.

Either says, in effect: _"read known symbols via code-map `read` (batch independent refs in
one call); use grep only to discover, and don't double-fetch."_ The MCP server also
self-advertises this at startup (raises the no-config baseline), but a plugin/skill/rule
directive is what makes it reliable.

**References (optional, type-aware): wire `code-oracle` too.** For _who-calls / definition /
implementations_ the skill escalates to the sibling `code-oracle` (tsgo for TS/JS, ty for Python,
checker-grade). It's a separate MCP (kept out of the zero-dep core); wire it where the skill can reach it:

```bash
codex  mcp add code-oracle -- node /abs/path/to/map/code-oracle/server.ts
claude mcp add code-oracle --scope user -- node /abs/path/to/map/code-oracle/server.ts
```

**RC distribution policy:** `code-oracle` is intentionally not inside the core npm tarball and
is not separately published yet. Clone this repository, run `npm ci` in `code-oracle/`, and wire
that checkout as above. Core code-map remains independently installable and one-dependency light.

GA `typescript@7.0.2` exposes the build compiler as `tsc`, but not the `tsgo` launcher that
code-oracle uses for its LSP server. Code-oracle therefore pins the current
`@typescript/native-preview` LSP build. Package-managed installs resolve the platform's native
`tsgo` executable directly instead of retaining a Node launcher plus its child; explicit
`TSGO_BIN` launchers remain supported. Node package resolution from the trusted server install
tree also supports hoisted workspace/pnpm layouts without executing a dependency from the
queried workspace.

Sessions start lazily on the first checker query (~seconds–20s by repo size); set
`CODE_ORACLE_PREWARM=1` only when paying that cost at startup is worthwhile. Warm sessions are
bounded to two per MCP and reaped after 10 idle minutes (`CODE_ORACLE_MAX_SESSIONS` and
`CODE_ORACLE_SESSION_IDLE_MS` override those limits), and MCP stdin EOF reaps every child.
Concurrent queries for one root share the same exact fingerprint scan, and identical checker
queries share one in-flight LSP request. With the default zero fingerprint TTL, the completed
file map is released immediately rather than retained. Persistent answers write one full
snapshot per project epoch and append same-epoch deltas, avoiding quadratic cache rewrites.
An LSP request timeout is a hard checker failure, never an empty result: the poisoned backend is
terminated immediately and the next query starts a fresh session. MCP and LSP JSON are validated
as untrusted input before paths, caches, or checker state are touched.
Every successful answer includes structured `coverage`. `implementations.results` always keeps the full
checker-visible possible set; TS/JS additionally marks each entry `likely` or `possible` from direct
`new Class` / `useClass: Class` source hints. That ranking is for reading order only:
`implementationEvidence.runtimeObserved` is always `false`, lexical false positives, name collisions,
and dead code remain possible, and `evidence: false` skips the optional project scan without changing
the result set.
**Cross-platform:** code-oracle normalizes `/mnt/c/…` ↔ `C:\…` paths,
so _one_ server serves both a Windows IDE and WSL agents (over interop) — e.g. a fast **win32** build
can serve WSL clients too, dodging the `/mnt/c` drvfs penalty (~38s → ~4s on the same repo).
Native **Linux/WSL is supported too**: install `code-oracle/` with that environment's Node/npm and
it selects `native-preview-linux-<arch>`. A wrapper left by another OS is rejected immediately
instead of burning two 40-second request timeouts.

</details>

<details>
<summary><b>📊 Benchmark it yourself</b></summary>

The in-repo complexity microbenchmark covers full/no-op indexing, cold/warm locate, 64-symbol
line-only reads, and both pure-wildcard and mixed named/wildcard 10,000-file barrel chains:

```bash
npm run bench
```

For read-only validation on staged real repositories (cold/no-op time, exact reads, memory, clean
worker exit, and before/after source fingerprints):

```bash
npm run corpus:lab
node --expose-gc scripts/corpus-lab.mjs --profile stress --out .audit/corpus/next.json
```

See [the corpus-lab protocol](./docs/corpus-lab.md) for profiles, safety guarantees, and explicit
limits.

```bash
git clone https://github.com/annyeong844/code-map-bench && cd code-map-bench
codex login --device-auth
node harnesses/bench-codex-headless.mjs --run --passes 30 --auth chatgpt --repo ../map --strategies native,map-batch
# Restricted nested shell? Force the reproducible real-rg baseline instead:
node harnesses/bench-codex-headless.mjs --run --passes 30 --repo ../map --strategies grep-mcp,map-batch --model gpt-5.6-sol
```

The harness (in [code-map-bench](https://github.com/annyeong844/code-map-bench)) runs pass@30 over a diverse task set, captures usage
from `codex exec --json`, and **scores the route** (native rows fail if they touch MCP;
map-batch rows fail if they don't complete a `read({ refs: [...] })`). It reports raw,
`adjusted = input − cached`, and cache-aware `effective = uncached + cached×weight` so you
can see the win under real prompt caching. The honest takeaway, by scenario:

| scenario                 | code-map vs grep             | when                                                            |
| ------------------------ | ---------------------------- | --------------------------------------------------------------- |
| known-cross-file         | **−25% tokens, −44% time**   | reading named symbols spread across files — grep fully replaced |
| file-wide / known-single | −15–21% tokens, −28–35% time | known symbols, grep replaced                                    |
| discovery-first          | tokens ↓ but **time ↑**      | must grep to find first → code-map only supplements             |
| multi-symbol batch       | ~tie                         | native already batches there                                    |

The newer GPT-5.6 Sol forced-`rg` known-ref run (3 scenarios × 30) measures **−22.4%
effective input, −26.3% raw input, and −14.7% time overall**. Its known-single cell is
**−20.0% effective input**, correcting the older wording that could be read as a universal
"single read saves ~0" claim. Full report: [GPT-5.6 Sol pass@30](https://github.com/annyeong844/code-map-bench/blob/main/results/gpt56-sol-pass30.md).

A continuous-workflow follow-up (orient → trace → impact analysis → tool-free
synthesis) kept the savings across 10 paired passes: **−31.8% effective input, −40.4%
raw input, −14.7% elapsed, and −74.6% calls**, with semantic correctness tied at
120/120 stages per strategy. This is explicitly an **n=10 pilot**, not a pass@30 result;
see the [multi-stage workflow report](https://github.com/annyeong844/code-map-bench/blob/main/results/gpt56-sol-workflow-pilot10.md).

It is **not** a token-saver everywhere — strongest when the agent already knows the refs and
code-map can _replace_ (not augment) the search.

</details>

<details>
<summary><b>🏛️ Architecture + the <code>code-oracle</code> sibling</b></summary>

```
src/
  core/    types · files · extract-symbols (oxc) · fan-in · index-drift · build-index · locate · read · store
  py/      extract.py   (portable Python stdlib fallback)
  cli/     main.ts      (index / read / changed / stats / setup / version)
  mcp/     server.ts    (the single `read` tool, lazy auto-index + live-process diagnostics)
native/
  python-extractor/     (pinned Ruff parser → the same per-file primitives)
test/      extract · exact-slice · methods · relocation · anchor-lost · incremental · fan-in
           · snippet-aim · batch · path-traversal refusal · Python
```

```bash
node --test "test/*.test.ts"
```

**`code-oracle/` — an optional, separate, heavier sibling.** `grep` and a light index can't
resolve `obj.method()` dispatch — that needs types. code-oracle is a **separate MCP** that
answers _who calls this / what implements this / where is this defined_ at type-checker grade
over a warm LSP session (**tsgo** for TS/JS, **ty** for Python). Kept separate on purpose:
a heavy preview dependency, seconds of warmup, stateful — the opposite of code-map's one-dep
lightness. Honest bounds (measured): tsgo is solid; **ty (0.0.50) resolves `definition`
cross-file and accurately, but `references` is intra-file only** — so Python `callers` are a
lower-bound intra-file screen (flagged `incomplete: true`). For complete Python callers, use
`grep` (100% recall); we deliberately don't add a heavier Python references backend. Truly
dynamic dispatch (token-only DI, `Proxy`, `obj[k]()`) is invisible to any checker. Its own
`package.json` + tests (`cd code-oracle && npm test`). Responses make those boundaries
machine-readable through `coverage`: TypeScript callers are checker-confirmed, implementations
are a checker-visible over-approximation, and Python references are an intra-file lower bound.

</details>

<details>
<summary><b>🔧 Maintainer / publishing</b></summary>

```bash
npm test                 # core contract tests
npm run typecheck        # tsc --noEmit, strict (0 errors; src/ is any-free)
npm run lint             # pinned oxlint
npm run release:check    # all checks + fresh-tarball CLI/MCP smoke
```

`check:package` inspects the exact dry-run file list and fails if local env/config paths
(`.env`, `.codex`, `auth.json`, `config.toml`, …) or likely token values would ship.
GitHub releases publish through npm Trusted Publishing (OIDC + provenance); prereleases go to
the `next` dist-tag and stable versions to `latest`.

The first npm publication is a one-time CI bootstrap so the first public RC still carries all five
native extractors. Revoke any previously exposed token, enable account 2FA, and create a
shortest-lived granular token with read/write access to the `@annyeong844` scope and bypass 2FA.
Store it only as `NPM_BOOTSTRAP_TOKEN` in the protected GitHub environment `npm`, then publish the
matching GitHub release. The workflow builds the complete native matrix and publishes with
provenance. Delete the secret immediately afterward and configure npm's GitHub trusted publisher
for `annyeong844/map`, workflow `publish.yml`, environment `npm`, and allowed action `npm publish`.
The workflow refuses a lingering bootstrap token after the package exists; every later release uses
OIDC without an npm token.

</details>
