# Code-map Full Audit and Remediation Ledger

Last updated: 2026-07-15
Scope: current working-tree bytes in `C:\Users\endof\.gemini\antigravity\scratch\map`
Checklist: Lumin repository review checklist v2.1
Fresh full artifacts: `.audit/` (generated, intentionally not checked in)

This is the living ledger for the full code-map and code-oracle audit. A checkbox
may be closed only when the implementation, a focused regression test, and the
relevant release checks all agree. Lumin gates are triggers, not verdicts; every
entry below includes the human correction applied to the raw artifact.

## Operating rules

- Fix correctness before structure.
- Preserve output semantics and normal single-request performance.
- Prefer queued admission, cancellation, and reloadable eviction over request
  rejection or arbitrary repository-size caps.
- Never infer absence from an Oracle `count: 0` unless the checker completed
  successfully and the declared coverage supports that conclusion.
- Do not delete a published runtime export until the package surface and external
  compatibility policy are explicit.
- Do not close an orphan/OOM item from unit tests alone; include a spawned-process
  or stress assertion where the lifecycle is part of the contract.

## Baseline

### Fresh structural evidence

- Lumin full profile: 42 files, 16,667 LOC, zero parse errors, 19/19 applicable
  producers complete. Coverage input and CI-only SARIF were the two explicit skips.
- Runtime SCC count: 0; internal dependency edges: 84; resolved cross-submodule
  edges: 39. The inspected directions are consistently leaf/adapter/test to core.
- Exact exported-shape duplicate groups: 0. The four near-shape cues represent
  different lifecycle stages or evidence semantics and remain separate.
- Workspace barrel amplification: not applicable in this single-package scan.
- Textual type escapes (`any`, `as any`, `as unknown as`, `@ts-ignore`,
  `@ts-expect-error`): 0 across the scanned 16,667 LOC.

### Fresh executable evidence

- `npm run release:check`: pass after the full remediation.
- Core tests: 75/75; Oracle tests: 30/30.
- Import boundary check: 41 files, 220 edges, zero violations.
- Root and Oracle audits: zero known vulnerabilities in the verified installs.
- Native Node coverage: core 87.16% line / 81.44% branch / 84.35% function;
  Oracle 90.32% line / 75.57% branch / 95.83% function.
- Full benchmarks pass. Representative results: full build 98.35 ms, no-op
  2.28 ms, warm locate 0.08 ms, 10,000-deep barrel 52.63 ms, mixed 10,000
  names 209.25 ms, and flat 50,000 symbols 123.64 ms. A 10x prepare input
  measured an 11.8x time ratio, consistent with near-linear rather than quadratic
  growth at this scale.

### Live-process observation

The audit did not reproduce an OS-level orphan. It did find three stale installed
Oracle -> tsgo chains that predated the verified source. Their exact command lines,
creation times, and parent/child ownership were captured before retirement; only
those owners and their exact tsgo children were stopped. No Codex, code-map, WSL
host, or unproven process was touched.

The synchronized standalone install then completed a fresh MCP handshake with
runtime build SHA-256
`c61baa52e27423b0ec2a944350b2115cb7800ce1bfd9e5619d940549942ba74c`,
nine runtime source identities, `restartRequired: false`, and clean EOF exit. A
connected WSL client subsequently started a new post-sync Oracle process. One
unrelated `node --input-type=module -` process remains unowned by this audit and was
deliberately left alone; it can add benchmark variance but is not evidence against
code-map.

## Remediation queue

### P0 — correctness and stale-runtime truth

- [x] **P0-01 Reject LSP JSON-RPC errors instead of resolving `undefined`.**
  - Pre-fix evidence: the LSP request handler resolved `parsed.result` without
    inspecting `parsed.error`.
  - Impact: checker failures can become `[]`, then `count: 0`, and may be persisted
    as a successful cached answer.
  - Completion:
    - pending requests reject with an error preserving JSON-RPC code/message/data;
    - the poisoned session is not reused when appropriate;
    - no failed response is written to the answer cache;
    - a fake-LSP regression proves an error cannot become a zero-result answer.
  - Closed 2026-07-15:
    - `LspResponseError` preserves checker code/message/data through the MCP error;
    - valid JSON-RPC method errors reject only their pending request and are never
      cached as successful answers;
    - the false-zero regression sends the same query twice and proves both requests
      reach the fake LSP;
    - the focused regression remains in `code-oracle/test/oracle.test.ts:908`;
    - Oracle 30/30 and full `npm run release:check` pass.

