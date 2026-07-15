#!/usr/bin/env node
// code-map routing guard — Claude Code PreToolUse hook.
//
// A loaded SKILL.md decays over a long session: attention dilutes and the agent
// regresses to grep/cat/sed for reading code instead of the code-map `read` tool.
// A skill can't keep enforcing itself. This hook re-injects the routing rule at the
// moment of regression — non-blocking (permissionDecision: "allow" + additionalContext),
// throttled so it nudges periodically (a "specific turn"), not on every command.
//
// Every error path fails open; a non-match also lets the tool call proceed.
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
  for (;;) {
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
try { last = Number(JSON.parse(readFileSync(state, 'utf8')).last) || 0; } catch { /* absent/corrupt throttle state means no prior reminder */ }
const now = Date.now();
if (now - last < WINDOW_MS) proceed();
try { writeFileSync(state, JSON.stringify({ last: now })); } catch { /* fail open when throttle persistence is unavailable */ }

const reminder = bodyRead
  ? 'code-map routing — this repo is indexed (.map-index.json). Read a known symbol body with the code-map `read` tool (by `path#name` or id), not cat/sed/head/tail: `read` re-anchors when the file has drifted and returns just the symbol. For several known refs, make one batched `read` (refs: [...]). Do not shell-read a body you can fetch by coordinate.'
  : "code-map routing — this repo is indexed (.map-index.json). The code-map `read` tool resolves a bare symbol name or `path#name` directly. If you ALREADY KNOW which symbol you want, call `read <name>` (or one batched `read` for several) and SKIP this grep — grepping first to locate a name you already know is the redundant double-call this routing removes. Use grep ONLY to discover a name you genuinely don't know yet; once you have it, read the body with `read`, never with grep/cat. Answer from `read`'s bytes, not grep snippets.";

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
