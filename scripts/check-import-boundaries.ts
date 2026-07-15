#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync, Visitor } from 'oxc-parser';

type Owner =
  | 'core'
  | 'version'
  | 'cli'
  | 'mcp'
  | 'oracle-entry'
  | 'oracle-wire'
  | 'oracle-backend'
  | 'oracle-session'
  | 'oracle-pool'
  | 'oracle-static'
  | 'oracle-cache'
  | 'oracle-project'
  | 'oracle-runtime'
  | 'oracle-script'
  | 'oracle-test'
  | 'script'
  | 'hook'
  | 'test';

export interface BoundaryViolation {
  file: string;
  line: number;
  message: string;
}

export interface BoundaryReport {
  filesChecked: number;
  edgesChecked: number;
  violations: BoundaryViolation[];
}

interface ImportReference {
  specifier: string | null;
  offset: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const SCAN_ROOTS = ['src', 'code-oracle', 'scripts', 'hooks', 'test'];

// This is intentionally default-deny. Adding a new owner or dependency requires
// changing the matrix, so a new path cannot silently become everybody's utility.
const INTERNAL_ALLOW: Readonly<Record<Owner, ReadonlySet<Owner>>> = {
  core: new Set(['core']),
  version: new Set(['version']),
  cli: new Set(['cli', 'core', 'version']),
  mcp: new Set(['mcp', 'core', 'version']),
  'oracle-entry': new Set([
    'oracle-entry',
    'oracle-wire',
    'oracle-backend',
    'oracle-session',
    'oracle-pool',
    'oracle-cache',
    'oracle-project',
    'oracle-runtime',
  ]),
  'oracle-wire': new Set(['oracle-wire']),
  'oracle-backend': new Set(['oracle-backend', 'oracle-project']),
  'oracle-session': new Set([
    'oracle-session',
    'oracle-backend',
    'oracle-project',
    'oracle-static',
  ]),
  'oracle-pool': new Set([
    'oracle-pool',
    'oracle-backend',
    'oracle-session',
    'oracle-project',
    'oracle-runtime',
  ]),
  'oracle-static': new Set(['oracle-static', 'oracle-project']),
  'oracle-cache': new Set(['oracle-cache', 'oracle-runtime']),
  'oracle-project': new Set(['oracle-project', 'oracle-runtime']),
  'oracle-runtime': new Set(['oracle-runtime']),
  'oracle-script': new Set(['oracle-script']),
  'oracle-test': new Set([
    'oracle-test',
    'oracle-entry',
    'oracle-wire',
    'oracle-backend',
    'oracle-session',
    'oracle-pool',
    'oracle-static',
    'oracle-cache',
    'oracle-project',
    'oracle-runtime',
  ]),
  script: new Set(['script', 'core', 'version']),
  hook: new Set(['hook']),
  test: new Set(['test', 'core', 'version', 'cli', 'mcp', 'script']),
};

const EXTERNAL_ALLOW: Readonly<Record<Owner, ReadonlySet<string>>> = {
  core: new Set(['oxc-parser']),
  version: new Set(),
  cli: new Set(),
  mcp: new Set(),
  'oracle-entry': new Set(),
  'oracle-wire': new Set(),
  'oracle-backend': new Set(),
  'oracle-session': new Set(),
  'oracle-pool': new Set(),
  'oracle-static': new Set(['oxc-parser']),
  'oracle-cache': new Set(),
  'oracle-project': new Set(),
  'oracle-runtime': new Set(),
  'oracle-script': new Set(),
  'oracle-test': new Set(),
  script: new Set(['oxc-parser']),
  hook: new Set(),
  test: new Set(),
};

function repoPath(root: string, absolutePath: string): string | null {
  const path = relative(root, absolutePath);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    return null;
  }
  return path.replaceAll(sep, '/');
}

function ownerFor(path: string): Owner | null {
  if (path === 'src/version.ts') return 'version';
  if (path.startsWith('src/core/')) return 'core';
  if (path.startsWith('src/cli/')) return 'cli';
  if (path.startsWith('src/mcp/')) return 'mcp';
  if (path.startsWith('code-oracle/test/')) return 'oracle-test';
  if (path.startsWith('code-oracle/scripts/')) return 'oracle-script';
  if (path === 'code-oracle/server.ts') return 'oracle-entry';
  if (path === 'code-oracle/mcp-ndjson.ts') return 'oracle-wire';
  if (path === 'code-oracle/lsp-backend.ts') return 'oracle-backend';
  if (path === 'code-oracle/lsp-session.ts') return 'oracle-session';
  if (path === 'code-oracle/lsp-session-pool.ts') return 'oracle-pool';
  if (path === 'code-oracle/static-import-supplement.ts') {
    return 'oracle-static';
  }
  if (path === 'code-oracle/oracle-cache.ts') return 'oracle-cache';
  if (path === 'code-oracle/project-snapshot.ts') return 'oracle-project';
  if (path === 'code-oracle/runtime-control.ts') return 'oracle-runtime';
  if (path.startsWith('scripts/')) return 'script';
  if (path.startsWith('hooks/')) return 'hook';
  if (path.startsWith('test/')) return 'test';
  return null;
}

function listSourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'dist' && entry.name !== 'node_modules') {
          pending.push(path);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name)) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

function importReferences(
  file: string,
  text: string,
  lineStarts: number[],
): {
  references: ImportReference[];
  parseErrors: BoundaryViolation[];
} {
  const parsed = parseSync(file, text);
  const references: ImportReference[] = [];
  const parseErrors: BoundaryViolation[] = parsed.errors.map((error) => ({
    file,
    line: lineAt(lineStarts, error.labels[0]?.start ?? 0),
    message: `Oxc could not parse this boundary source: ${error.message}`,
  }));

  for (const imported of parsed.module.staticImports) {
    references.push({
      specifier: imported.moduleRequest.value,
      offset: imported.moduleRequest.start,
    });
  }
  for (const exported of parsed.module.staticExports) {
    for (const entry of exported.entries) {
      if (!entry.moduleRequest) continue;
      references.push({
        specifier: entry.moduleRequest.value,
        offset: entry.moduleRequest.start,
      });
    }
  }
  new Visitor({
    ImportExpression(node) {
      references.push({
        specifier:
          node.source.type === 'Literal' &&
          typeof node.source.value === 'string'
            ? node.source.value
            : null,
        offset: node.source.start,
      });
    },
  }).visit(parsed.program);

  const seen = new Set<string>();
  return {
    references: references.filter((item) => {
      const key = `${item.offset}\0${item.specifier ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    parseErrors,
  };
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function packageName(specifier: string): string {
  if (!specifier.startsWith('@')) return specifier.split('/')[0];
  return specifier.split('/').slice(0, 2).join('/');
}

function inspectEdge(
  root: string,
  sourceFile: string,
  sourcePath: string,
  sourceOwner: Owner,
  reference: ImportReference,
  lineStarts: number[],
): BoundaryViolation | null {
  const line = lineAt(lineStarts, reference.offset);
  if (reference.specifier === null) {
    return {
      file: sourcePath,
      line,
      message:
        'Non-literal dynamic imports bypass the ownership graph and are forbidden.',
    };
  }
  const specifier = reference.specifier;
  if (specifier.startsWith('node:')) return null;

  if (specifier.startsWith('.')) {
    const targetPath = repoPath(root, resolve(dirname(sourceFile), specifier));
    if (targetPath === null) {
      return {
        file: sourcePath,
        line,
        message: `Relative import escapes the repository: ${specifier}`,
      };
    }
    const targetOwner = ownerFor(targetPath);
    if (targetOwner === null) {
      return {
        file: sourcePath,
        line,
        message: `Import targets an unowned local path: ${specifier}`,
      };
    }
    if (!INTERNAL_ALLOW[sourceOwner].has(targetOwner)) {
      return {
        file: sourcePath,
        line,
        message: `${sourceOwner} must not depend on ${targetOwner}: ${specifier}`,
      };
    }
    return null;
  }

  const dependency = packageName(specifier);
  if (!EXTERNAL_ALLOW[sourceOwner].has(dependency)) {
    return {
      file: sourcePath,
      line,
      message: `${sourceOwner} does not own external dependency ${dependency}.`,
    };
  }
  return null;
}

export function checkImportBoundaries(root = DEFAULT_ROOT): BoundaryReport {
  const absoluteRoot = resolve(root);
  const files = SCAN_ROOTS.flatMap((path) =>
    listSourceFiles(resolve(absoluteRoot, path)),
  ).sort();
  const violations: BoundaryViolation[] = [];
  let edgesChecked = 0;

  for (const file of files) {
    const path = repoPath(absoluteRoot, file);
    if (path === null) continue;
    const owner = ownerFor(path);
    if (owner === null) {
      violations.push({
        file: path,
        line: 1,
        message: 'Source file has no dependency owner.',
      });
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const lineStarts = buildLineStarts(text);
    const parsed = importReferences(file, text, lineStarts);
    violations.push(
      ...parsed.parseErrors.map((error) => ({ ...error, file: path })),
    );
    for (const reference of parsed.references) {
      edgesChecked++;
      const violation = inspectEdge(
        absoluteRoot,
        file,
        path,
        owner,
        reference,
        lineStarts,
      );
      if (violation) violations.push(violation);
    }
  }

  violations.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.message.localeCompare(b.message),
  );
  return { filesChecked: files.length, edgesChecked, violations };
}

function main(): void {
  const report = checkImportBoundaries();
  if (report.violations.length) {
    for (const violation of report.violations) {
      process.stderr.write(
        `${violation.file}:${violation.line}: error boundary: ${violation.message}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Import boundary check passed (${report.filesChecked} files, ${report.edgesChecked} edges).\n`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
