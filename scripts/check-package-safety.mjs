#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const allowPathPatterns = [
  /^LICENSE$/,
  /^README\.md$/,
  /^package\.json$/,
  /^bench\/codex-headless\/(?:README\.md|AGENTS\.code-map\.md|tasks\.(?:example|diverse)\.json)$/,
  /^scripts\/(?:bench-codex-headless|check-package-safety)\.mjs$/,
  /^src\/(?:cli|core|mcp)\/[A-Za-z0-9_-]+\.ts$/,
  /^src\/py\/extract\.py$/,
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

const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
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
