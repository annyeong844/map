#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const allowPathPatterns = [
  /^LICENSE$/,
  /^README\.md$/,
  /^README\.ko\.md$/,
  /^GEMINI\.md$/,
  /^package\.json$/,
  /^scripts\/check-package-safety\.mjs$/,
  /^src\/(?:cli|core|mcp)\/[A-Za-z0-9_-]+\.ts$/,
  /^src\/py\/extract\.py$/,
  /^skills\/[A-Za-z0-9_-]+\/SKILL\.md$/,
  /^hooks\/hooks\.json$/,
  /^hooks\/code-map-guard\.mjs$/,
  /^\.claude-plugin\/(?:plugin|marketplace)\.json$/,
  /^\.grok-plugin\/marketplace\.json$/,
  /^\.agents\/plugins\/marketplace\.json$/,
  /^plugins\/code-map\/\.codex-plugin\/plugin\.json$/,
  /^plugins\/code-map\/skills\/[A-Za-z0-9_-]+\/SKILL\.md$/,
];

const denyPathPatterns = [
  /(^|\/)\.env($|[./-])/,
  /(^|\/)\.envrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.codex($|\/)/,
  /(^|\/)\.gemini($|\/)/,
  /(^|\/)\.audit($|\/)/,
  /(^|\/)\.bench($|\/)/,
  /(^|\/)\.aws($|\/)/,
  /(^|\/)\.ssh($|\/)/,
  /(^|\/)\.gnupg($|\/)/,
  /(^|\/)auth\.json$/,
  /(^|\/)config\.toml$/,
  /(^|\/)\.credentials\.json$/,
  /(^|\/)credentials?($|[./])/i,
  /(^|\/)(?:secret|secrets|token|tokens)($|[./-])/i,
];

const secretPatterns = [
  { name: 'OpenAI API key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{20,}\b/g },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g },
  { name: 'npm auth token assignment', re: /(?:^|\n)\s*\/\/[^:\n]+:[^\n]*_authToken\s*=\s*[^\s]+/g },
  {
    name: 'assigned sensitive env var',
    re: /\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY|PRIVATE_KEY)\s*=\s*["']?(?!\s*(?:$|["']|<|YOUR_|your_|REDACTED|redacted|example|placeholder|dummy|test))[^"'\s]{8,}/g,
  },
];

// Windows resolves `npm` to `npm.cmd`; since the CVE-2024-27980 fix, Node
// refuses to spawn a .cmd without a shell. Pass the whole command as a single
// string under a shell — all tokens are static literals, so there is no
// injection surface (and this avoids the DEP0190 shell+args warning).
const pack = spawnSync('npm pack --dry-run --json --ignore-scripts', {
  encoding: 'utf8',
  shell: true,
});

if (pack.status !== 0) {
  process.stderr.write(pack.stderr || pack.stdout || 'npm pack --dry-run failed\n');
  process.exit(pack.status ?? 1);
}

let entries;
try {
  entries = JSON.parse(pack.stdout);
} catch (err) {
  process.stderr.write(`Could not parse npm pack JSON: ${err.message}\n`);
  process.exit(1);
}

const files = entries.flatMap((entry) => entry.files ?? []);
const failures = [];

for (const file of files) {
  const path = file.path;
  if (!allowPathPatterns.some((re) => re.test(path))) {
    failures.push(`unexpected path in package: ${path}`);
  }
  for (const re of denyPathPatterns) {
    if (re.test(path)) failures.push(`blocked path in package: ${path}`);
  }
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  for (const { name, re } of secretPatterns) {
    re.lastIndex = 0;
    if (re.test(text)) failures.push(`${name} pattern in package file: ${path}`);
  }
}

if (failures.length) {
  process.stderr.write('Package safety check failed:\n');
  for (const f of failures) process.stderr.write(`- ${f}\n`);
  process.exit(1);
}

process.stdout.write(`Package safety check passed (${files.length} files).\n`);
