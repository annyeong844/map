# code-map

> 🇰🇷 **한국어로 읽으시려면 → [README.ko.md](./README.ko.md)** &nbsp;·&nbsp; 🇬🇧 English below.

> **Hand your AI agent the exact slice of code it needs — by coordinate, not by guessing.**
> *좌표만 정밀하게. 의미는 LLM이 raw를 보고 매번 새로 판정한다.*

![Node](https://img.shields.io/badge/node-%E2%89%A523.6-green)
![langs](https://img.shields.io/badge/TS%2FJS-%2B%20Python-blue)
![deps](https://img.shields.io/badge/runtime%20deps-1%20(oxc--parser)-brightgreen)
![tool](https://img.shields.io/badge/tools-just%20%60read%60-ff69b4)

---

## Sound familiar? 😅

Your agent needs to read `createMessage`. So it greps — and gets **40 hits** across
providers. It opens whole files to find the right one, burning tokens on code it won't
use. Next turn it "remembers" the function was at line 120 — but your last edit pushed it
to 138, so it reads the **wrong lines** and never notices. 😱

With code-map riding along, the agent just:

> `read({ refs: ["anthropic.ts#createMessage", "openai.ts#createMessage"] })`
> → both exact slices, **one call**, still correct **even after the file moved.**

`grep` still does the *finding* — it's great at that. **code-map does the *reading*:**
small, exact, drift-proof. That's the whole idea.

---

## What you get — measured, not promised

| | |
|---|---|
| 🎯 **Never silently wrong** | After heavy edits with no re-index, `read` re-anchors on the signature line: **0 silently-wrong bytes** (a naive "line number" cache is ~100% wrong). It returns the right code or tells you it can't — never the wrong bytes. |
| ⚡ **Fewer tokens, fewer steps** | Wired into a coding agent (codex, 150-task pass@30): **−19% tokens, −67% shell commands, same success rate.** On **known-ref** reads the cut is much larger — grok composer-2.5-fast, 30 passes: **−53…−60% tokens, −71…−78% retrieval payload**; codex with the routing skill: **−34…−54%**. |
| 🧭 **Routing is the lever** | Agents won't reach for `read` on their own (~17%). The bundled **plugin/skill** makes them: it flips discovery from a *loss* to **−31%** by killing the double-call, and turns vague usage (erratic, **+61%** worse on one task) into a steady win — **30/30 pass**. |
| 🧩 **Tiny & drop-in** | Node + **one** dependency (`oxc-parser`), no build step. TS/JS **and** Python. MCP server + a one-line skill — install for Claude, Codex, grok, or Antigravity. |

> **Honest about the edges** (this repo's whole point): code-map does **not** beat `grep` at
> *searching* — it ties, so keep grepping. And it's **not** a universal token-saver — the win
> is large for reading *known* symbols **with routing**, ~0 on an already-lean read task, and a
> *loss* on raw discovery unless the skill routes it. Every number, every retraction, the
> model/metric caveats, and a one-command verifier:
> **[code-map-bench](https://github.com/annyeong844/code-map-bench)**.

**TL;DR — grep finds, `read` reads.**

---

## Quick start

```bash
# 1. install (until npm publish, straight from GitHub)
npm install -g github:annyeong844/map        # gives you `map` + `map-mcp`

# 2. index the repo you want your agent to read
cd /path/to/your-repo && map index --root .  # writes ./.map-index.json

# 3. wire it into your agent (examples)
codex mcp add code-map -- map-mcp             # Codex
claude mcp add code-map --scope user -- map-mcp   # Claude Code
```

That's it — your agent now has one tool, `read`. For the **−19% / −67%** efficiency win on
Codex you also tell it *when* to use code-map (one line); see *Wiring it for real* below.
The MCP server auto-detects the index (walks up for `.map-index.json`) and auto-reloads
when you re-index — no reconnect.

---

## Who is this for?

### ✅ Great fit if you

- run an **AI coding agent** (Codex, Claude Code, …) that reads a lot of code
- have a repo big enough that `grep` returns noise and reads pull whole files
- work in **TypeScript / JavaScript or Python**
- want reads that **stay correct as the code changes under the agent**

### ❌ Not the tool (yet) if you

- want a better *search* — `grep`/ripgrep already ties it; code-map is for *reading*
- have a 1–2 file project — the read savings won't show up
- want "where is auth handled?" concept search — that's embeddings (a measured non-goal here)

---

## The one tool: `read`

```bash
map read "alias-map.ts#buildAliasMap"        # path-scoped name → exact slice
map read buildAliasMap                       # bare name (errors if ambiguous)
map read withRetry --snippet "req.copy()"    # char range *inside* the symbol
map read --refs "getModel,createMessage,withRetry"   # batch: many symbols, one call
map stats                                    # index overview
```

Add `--json` for machine output. **Search with your own `grep`** — feed the `file:line` or
symbol name you find to `read`. As an MCP tool it's the same `read` (single `ref`, a `refs`
array for batch, optional `snippet`).

---

<details>
<summary><b>🧪 The honest scorecard — what we kept, and what the data made us cut</b></summary>

code-map started broad (locate, grep, graph, hotspots, semantic search) and was
**benchmarked honestly against `grep` + a strong agent** (Sonnet/Opus, headless, on real
repos — `cline`, `django`, `requests`). The measurements ate most of it; the surface was
cut to match. Keeping only what beat the baseline *is the point*.

| Capability | Measured vs `grep` + strong agent | Verdict |
|---|---|---|
| **Drift-safe READ** (`read`) | After heavy churn, no re-index: **0 silently-wrong bytes**, 94.5% recovery vs naive line-caching at **100% silent**. Reproduced. | **kept** |
| **Drift-safe EDIT** (`read --snippet`) | Quoted snippet → its *current* char range after churn: **0 silent mistargets** vs naive **100%**. | **kept** |
| **`refs` batch tokens** | Pass@30, 150 tasks, real plugin env (codex): **−18.6% effective tokens, −67% shell commands, tied pass@30, 0 MCP fails.** Biggest where it fully replaces grep (known-cross-file −25% tok / −44% time); a wash/slower where it only supplements (discovery, multi-symbol batch). **A loss on Opus** (native already lean). | **kept** |
| **Read — turns** | −25–30% agent *turns* (K=30, both models, CI clear of 0). | **kept** |
| **Caller precision** (`code-oracle`, separate sibling) | **31% fewer files to read** for blast-radius (40–75% on common names); the type checker disambiguates which class's method. LSP-warmup cost. | **kept (sibling)** |
| **Single-read tokens** | The early "−16–35%" was K=5 noise; single read at K=30 ~0. | retracted |
| **Search / `locate`** | **Ties** `grep` (100% recall). | removed |
| **Semantic embeddings** | **Worse** — rejected three independent ways; degraded a grep agent. | not built |
| **Light call-graph** | **Loses to `grep` on recall** (blind to dispatch/types). | removed |

Full numbers, the round-trip law, the adoption ladder, and every retraction live in
**[code-map-bench](https://github.com/annyeong844/code-map-bench)** —
[RESULTS.md](https://github.com/annyeong844/code-map-bench/blob/main/RESULTS.md) (drift/edit/oracle)
and [EFFICIENCY-CODEX.md](https://github.com/annyeong844/code-map-bench/blob/main/EFFICIENCY-CODEX.md)
(batch/cross-model/adoption). `node verify.mjs` there re-derives every headline from raw data.

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
char range *inside* the symbol, never escaping into a neighbour.

</details>

<details>
<summary><b>🧱 Why coordinates, never meaning</b></summary>

A map that stores *meaning* (summaries) must defend it against going stale — producers,
verifiers, regeneration. Store no interpretation and that machinery disappears; what's left
is only what a machine can verify: a **coordinate index** (`path`/`line`/`charStart–charEnd`)
plus **one token per file** that says whether those coordinates still hold. The only
question — *"is this coordinate correct?"* — has an answer. *"Is this description right?"* is
never asked. The LLM reads the raw bytes and judges them fresh, every call.

**Where the coordinates come from:** code-map parses the source tree itself (no external
graph). Git-tracked files (`git ls-files`, so `.gitignore` is respected) → **TS/JS via
`oxc-parser`**, **Python via a stdlib-`ast` backend** — both emit the same per-file
primitives (symbol coordinate + a `searchText` drift-anchor + a content token). `fanIn`
(cross-file reference count) only breaks ties when a bare name resolves to more than one
symbol. Honest scope: namespace / `export *` / alias imports aren't attributed.

</details>

<details>
<summary><b>🔌 Wiring it for real (install options + the efficiency win)</b></summary>

**Requirements:** Node ≥ 23.6 (runs TypeScript directly, no build), one runtime dep
(`oxc-parser`); `ripgrep` used for the file walk when present; Python needs `python3` on `PATH`.

**Install:** `npm install -g @annyeong844/code-map` (once published) ·
`npm install -g github:annyeong844/map` (now) · or clone + `npm install && npm link`.
All expose `map` and `map-mcp`.

**MCP config** — pin the index if your client starts servers outside the repo:

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

- **The bundled plugin/skill (recommended):** this repo ships the routing skill at
  `skills/code-map-retrieval/` with a `.claude-plugin/plugin.json` manifest, so it installs
  as a plugin and self-routes everywhere.
  ```bash
  grok plugin install annyeong844/map          # Grok (or a local path)
  claude plugin install annyeong844/map         # Claude Code
  # any host: copy skills/code-map-retrieval/SKILL.md into ~/.codex/skills/ (or .grok/.claude)
  ```
  It carries the **discovery double-call guard** — for discovery, grep and *stop*; don't add a
  `read` on top — which a 3-arm benchmark showed flips discovery from a loss to a win.
- **An `AGENTS.md` line (per-repo, zero load cost):** see `bench/codex-headless/AGENTS.code-map.md`.
- **Antigravity / Gemini:** Antigravity reads rules from `GEMINI.md` (global `~/.gemini/GEMINI.md`
  or workspace) and `AGENTS.md`. This repo ships a ready `GEMINI.md` — copy it into your global
  `~/.gemini/GEMINI.md` (or a workspace) for the routing. Wire the MCP via the IDE's
  **Manage MCP Servers → View raw config** (`~/.gemini/config/mcp_config.json`):
  ```jsonc
  { "mcpServers": { "code-map": { "command": "map-mcp" } } }
  ```
  On Windows + WSL, install code-map with the *Windows* Node (≥23.6) so `map-mcp` is a native
  command (`{ "command": "cmd", "args": ["/d","/c","map-mcp"] }`); it reads the same repo files.

Either says, in effect: *"read known symbols via code-map `read` (batch independent refs in
one call); use grep only to discover, and don't double-fetch."* The MCP server also
self-advertises this at startup (raises the no-config baseline), but a plugin/skill/rule
directive is what makes it reliable.

</details>

<details>
<summary><b>📊 Benchmark it yourself</b></summary>

```bash
codex login --device-auth
map-bench --run --passes 30 --auth chatgpt --strategies native,map-batch
```

The harness (`bench/codex-headless/`) runs pass@30 over a diverse task set, captures usage
from `codex exec --json`, and **scores the route** (native rows fail if they touch MCP;
map-batch rows fail if they don't complete a `read({ refs: [...] })`). It reports raw,
`adjusted = input − cached`, and cache-aware `effective = uncached + cached×weight` so you
can see the win under real prompt caching. The honest takeaway, by scenario:

| scenario | code-map vs grep | when |
|---|---|---|
| known-cross-file | **−25% tokens, −44% time** | reading named symbols spread across files — grep fully replaced |
| file-wide / known-single | −15–21% tokens, −28–35% time | known symbols, grep replaced |
| discovery-first | tokens ↓ but **time ↑** | must grep to find first → code-map only supplements |
| multi-symbol batch | ~tie | native already batches there |

It is **not** a token-saver everywhere — strongest when the agent already knows the refs and
code-map can *replace* (not augment) the search.

</details>

<details>
<summary><b>🏛️ Architecture + the <code>code-oracle</code> sibling</b></summary>

```
src/
  core/    types · files · extract-symbols (oxc) · fan-in · build-index · locate · read · store
  py/      extract.py   (Python: stdlib ast → the same per-file primitives)
  cli/     main.ts      (index / read / stats)
  mcp/     server.ts    (the single `read` tool, auto-reload)
test/      extract · exact-slice · methods · relocation · anchor-lost · incremental · fan-in
           · snippet-aim · batch · path-traversal refusal · Python
```

```bash
node --test "test/*.test.ts"
```

**`code-oracle/` — an optional, separate, heavier sibling.** `grep` and a light index can't
resolve `obj.method()` dispatch — that needs types. code-oracle is a **separate MCP** that
answers *who calls this / what implements this / where is this defined* at type-checker grade
over a warm LSP session (**tsgo** for TS/JS, **ty** for Python). Kept separate on purpose:
a heavy preview dependency, seconds of warmup, stateful — the opposite of code-map's one-dep
lightness. Honest bounds (measured): tsgo is solid; **ty (0.0.50) resolves `definition`
cross-file and accurately, but `references` is intra-file only** — so Python `callers` are a
lower-bound intra-file screen (flagged `incomplete: true`). For complete Python callers, use
`grep` (100% recall); we deliberately don't add a heavier Python references backend. Truly
dynamic dispatch (token-only DI, `Proxy`, `obj[k]()`) is invisible to any checker. Its own
`package.json` + tests (`cd code-oracle && npm test`).

</details>

<details>
<summary><b>🔧 Maintainer / publishing</b></summary>

```bash
npm test                 # 24 tests
npm run typecheck        # tsc --noEmit, strict (0 errors; src/ is any-free)
npm run lint             # npx oxlint (no devDep)
npm run check:package    # dry-run package file-list safety check
npm publish --access public   # runs check:package via prepublishOnly
```

`check:package` inspects the exact dry-run file list and fails if local env/config paths
(`.env`, `.codex`, `auth.json`, `config.toml`, …) or likely token values would ship.

</details>
