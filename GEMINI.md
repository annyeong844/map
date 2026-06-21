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
  `unchanged` list, don't re-read or re-grep.

Reading **known** symbols is the win. On pure **discovery**, grep alone wins — the double-call
(grep to find *and* read on top) loses; the rules above are what keep discovery a win.
