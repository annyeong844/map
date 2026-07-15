# code-map — agent rules (Antigravity / Gemini)

> Antigravity & Gemini read this file as rules (workspace `GEMINI.md`; global `~/.gemini/GEMINI.md`).
> It mirrors `skills/code-map-retrieval/SKILL.md` (the cross-tool skill for Claude Code / grok / Codex).
> Applies when a `code-map` / `map-mcp` `read` tool is available and the repo has a `.map-index.json`.

**grep finds, code-map `read` reads.** `read` returns the exact bytes of one symbol (by id or
`path#name`), drift-resistant. It does **not** search.

- **Refs already known** → one `read` with `refs: [all]`. Don't grep first; don't `cat`/`sed` bodies.
- **Must discover where something is** → grep/rg. If grep already answers, **answer and stop** —
  do **not** add a `read` on top, and don't keep grepping just to assemble refs for a batch read.
- **grep gave a name but not the body** → escalate to **one** `read` for that symbol.
- **Never fetch the same target twice** (grep + read). Pick the single cheaper path.
- **Refresh after edits** → one `read` with `refs: [working set]`, `changedOnly: true`; trust the
  `unchanged` list, don't re-read or re-grep. The MCP compares with its prior returned bytes even
  across an index rebuild; refs without a session baseline are returned conservatively.
- **Always pass the absolute repo `root`.** A Windows-hosted MCP can use `C:\...` or `/mnt/c/...`;
  for native WSL ext4 use the repo's `\\wsl.localhost\<distro>\...` UNC path. Keep `ref`
  repository-relative.
- **Missing/stale state** → current servers lazily create missing/incompatible indexes, rebuild
  large drift on the next read, and rebuild small drift when a requested symbol is missing. Retry
  with the correct `root` and `diagnostics: true` before running `map index`. Index bytes hot-reload;
  MCP code/config does not. If `restartRequired` is true, the reported server path is wrong, or
  diagnostics are absent, start a new MCP session. A never-returned ref reported as `unchanged`
  likewise means this process is stale; restart and make a normal `read`.

Reading **known** symbols is the win. On pure **discovery**, grep alone wins — the double-call
(grep to find _and_ read on top) loses; the rules above are what keep discovery a win.

**Who-calls / where-defined / what-implements:** grep drowns on common names. If the type-aware
sibling **code-oracle** is available (`callers`/`definition`/`implementations`; tsgo for TS/JS,
ty for Python), escalate to it for a **common/colliding** name in a **large** repo (checker-grade,
~31 %/40–75 % fewer files than grep) — it warms once (~seconds–20 s by repo size), so for a tiny
repo or a distinctive name, just grep. Dynamic dispatch is invisible (read by hand); ty is intra-file.
Trust code-oracle's structured `coverage`, not the label alone. For TS/JS implementations, read
`likely` entries first but keep every `possible` result; `new` / `useClass` hints are static source
evidence, never proof that an implementation ran.