- [x] **P0-02 Add a spawned MCP wire regression for stale reads.**
  - Exercise `read -> edit/reindex -> changedOnly` through real NDJSON stdio, not
    only direct helper calls.
  - Cover native Windows and normalized Windows/WSL root spellings where practical.
  - Completion: the same spawned process observes edited bytes and reports the
    correct changed set.
  - Closed 2026-07-15:
    - `test/map.test.ts:700` exercises `read -> same-length edit -> reindex ->`
      `changedOnly` through real NDJSON stdio;
    - the running process observes the new raw bytes once and then a stable
      unchanged result;
    - Windows/WSL root normalization and global multi-root routing remain covered;
    - full `npm run release:check` passes.

- [x] **P0-03 Make running-version mismatch visible.**
  - Expose the source/package version and a build or install identity in MCP
    initialization/diagnostics.
  - Verify the installed launcher and plugin metadata agree with the repository
    version during package checks.
  - Document that updating files cannot hot-patch already-running MCP processes.
  - Completion: a stale process can be identified from its own response without
    inspecting the Windows process table.
  - Closed 2026-07-15:
    - both MCP initialize responses expose live runtime identity;
    - Oracle reports manifest version, PID/start time, entrypoint, server path,
      source SHA-256 build ID, and `restartRequired` through initialize and ping;
    - a spawned copied-server test modifies its source after startup and proves the
      same process reports the mismatch;
    - root and Oracle lockfile versions are checked against their manifests.

- [x] **P0-04 Synchronize the installed Oracle and retire stale workers safely.**
  - Do not kill an active owner blindly: first capture each running build ID and
    owning MCP session where possible.
  - Sync the verified source/package/lock to the standalone Windows install.
  - Completion: a newly started installed Oracle reports the expected build ID;
    the three pre-update Oracle -> tsgo chains are gone; no unrelated active MCP
    session is terminated.
  - Closed 2026-07-15:
    - `code-oracle/scripts/sync-win.mjs` copies the complete runtime source set,
      manifest, configuration, and lockfile, and removes stale target `.ts` files;
    - the standalone target at `C:\Users\endof\.local\code-oracle-win` installed
      production dependencies with zero audit findings;
    - a fresh installed handshake reported the expected build SHA, all nine runtime
      sources, and `restartRequired: false`, then exited cleanly on EOF;
    - the three verified pre-sync Oracle owners and only their exact tsgo children
      were retired; a live WSL client reconnected to a new post-sync process;
    - unrelated or unowned processes were explicitly left untouched.

- [x] **P0-05 Keep WSL code-map launchers on one native dependency graph.**
  - Field evidence: WSL Codex launched its own `node` against
    `/mnt/c/.../map/src/mcp/server.ts`, whose shared `node_modules` contained the
    Windows Oxc binding but not `@oxc-parser/binding-linux-x64-gnu`. The process
    therefore exited before replying to `initialize`.
  - Closed 2026-07-15:
    - the stale WSL global link into the Windows checkout was replaced by a native
      WSL package install, proving the Linux binding fixes startup;
    - a native WSL `/mnt/c` exact read still measured 27.374 s because of drvfs
      stat cost, while the final Windows-hosted smoke returned the same exact
      symbol in 0.119 s after a 0.513 s initialize;
    - the final WSL Codex configuration therefore runs the Windows package through
      an explicit Windows `node.exe` and Windows `dist/mcp/server.js` path. It does
      not mix a WSL Node with Windows dependencies;
    - the Windows-interop black-box probe reported `platform: win32`, exact source,
      empty protocol stdout contamination, and exit 0 on EOF;
    - Codex setup now compares the existing stdio command/args and performs a real
      initialize preflight instead of treating the server name as proof of health.
      It recognizes native, `cmd.exe`, and explicit Windows-package interop forms;
    - `test/map.test.ts` locks those healthy forms apart from the stale
      `node /mnt/c/.../src/mcp/server.ts` form;
    - field follow-up proved the live session was still owned by the old Linux
      `node /home/endof/.local/bin/map-mcp` child: native `/home/...` succeeded while
      the user-supplied UNC root was rejected. Its parent/command ownership was
      captured before that exact stale child was retired; no unrelated process was
      touched;
    - a Linux-hosted server now maps `\\wsl.localhost\<current-distro>\...` and
      `//wsl$/<current-distro>/...` back to its native path. A different distro stays
      rejected rather than being silently misrouted;
    - the live cross-host smoke then exposed a second fault: Windows Git rejected the
      UNC worktree, so code-map silently fell back to a raw walk (7,307 files / 41,354
      symbols) while native WSL Git selected 1,198 files / 7,784 symbols. The two hosts
      rebuilt the same index back and forth as thousands of false changes;
    - Windows UNC enumeration now delegates `git ls-files` to the named WSL distro.
      The exact field corpus is 1,198 files on both host routes, and a pure command
      regression prevents fallback to Windows Git for WSL UNC roots;
    - the unified Git corpus exposed 37 tracked-but-deleted paths. Git correctly
      listed them from the index, but the drift gate mislabeled their null stats as
      newly added on every call, crossing the adaptive threshold and rebuilding
      forever. Drift scans now exclude null-stat paths from the current corpus and
      count a previously indexed null-stat path as removed exactly once;
    - a real Git regression deletes a staged source and proves two consecutive
      builds settle at `totalChanged = 0`. The field UNC read now reports
      `status: current`, `changed: 0`, and both requested symbols exact;
    - one last cross-host mismatch was timestamp representation, not source drift:
      Windows UNC and native Linux represented the same WSL mtime/ctime up to
      `0.000244140625 ms` apart. Comparisons now tolerate `0.0005 ms` (below one
      microsecond); a regression proves that rounding is stable while a 1 ms ctime
      difference still trips the same-size/restored-mtime guard;
    - the final installed-tarball sequence read the same two exact symbols through
      Windows -> Linux -> Windows. Every route reported `current`, `changed: 0`,
      and the shared index SHA-256 stayed
      `ad108a470d8293fe05a07f6c94fac3a6eb1266e2be749b42e5e7eef11bb4c777`.
      Cold checks were 1.8-4.4 s; the same Windows process then read warm in 26 ms.

