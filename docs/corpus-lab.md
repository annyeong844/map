# Real-repository corpus lab

`corpus:lab` measures code-map against extracted, real repositories without writing an index into
them. Each repository runs in a fresh Node process so its index and parser working set are reclaimed
before the next repository starts.

## Safety contract

- `buildIndex({ force: true })` builds only an in-memory index; the harness never calls `saveIndex`.
- Source metadata for every parseable file and content hashes for a deterministic spread are compared
  before and after each run.
- A missing or existing `.map-index.json` is hashed before and after. It must remain identical.
- Mutation regressions belong in temporary test copies. The real corpus is read-only.
- Worker failures are reported in the bounded JSON result and make the parent exit non-zero.

The metadata check covers code-map's complete source-file universe. The content check samples 16
files; it is a guard against same-size timestamp tricks, not a claim that every corpus byte is hashed.

## Run it

The default root is `$HOME/Downloads/repo/lumin 진화도구`. Override it without committing a personal
absolute path:

```bash
npm run corpus:lab # quick is the default profile
CODE_MAP_CORPUS_ROOT=/path/to/corpus node --expose-gc scripts/corpus-lab.mjs --profile full
node --expose-gc scripts/corpus-lab.mjs --profile stress --out .audit/corpus/next.json
```

With `--out`, the full JSON goes only to that file and stdout stays a one-line summary. Without it,
stdout is the JSON result.

On PowerShell:

```powershell
$env:CODE_MAP_CORPUS_ROOT = 'C:\path\to\corpus'
node --expose-gc scripts/corpus-lab.mjs --profile full --out .audit/corpus/full.json
```

Use the direct Node form when passing options. Some npm/PowerShell combinations consume unknown
`--profile`-style flags before the script sees them; `npm run corpus:lab` itself remains the portable
quick-profile shortcut.

Profiles are deliberately staged:

| Profile  | Default cohort                        | Purpose                                                         |
| -------- | ------------------------------------- | --------------------------------------------------------------- |
| `quick`  | Jadonghwa, Depwire, Hono              | cold/no-op/read correctness smoke                               |
| `full`   | all approved snapshots except Next.js | framework and language diversity plus Fallow differential       |
| `stress` | Next.js                               | largest cold-build and memory case                              |
| `soak`   | Hono, 100 no-op iterations            | long-lived no-op/cache stability without retaining every sample |

Use `--repos a,b`, `--iterations N`, and `--samples N` to override a profile. `--list` reports the
configured cohorts and which direct children currently exist.

## What the result proves

For every repository the JSON records cold time, O(1)-space no-op timing statistics, deterministic
exact-read status counts, process exit state, RSS/heap start/end/peak, source counts, and the safety
fingerprints. A no-op must return the same index object, report zero changed files, and reuse every
file. The `full` profile also compares stable symbol ids across the two Fallow snapshots and emits only
bounded examples.

This harness does **not** by itself prove Oracle/LSP caller completeness, a 24-hour MCP lifetime, or an
exact operating-system peak RSS. Those need their own LSP ground-truth and process-soak runs; the
25 ms memory sampler and `process.resourceUsage()` are useful measurements, not omniscience.
Also, a worker's clean exit proves the lab reclaims its process, not that a long-lived in-process MCP
will immediately return V8/native allocator pages to the operating system. Treat a large cold-build
peak as a real deployment-budget signal even when final `heapUsed` is small.
