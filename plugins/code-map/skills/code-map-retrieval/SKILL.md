---
name: code-map-retrieval
description: >
  How to read code efficiently in a repo indexed by code-map (a `.map-index.json`
  is present, or a `code-map` / `map-mcp` MCP server is available). Use whenever you
  inspect, navigate, or pull the body of a function/class/symbol — to choose between
  grep (search) and code-map `read` (pull exact slices) and to avoid the double-call
  that wastes tokens on discovery. Triggers: reading a known symbol, batch-reading
  several symbols, refreshing reads after edits, "where is X", "show me the body of X".
metadata:
  short-description: "grep finds, code-map read reads — routing for token-efficient retrieval"
---

# code-map retrieval routing

code-map's `read` returns the **exact bytes of one symbol** (a function/method/class body —
not the whole file), by id or by name / `path#name`. It is **drift-resistant**: if the file
moved since indexing it re-anchors on the signature line and flags the result; if the anchor
is lost it says so. It does **not search** — grep does the finding, `read` does the reading.

## Decision rule

1. **You already know the refs/names** (the task names them, or you have them from a prior step)
   → make **one** `read` with `refs: [all of them]`. Do **not** grep first; do **not** `cat`/`sed`/`nl`
   the bodies. One round-trip, exact slices, still correct after edits.

2. **You must discover where something lives**
   → use **grep / rg**. If grep's output already answers the question, **answer from it and stop.**
   Do **not** follow up with a `read`, and do **not** keep grepping just to assemble refs for a batch read.

3. **grep gave you a name/ref but not the body you need**
   → escalate to **one** `read` for that symbol. That is the only time discovery should touch code-map.

4. **Never fetch the same target twice** — once by grep, once by `read`. Pick the single cheaper path.

5. **Refreshing reads after the code changed**
   → one `read` with `refs: [your working set]` and `changedOnly: true`. It returns current slices
   only for symbols whose file changed, plus an `unchanged` id list — a "git status for your reads."
   Don't re-read the unchanged ones; don't re-grep the tree.

## Why this matters (measured)

- Reading **known** symbols is the strong win: code-map sharply cuts retrieved tokens and tool
  calls (cross-file and single-symbol the most) and stays correct after drift.
- **Discovery** is where the tool can backfire: if you grep to *find* and then `read` the full
  body *on top*, you pay twice and lose to plain grep. Rule 2 is what keeps discovery a win rather
  than a loss. In a 3-arm benchmark, adding exactly this routing flipped discovery from
  ~break-even/loss to a clear win and improved known-ref efficiency too — same tool, better routing.

## Limits (be honest)

- code-map does **not** beat grep at *searching* — it ties. Keep grepping to find.
- `read` resolves a name to **one** symbol; if a name is ambiguous, pass `path#name` or a precise id.
- Batch only **independent** refs you already know (up to 64 per call). Use a single sequential
  `read` when a later read depends on what an earlier one shows.
- With `snippet`, `aim.status: "ambiguous"` means your quoted text occurs more than once — don't
  target blindly.

Coordinates, not meaning: pull the raw slice and judge it yourself.