### P1 — bounded active work without semantic caps

- [x] **P1-01 Add global active-work admission and stdin backpressure.**
  - Oracle `MAX_SESSIONS` currently evicts idle sessions only; `inUse` sessions for
    distinct roots can exceed it.
  - code-map `autoIndexFlights` and Oracle `queryFlights` are deduplicated per key,
    but unique roots/queries remain unbounded.
  - Completion: excess work waits in a fair queue rather than being rejected;
    normal single-request latency and results remain unchanged; unique-root stress
    proves active scanners/LSPs stay within the configured admission budget.
  - Closed 2026-07-15:
    - code-map and Oracle now use fair, abort-aware FIFO admission queues with
      O(1)-average enqueue, dequeue, and queued cancellation;
    - stdin dispatch is bounded even when `readline` has already buffered multiple
      NDJSON requests, while excess work waits instead of being rejected;
    - six unique code-map roots never exceed two active indexers, and four unique
      Oracle roots never exceed two active LSP sessions;
    - the spawned MCP backpressure regression proves observed active handlers never
      exceed the configured limit;
    - core 75/75, Oracle 30/30, full `npm run release:check`, and the complete
      benchmark suite pass;
    - final normal-path benchmarks show no material regression: full build
      98.35 ms, no-op 2.28 ms, warm locate 0.08 ms, 10,000-deep barrel 52.63 ms,
      and flat 50,000-symbol traversal 123.64 ms.

- [x] **P1-02 Propagate cancellation through every filesystem scan.**
  - `scanIndexDrift`, `listSourceFiles`/`walkFiles`, Oracle `scanProject`, and static
    supplemental scans currently have phases that cannot observe shutdown.
  - Completion: EOF/SIGTERM aborts an active scan promptly; no build, cache write,
    or watcher survives its owning request/process.
  - Closed 2026-07-15:
    - `AbortSignal` now reaches code-map drift/list/build scans and Oracle project,
      static-import, and instantiation scans;
    - cancellation is checked inside traversal loops and before publishing indexes
      or spawning a backend;
    - direct cancellation probes live at `test/map.test.ts:457` and
      `code-oracle/test/oracle.test.ts:1463`;
    - spawned EOF regressions at `test/map.test.ts:834` and
      `code-oracle/test/oracle.test.ts:1290`/`:1334` prove active work and owned LSPs
      are reaped.

