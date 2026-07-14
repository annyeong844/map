#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const pkg = json('package.json');
const lock = json('package-lock.json');
const claude = json('.claude-plugin/plugin.json');
const codex = json('plugins/code-map/.codex-plugin/plugin.json');

const failures = [];
if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
  failures.push(`package-lock version does not match package.json (${pkg.version})`);
}
if (claude.version !== pkg.version) failures.push(`Claude plugin is ${claude.version}, expected ${pkg.version}`);
if (codex.version.split('+')[0] !== pkg.version) {
  failures.push(`Codex plugin is ${codex.version}, expected core ${pkg.version}`);
}

if (failures.length) {
  process.stderr.write(`Version contract failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Version contract passed (${pkg.version}).\n`);
