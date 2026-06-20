# Codex Headless Retrieval Benchmark

This harness compares two retrieval strategies under Codex headless sessions:

- `native`: shell search plus direct reads (`rg`, `sed`, `cat`, etc.), with code-map disabled.
- `map-batch`: shell search when useful, then one code-map `read` call with `refs: [...]` for all independent known symbols.

It uses `codex exec --json` for machine-readable events and `codex exec resume <thread_id>` so each pass keeps memory across turns. The JSONL stream includes `turn.completed.usage`, which the harness aggregates into raw input tokens, cached input tokens, adjusted input tokens, output tokens, reasoning output tokens, turn count, item counts, command count, and MCP-call count.

By default the harness uses saved ChatGPT/OAuth Codex credentials, not API-key
auth. Before running it checks `codex login status` for `Logged in using
ChatGPT`, forwards `forced_login_method="chatgpt"` to `codex exec`, and removes
`CODEX_API_KEY` / `OPENAI_API_KEY` from the child environment. On a headless
machine, log in first with:

```bash
codex login --device-auth
codex login status
```

Use `--auth ambient` only when you intentionally want to inherit whatever auth
the local Codex config/environment provides.

The benchmark expects `code-map` to be configured as a Codex MCP server in the
saved Codex config:

```bash
codex mcp list
```

The harness keeps the route honest in scoring: `native` rows fail if they use
any MCP call, and `map-batch` rows fail when a task with `mapRefs` does not
complete at least one batched code-map `read({ refs: [...] })` call. MCP failed
calls, successful read calls, and successful batch-read calls are recorded in
`results.json` and `results.csv`.

## Adoption Ladder

Codex currently treats MCP server instructions as helpful routing context, not as
strong project policy. In small K=6 routing probes on this repo:

| Mechanism | Adoption | Typical Result |
|---|---:|---|
| No hint | low | native `rg`/file reads dominate |
| MCP server instructions only | partial | some `read` use, but mixed with shell body reads |
| Stronger MCP routing rules | better but noisy | fewer shell reads, still occasional pure native runs |
| Project `AGENTS.md` routing hint | consistent | Codex reliably chooses code-map for known refs |
| Literal "run this one tool call" prompt | maximal | one batched call, but not representative of free agent behavior |

Keep the server instructions because they improve the default floor for users who
install only the MCP. For reliable benchmark comparisons, add a project-level
instruction like [`AGENTS.code-map.md`](./AGENTS.code-map.md) to the target repo's
`AGENTS.md`.

The useful claim is intentionally narrow: code-map helps most when the task already
has multiple known symbol refs or when search has already found them. It is usually
a wash on single-symbol lookups, and it can lose on discovery-heavy or whole-file
tasks where shell search/read is already the right primitive.

## Cache And Repeated Prompt Overhead

Each pass starts with a seed turn, then runs one no-op `cache_warmup` resume turn
by default before any scored task:

```bash
map-bench --run --passes 1 --cache-warmup-turns 1
```

The warm-up turn gives Codex's prompt cache a chance to cache the repeated
system/developer/tool prefix before task measurement. Warm-up rows are written
to `results.json` and `results.csv`, but they have `includeInComparison: false`.
By default, strategy order alternates each pass (`native,map-batch` on odd passes,
then reversed on even passes) to reduce shared prompt-cache ordering bias. Use
`--fixed-strategy-order` only when debugging a specific sequence.

Raw `usage` is never rewritten. For fair strategy comparison, the harness also
writes adjusted fields:

- `uncached_input_tokens = input_tokens - cached_input_tokens`
- `adjusted_input_tokens = uncached_input_tokens` by default
- `effective_input_tokens = uncached_input_tokens + cached_input_tokens * cached_input_weight`
- `comparisonUsage` sums scored task rows only

Use `--cache-warmup-turns 0` to disable warm-up, or
`--no-overhead-adjustment` to make `adjusted_input_tokens` equal raw
`input_tokens`.

Read effective, raw, cached, and adjusted columns together. `effective_input_tokens`
is the best single summary when you want cache-aware cost/latency intuition;
`adjusted_input_tokens` is a stricter diagnostic that treats cached prompt prefix
as overhead to exclude. A strategy can reduce raw input and wall time while
looking worse on adjusted input if its cache-hit rate differs; that is a
measurement result, not a reason to hide either column.

The cached-token weight is configurable because different environments may value
cached input differently:

```bash
map-bench --run --cached-input-weight 0.1
map-bench --run --cached-input-weight 0.25
```

## Smoke Run

Dry-run the plan:

```bash
map-bench --passes 1 --max-tasks 1
```

Run one real pass over one task:

```bash
map-bench --run --passes 1 --max-tasks 1
```

Run a broader smoke across known-ref, cross-file, discovery, and file-wide
scenarios:

```bash
map-bench \
  --run \
  --passes 1 \
  --tasks bench/codex-headless/tasks.diverse.json \
  --out .bench/codex-headless/diverse-smoke
```

## pass@30

Make sure the target repo has a current code-map index:

```bash
map index --root .
```

Run 30 independent passes per strategy:

```bash
map-bench \
  --run \
  --passes 30 \
  --auth chatgpt \
  --strategies native,map-batch \
  --tasks bench/codex-headless/tasks.example.json \
  --out .bench/codex-headless/pass30
```

Outputs:

- `summary.md`: compact strategy comparison.
- `results.json`: full structured results with pass/fail and usage metrics.
- `results.csv`: spreadsheet-friendly task rows.
- `runs/<strategy>/pass-*/`: raw Codex JSONL events, stderr, and final JSON per turn.

The seed and cache warm-up turns for each pass are preserved in raw all-row
usage, but excluded from `comparisonUsage`. They are marked `scored: false` and
do not affect task pass/fail. `attemptPassRate` is per attempt; `pass@K` is per
task, counting a task as passed if any of the K passes succeeded.

`summary.md` also includes a `By Scenario` table when tasks define `category` or
`scenario`. Use that table to separate known-ref wins from discovery/file-wide
cases instead of trusting only the overall average.

## Task Format

Each task can include expected answer checks plus strategy hints:

```json
{
  "id": "mcp-read-batch-contract",
  "category": "known-batch",
  "scenario": "known-batch-multi-symbol",
  "prompt": "Explain the MCP read tool's single-ref vs batch-ref behavior.",
  "mapRefs": ["src/mcp/server.ts#TOOLS", "src/mcp/server.ts#dispatch"],
  "nativeHints": ["src/mcp/server.ts"],
  "expected": {
    "requiredSubstrings": ["ref", "refs", "not both", "64"]
  }
}
```

`mapRefs` are intentionally supplied to the map arm so the agent can use the intended "batch all known refs" path. `nativeHints` keep the baseline from wasting turns on unrelated routing. For stricter grading, add `requiredRegex` and `forbiddenRegex`.