- [x] **P1-03 Replace count-only/unbounded caches with byte-weighted LRU.**
  - Bound resident Oracle roots, query results, and source-line text by bytes and
    idle age.
  - Persisted entries may be compacted/pruned; evicted valid answers remain
    reloadable when retained on disk.
  - Completion: cache stress reaches a stable resident-byte plateau without
    changing query results.
  - Closed 2026-07-15:
    - reusable `ByteLru` ownership is isolated in
      `code-oracle/runtime-control.ts:143`;
    - result, source-preview, project-snapshot, and instantiation caches are
      byte-weighted and idle-expiring rather than repository-count limited;
    - evicted persisted answers reload exactly, while an oversized source bypasses
      residency without truncating its returned preview;
    - cache stress and reload regressions pass in
      `code-oracle/test/cache.test.ts:69` and `:190`.

- [x] **P1-04 Harden root and NDJSON trust boundaries.**
  - Require Oracle `file` to be contained by its resolved/real root.
  - Prevent accidental volume-root/home-root traversal unless explicitly opted in.
  - Replace unbounded line buffering with a byte-aware protocol reader and explicit
    oversized-message error.
  - Completion: traversal, symlink escape, drive-root accident, and oversized-line
    tests pass without constraining ordinary repositories.
  - Closed 2026-07-15:
    - Oracle requires absolute resolved roots, rejects accidental home/volume roots
      unless explicitly opted in, and contains both lexical and real file paths;
    - code-map also refuses traversal or symlink escape from an untrusted index
      (`src/core/read.ts:23`, regression `test/map.test.ts:1378`);
    - both MCPs use byte-aware resynchronizing NDJSON decoders and return protocol
      errors for oversized or malformed records;
    - one black-box vector suite exercises both implementations at
      `test/mcp-conformance.test.ts:99`.

- [x] **P1-05 Preserve bounded backend diagnostics.**
  - Capture a bounded stderr tail from tsgo/ty and attach it to timeout/exit/error
    diagnostics without leaking unbounded output.
  - Completion: an induced backend failure explains itself without waiting for an
    opaque timeout.
  - Closed 2026-07-15:
    - `LspSession` retains only the newest 32 KiB of backend stderr
      (`code-oracle/lsp-session.ts:35`);
    - timeout, exit, and protocol failures attach that bounded tail while discarding
      the prefix;
    - the induced 64 KiB stderr regression at
      `code-oracle/test/oracle.test.ts:1200` proves the diagnostic tail survives and
      the process exits cleanly.

### P2 — runtime contracts and reproducibility

- [x] **P2-01 Validate persisted Oracle result shapes.**
  - Validate snapshot entries, JSONL deltas, and cache hits with one
    `isCachedOracleResult` boundary.
  - Invalid records are discarded individually and never spread with `as object`.
  - Closed 2026-07-15:
    - the single validator is `code-oracle/oracle-cache.ts:78`;
    - snapshot, delta, and live hits all pass through it; malformed records are
      dropped independently and additive forward-compatible fields survive;
    - all four focused cache tests pass (`code-oracle/test/cache.test.ts:60-203`).

- [x] **P2-02 Validate handwritten MCP arguments at runtime.**
  - Require every `refs` element to be a non-empty string.
  - Require `changedOnly`, `diagnostics`, and other booleans to be actual booleans.
  - Return JSON-RPC invalid-params errors rather than coercing objects or strings.
  - Closed 2026-07-15:
    - `src/mcp/server.ts:1032` returns a validated argument union and rejects empty
      or non-string refs and non-boolean flags;
    - the Oracle validates tool, root, file, name, and optional fields before any
      path or checker state is touched (`code-oracle/test/oracle.test.ts:369`);
    - wire errors use JSON-RPC `-32602`; no `String(object)` coercion remains.

- [x] **P2-03 Make state contracts discriminated unions.**
  - Tighten `SetupPlan`, `ReadResult`, and `AutoIndexOutcome` so impossible states
    cannot be constructed and non-null assertions are unnecessary.
  - Closed 2026-07-15:
    - `SetupPlan` is a host-discriminated union (`src/cli/setup.ts:17-33`);
    - every `ReadResult` status owns only its valid fields
      (`src/core/types.ts:158-223`);
    - `AutoIndexOutcome` separates successful, skipped, and failed states
      (`src/mcp/server.ts:636-658`);
    - the former `plan.files!` assertion is gone and both TypeScript checks pass.

- [x] **P2-04 Separate I/O, parse, and fallback failures.**
  - Preserve causes for Gemini configuration errors.
  - Surface parser/project-scan degradation in results that claim project scope.
  - Make package-safety file-read failures fail closed.
  - Closed 2026-07-15:
    - Gemini setup distinguishes read, JSON syntax, and root-shape failures while
      preserving causes (`test/map.test.ts:133`);
    - catastrophic Oxc parse failure throws with cause instead of manufacturing an
      empty parse, and package-safety reads fail closed;
    - Oracle project/static/location/preview failures are returned as bounded
      `incomplete: true` degradation evidence and degraded results are not cached;
    - the induced deletion regression at `code-oracle/test/oracle.test.ts:990`
      proves a project-scope failure cannot masquerade as complete zero evidence.

