#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function buildRequirements(root, manifest) {
  return [
    {
      name: 'typescript',
      path: resolve(root, 'node_modules', 'typescript', 'bin', 'tsc'),
      version: manifest.devDependencies?.typescript,
    },
    {
      name: '@types/node',
      path: resolve(root, 'node_modules', '@types', 'node', 'package.json'),
      version: manifest.devDependencies?.['@types/node'],
    },
    {
      name: 'oxc-parser',
      path: resolve(root, 'node_modules', 'oxc-parser', 'package.json'),
      version: manifest.dependencies?.['oxc-parser'],
    },
  ];
}

function preparePackage() {
  // Registry tarballs already contain dist. Git dependencies do not.
  if (existsSync(resolve(projectRoot, 'dist', 'cli', 'main.js'))) return 0;

  const manifest = JSON.parse(
    readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
  );
  const requirements = buildRequirements(projectRoot, manifest);
  const missing = requirements.filter(
    (requirement) => !existsSync(requirement.path),
  );

  if (missing.length > 0) {
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !existsSync(npmCli)) {
      throw new Error(
        `Cannot build a Git install: missing ${missing.map(({ name }) => name).join(', ')} and npm_execpath is unavailable.`,
      );
    }

    const packageSpecs = missing.map(({ name, version }) => {
      if (!version) {
        throw new Error(
          `Missing package.json version for build dependency ${name}.`,
        );
      }
      return `${name}@${version}`;
    });
    const bootstrap = spawnSync(
      process.execPath,
      [
        npmCli,
        'install',
        '--ignore-scripts',
        '--no-save',
        '--package-lock=false',
        '--global=false',
        '--location=project',
        '--no-audit',
        '--no-fund',
        '--prefix',
        projectRoot,
        ...packageSpecs,
      ],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          npm_config_global: 'false',
          npm_config_location: 'project',
          npm_config_prefix: projectRoot,
        },
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    if (bootstrap.error) throw bootstrap.error;
    if (bootstrap.status !== 0) return bootstrap.status ?? 1;

    const stillMissing = requirements.filter(
      (requirement) => !existsSync(requirement.path),
    );
    if (stillMissing.length > 0) {
      throw new Error(
        `Git install bootstrap completed without ${stillMissing.map(({ name }) => name).join(', ')}.`,
      );
    }
  }

  const build = spawnSync(
    process.execPath,
    [resolve(projectRoot, 'scripts', 'build.mjs')],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (build.error) throw build.error;
  return build.status ?? 1;
}

process.exitCode = preparePackage();
