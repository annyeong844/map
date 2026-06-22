#!/usr/bin/env node
// code-map routing guard — Claude Code PreToolUse hook.
//
// A loaded SKILL.md decays over a long session: attention dilutes and the agent
// regresses to grep/cat/sed for reading code instead of the code-map `read` tool.
// A skill can't keep enforcing itself. This hook re-injects the routing rule at the
// moment of regression — non-blocking (permissionDecision: "allow" + additionalContext),
// throttled so it nudges periodically (a "specific turn"), not on every command.
//
// Fail-open everywhere: any error or non-match just lets the tool call proceed.
// Inert outside code-map repos (gated on a .map-index.json above the cwd).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const proceed = () => process.exit(0); // never break the user's tool call

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  try { raw = readFileSync('/dev/stdin', 'utf8'); } catch { proceed(); }
}
let data;
try { data = JSON.parse(raw); } catch { proceed(); }

const tool = data?.tool_name || '';
const cmd = typeof data?.tool_input?.command === 'string' ? data.tool_input.command : '';
const cwd = data?.tool_input?.cwd || data?.cwd || process.cwd();
const session = String(data?.session_id || 'nosession').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

// Gate 1 — only act inside a code-map-indexed repo. Walk up for .map-index.json.
function indexed(dir) {
  let d = dir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, '.map-index.json'))) return true;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return false;
}
if (!indexed(cwd)) proceed();

// Gate 2 — is this a shell code read/scan we route differently?
const SRC = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|pyi)\b/;
const isGrepTool = tool === 'Grep';
const bodyRead = tool === 'Bash' && /\b(?:cat|sed|head|tail|awk)\b/.test(cmd) && SRC.test(cmd);
const discovery = isGrepTool || (tool === 'Bash' && /\b(?:grep|rg|ack|ag)\b/.test(cmd));
if (!bodyRead && !discovery) proceed();

// Throttle — re-inject at most once per window per session (periodic, not every turn).
const WINDOW_MS = 90_000;
const state = join(tmpdir(), `code-map-guard-${session}.json`);
let last = 0;
try { last = Number(JSON.parse(readFileSync(state, 'utf8')).last) || 0; } catch {}
const now = Date.now();
if (now - last < WINDOW_MS) proceed();
try { writeFileSync(state, JSON.stringify({ last: now })); } catch {}

const reminder = bodyRead
  ? 'code-map routing — this repo is indexed (.map-index.json). Read a known symbol body with the code-map `read` tool (by `path#name` or id), not cat/sed/head/tail: `read` re-anchors when the file has drifted and returns just the symbol. For several known refs, make one batched `read` (refs: [...]). Do not shell-read a body you can fetch by coordinate.'
  : "code-map routing — this repo is indexed (.map-index.json). Using grep to DISCOVER names/lines is correct. Once it finds a name, read the body with the code-map `read` tool (one batched call for multiple refs) — do not add a second grep/cat on top to read the body, and do not re-grep to assemble refs. Answer from `read`'s raw bytes, not from grep snippets.";

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: reminder,
    },
  }),
);
process.exit(0);