- [x] **P2-05 Pin every executed toolchain dependency.**
  - Move Oracle TS5 and `@types/node` into the Oracle lockfile at exact versions.
  - Pin/manage the default `ty` launcher rather than executing an unversioned
    `uvx ty server`.
  - Ensure CI audits the dev tools it actually executes.
  - Closed 2026-07-15:
    - Oracle locks exact `typescript` 5.9.3 and `@types/node` 22.19.21 dev
      dependencies and invokes its local compiler;
    - the default Python backend is exactly
      `uvx --no-config --from ty==0.0.50 ty server`, while explicit `TY_BIN`/`TY_CMD`
      overrides remain supported;
    - CI/release checks audit and execute the same locked tool graph.

- [x] **P2-06 Add a compact model-facing read response without weakening evidence.**
  - Preserve raw source, safety status, coordinates, notes, aim, ambiguity candidates,
    auto-index retry, and working-set delta semantics.
  - Keep the existing JSON result as the compatibility default; compact mode must be
    explicit and additive.
  - Closed 2026-07-15:
    - `responseFormat: "compact"` removes repeated object keys and redundant file
      metadata while retaining short symbol-labelled source sections;
    - the user's representative two-symbol read fell from 2,453 to 2,144 response
      bytes (12.6%). Source bytes dominate, so no larger claim is made;
    - focused regressions cover batch ordering, delta baselines, argument rejection,
      and requested-missing-symbol auto-index retry in compact mode;
    - the validated Codex plugin was reinstalled at
      `0.9.0-rc.1+codex.20260715140908`; its cached retrieval skill now explicitly
      requests compact output for ordinary model-facing reads.

### P3 — structure after behavior is locked

- [x] **P3-01 Split the 2,795-LOC Oracle god-file along existing responsibilities.**
  - Candidate internal modules: static analysis, LSP framing/session, project scan,
    result cache, query orchestration, and MCP transport.
  - Preserve the current external tool surface; do not add owner/contract/policy
    ceremony merely to reduce LOC.
  - Closed 2026-07-15:
    - `code-oracle/server.ts` fell from 2,795 to 1,589 physical lines and now owns
      only MCP/query orchestration, coverage assembly, and cache coordination;
    - stable responsibilities moved to `lsp-backend.ts`, `lsp-session.ts`,
      `lsp-session-pool.ts`, `static-import-supplement.ts`, `oracle-cache.ts`,
      `project-snapshot.ts`, `runtime-control.ts`, and `mcp-ndjson.ts`;
    - framing/process/sync/readiness deliberately remain together in `LspSession`;
      splitting them would create forwarding and lifecycle ambiguity, not SRP;
    - import-owner tests and the 41-file/220-edge boundary checker lock the new
      direction without introducing public ceremony.

- [x] **P3-02 Add one black-box MCP conformance suite for both servers.**
  - Reuse request vectors and expected wire behavior without forcing the lightweight
    code-map server and heavyweight Oracle into one runtime package.
  - Closed 2026-07-15: `test/mcp-conformance.test.ts:99` spawns both servers against
    the same byte-split, packed, malformed, oversized, and resynchronization vectors.

- [x] **P3-03 Decide the published deep-import policy.**
  - `packageRoot`, `lineAt`, and `offsetOfLine` are internally unconsumed but appear
    in shipped `dist` files while the package has no `exports` map.
  - Keep them until compatibility is measured or close the package surface through
    an explicit versioned policy.
  - Closed 2026-07-15: both READMEs now state that, while the RC intentionally has
    no `exports` map, emitted `dist/` modules and named exports are compatibility
    surface. Restriction requires a documented versioned breaking release and
    migration notes; repository-local dead-export evidence cannot authorize it.

