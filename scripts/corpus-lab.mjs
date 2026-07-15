#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  CORPUS_PROFILES,
  DEFAULT_CORPUS_ROOT,
  DIFFERENTIAL_PAIR,
  profileNamed,
} from './corpus-lab-config.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workerPath = resolve(scriptDirectory, 'corpus-lab-worker.mjs');

function usage() {
  return `Read-only real-repository validation for code-map.

Usage:
  node --expose-gc scripts/corpus-lab.mjs [options]

Options:
  --profile <quick|full|stress|soak>  Cohort and default iteration count
  --root <directory>                  Corpus parent (or CODE_MAP_CORPUS_ROOT)
  --repos <name,name>                 Override the profile's direct child names
  --iterations <positive integer>     No-op rebuilds per repository
  --samples <positive integer>        Deterministic exact reads per repository
  --differential                      Compare the two Fallow snapshots
  --no-differential                   Skip the profile's differential comparison
  --out <file.json>                   Also write the bounded JSON result
  --list                              Show profiles and available corpus children
  --help                              Show this help

The source repositories are never indexed on disk. Each build runs in a fresh
worker process and fingerprints source metadata/content plus .map-index.json
before and after the run.
`;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} needs a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    profile: 'quick',
    root: process.env.CODE_MAP_CORPUS_ROOT ?? DEFAULT_CORPUS_ROOT,
    repositories: null,
    iterations: null,
    samples: null,
    differential: null,
    out: null,
    list: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) {
        throw new Error(`${flag} needs a value.`);
      }
      return next;
    };
    if (flag === '--profile') {
      options.profile = value();
    } else if (flag === '--root') {
      options.root = value();
    } else if (flag === '--repos') {
      options.repositories = value()
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    } else if (flag === '--iterations') {
      options.iterations = positiveInteger(value(), flag);
    } else if (flag === '--samples') {
      options.samples = positiveInteger(value(), flag);
    } else if (flag === '--differential') {
      options.differential = true;
    } else if (flag === '--no-differential') {
      options.differential = false;
    } else if (flag === '--out') {
      options.out = value();
    } else if (flag === '--list') {
      options.list = true;
    } else if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function directChild(root, name) {
  if (!name || isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    throw new Error(`Repository must be a direct child name: ${name}`);
  }
  const path = resolve(root, name);
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Repository escapes the corpus root: ${name}`);
  }
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Corpus repository is missing: ${path}`);
  }
  return path;
}

function availableChildren(root) {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const known = new Set(
    Object.values(CORPUS_PROFILES).flatMap((profile) => profile.repositories),
  );
  return [...known].filter((name) => {
    const path = resolve(root, name);
    return existsSync(path) && statSync(path).isDirectory();
  });
}

function runWorker(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return new Promise((resolveWorker) => {
    const started = performance.now();
    const child = spawn(
      process.execPath,
      ['--expose-gc', workerPath, encoded],
      {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      resolveWorker({
        status: 'failed',
        error: error.message,
        process: { cleanExit: false, wallMs: performance.now() - started },
      });
    });
    child.on('close', (code, signal) => {
      let message;
      try {
        message = JSON.parse(stdout.trim());
      } catch {
        message = null;
      }
      const processResult = {
        cleanExit: code === 0 && signal === null,
        exitCode: code,
        signal,
        wallMs: Number((performance.now() - started).toFixed(2)),
      };
      if (message?.ok && processResult.cleanExit) {
        resolveWorker({ ...message.result, process: processResult });
      } else {
        resolveWorker({
          status: 'failed',
          error:
            message?.error?.message ||
            stderr.trim() ||
            stdout.trim() ||
            `Worker exited with code ${code}.`,
          stack: message?.error?.stack,
          process: processResult,
        });
      }
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const root = resolve(options.root);
  if (options.list) {
    process.stdout.write(
      `${JSON.stringify(
        {
          root,
          profiles: CORPUS_PROFILES,
          available: availableChildren(root),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Corpus root is missing: ${root}`);
  }

  const profile = profileNamed(options.profile);
  const repositoryNames = options.repositories ?? profile.repositories;
  if (!repositoryNames.length) {
    throw new Error('No corpus repositories selected.');
  }
  const repositoryPaths = repositoryNames.map((name) =>
    directChild(root, name),
  );
  const noOpIterations = options.iterations ?? profile.noOpIterations;
  const readSamples = options.samples ?? profile.readSamples;
  const differential = options.differential ?? profile.differential;
  if (
    differential &&
    !DIFFERENTIAL_PAIR.every((name) => repositoryNames.includes(name))
  ) {
    throw new Error(
      `Differential mode needs both: ${DIFFERENTIAL_PAIR.join(', ')}.`,
    );
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const repositories = [];
  for (let index = 0; index < repositoryNames.length; index++) {
    const name = repositoryNames[index];
    process.stderr.write(`[${index + 1}/${repositoryNames.length}] ${name}\n`);
    const result = await runWorker({
      kind: 'repository',
      name,
      root: repositoryPaths[index],
      noOpIterations,
      readSamples,
    });
    repositories.push({ name, ...result });
  }

  let differentialResult = null;
  if (differential) {
    process.stderr.write(`[diff] ${DIFFERENTIAL_PAIR.join(' → ')}\n`);
    differentialResult = await runWorker({
      kind: 'differential',
      names: DIFFERENTIAL_PAIR,
      roots: DIFFERENTIAL_PAIR.map((name) => directChild(root, name)),
    });
  }

  const repositoryFailures = repositories.filter(
    (result) => result.status !== 'passed',
  ).length;
  const differentialFailures =
    differentialResult && differentialResult.status !== 'passed' ? 1 : 0;
  const failed = repositoryFailures + differentialFailures;
  const result = {
    schemaVersion: 1,
    profile: options.profile,
    corpusRoot: root,
    startedAt,
    durationMs: Number((performance.now() - started).toFixed(2)),
    options: { noOpIterations, readSamples, differential },
    summary: {
      repositories: repositories.length,
      passed: repositories.length - repositoryFailures,
      failed: repositoryFailures,
      differentialFailed: differentialFailures === 1,
    },
    repositories,
    differential: differentialResult,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      gcExposed: typeof global.gc === 'function',
    },
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) {
    const outputPath = resolve(options.out);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, json);
    let differentialStatus = 'skipped';
    if (differential) {
      differentialStatus = result.summary.differentialFailed
        ? 'failed'
        : 'passed';
    }
    process.stdout.write(
      `Corpus lab: ${result.summary.passed}/${result.summary.repositories} repositories passed; ` +
        `differential ${differentialStatus}; ` +
        `${result.durationMs.toFixed(0)} ms; ${outputPath}\n`,
    );
  } else {
    process.stdout.write(json);
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