- [x] **P3-04 Review large cohesive functions without LOC-driven splitting.**
  - `computeFanIn`, `buildIndex`, CLI `main`, Oracle `query`, and `extractSymbols`
    triggered size gates.
  - Split only where a stable responsibility/test seam exists. `computeFanIn` in
    particular is a cohesive optimized algorithm and is not a refactor target merely
    because it is long.
  - Closed 2026-07-15:
    - all five Lumin size triggers were read in full: `computeFanIn` (313 LOC),
      `buildIndex` (294), CLI `main` (233), Oracle `query` (189), and
      `extractSymbols` (153);
    - each is one algorithm or request/CLI orchestration transaction with shared
      local state and a stable outer test seam;
    - no further extraction was made solely to satisfy LOC. This is a deliberate
      `fix` -> `watch/keep` correction, not an ignored gate.

## Corrected machine findings

- Lumin's cross-submodule ratio is 39/84 (0.464), but the dominant directions are
  test/script/MCP/CLI -> core. That is healthy leaf-to-core layering, not a
  decoupling failure.
- Lumin marked boundary lint evidence degraded because it cannot model the custom
  checker. The executable source of truth passes 41 files and 220 edges, while
  regressions reject unknown owners, forbidden crossings, and bypasses.
- The raw dead plan reports 28 `SAFE_FIX`, but root `src/*` exports are emitted to
  shipped `dist/*` and the package intentionally has no `exports` map. Those are
  package-surface false positives, not deletion authority.
- The five exact body-clone groups are tiny local guards, character predicates, or
  runtime-specific path/identity helpers. Centralizing them would create a generic
  util dependency across otherwise clean owners; they remain intentional local
  duplication.
- Four near-shape pairs model different evidence semantics, persistence/runtime
  identity, optionality, or pipeline stages. They are not shared-contract drift.
- The five large functions are cohesive algorithms/orchestrators. Their raw `fix`
  gate is retained as a review trigger and downgraded to `watch/keep` after full
  body review.
- Empty silent catches are zero. Remaining documented/anonymous catches are mostly
  availability probes, cache cleanup, or lifecycle fallback; required-workflow
  failures were fixed and now surface causes or degradation.
- `typescript`, `oxlint-tsgolint`, and pinned `ty` are executed tooling, not unused
  dependencies. Python stdlib resolver misses and method precision remain declared
  Lumin/tool blind zones, not code-map dead-code proof.

## A-H verdict ledger

| Axis                    | Verdict       | Current reason                                                              |
| ----------------------- | ------------- | --------------------------------------------------------------------------- |
| A — size/simplicity     | Watch/keep    | God-file split is complete; five cohesive cores were reviewed, not chopped. |
| B — duplication/shapes  | Healthy/watch | No exact shape drift; local micro-duplication preserves clean ownership.    |
| C — cohesion/boundaries | Healthy       | Runtime SCC 0; 41-file/220-edge boundary enforcement passes.                |
| D — types/contracts     | Healthy/watch | Zero textual escapes; runtime inputs and state unions are now explicit.     |
| E — failure handling    | Healthy/watch | Checker failures/degradation surface; remaining catches are bounded probes. |
| F — abstraction/tests   | Healthy       | 105 tests plus shared wire/lifecycle regressions cover the changed seams.   |
| G — security/operations | Healthy/watch | Roots, bytes, work, caches, diagnostics, and tool versions are bounded.     |
| H — ceremony            | Healthy       | No ceremony stack; package compatibility policy is now explicit.            |

## Close-out gate

- [x] Every P0-P2 item is closed with focused regression evidence.
- [x] Every P3 decision is implemented or explicitly retained after body-level
      review; no LOC-only or machine-score-only refactor remains.
- [x] `npm run release:check` passes from a fresh package build: 75 core tests,
      30 Oracle tests, both type checks, formatting, syntax/typed/review lint, version
      contract, package safety, and TS/Python CLI+MCP smoke.
- [x] Native coverage improved to 87.16% core and 90.32% Oracle line coverage;
      branch/function values are recorded above rather than hidden.
- [x] Stress and benchmark suites pass without a semantic repository cap or
      material normal-path regression.
- [x] Installed-package smoke proves the synchronized runtime build identity and
      clean EOF lifecycle.
- [x] Process inspection found no surviving test-owned backend; stale verified
      owners were retired without touching unrelated processes.
- [x] Fresh Lumin full artifacts were read at raw-value level and every triggered
      gate was either fixed or corrected with a recorded rationale.
- [x] Final code-map rebuild indexed 796 symbols across 42 files. The compact,
      UNC-bridge, Git-routing, and drift helpers are present in the current index;
      cross-host field reads returned exact source without rewriting their shared
      index.

Status: remediation complete on the current working-tree bytes. Re-run the full
profile after future structural changes; generated `.audit/` artifacts are evidence,
while this checked-in ledger is the durable decision record.
