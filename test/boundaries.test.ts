import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkImportBoundaries } from '../scripts/check-import-boundaries.ts';

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'map-boundaries-'));
  for (const [file, text] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

test('the import boundary matrix accepts only declared owner edges', () => {
  const root = fixture({
    'src/core/value.ts': `import { parseSync } from 'oxc-parser';\nexport const value = parseSync;\n`,
    'src/version.ts': `import { readFileSync } from 'node:fs';\nexport { readFileSync };\n`,
    'src/cli/main.ts': `import { value } from '../core/value.ts';\nimport '../version.ts';\nexport { value };\n`,
    'src/mcp/server.ts': `export async function load() { return import('../core/value.ts'); }\n`,
    'scripts/probe.ts': `import { value } from '../src/core/value.ts';\nimport('../dist/core/value.js');\nexport { value };\n`,
    'test/probe.test.ts': `import '../scripts/probe.ts';\n`,
  });
  try {
    assert.deepEqual(checkImportBoundaries(root).violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the import boundary matrix rejects unknown owners, crossings, and bypasses', () => {
  const root = fixture({
    'src/core/value.ts': `import '../mcp/server.ts';\nimport leftPad from 'left-pad';\nexport { leftPad };\n`,
    'src/mcp/server.ts': `const target = '../core/value.ts';\nexport const load = () => import(target);\n`,
    'src/rogue.ts': `export const rogue = true;\n`,
  });
  try {
    const messages = checkImportBoundaries(root).violations.map(
      (violation) => violation.message,
    );
    assert.deepEqual(messages, [
      'core must not depend on mcp: ../mcp/server.ts',
      'core does not own external dependency left-pad.',
      'Non-literal dynamic imports bypass the ownership graph and are forbidden.',
      'Source file has no dependency owner.',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Oracle subowners keep resource leaves below the MCP entrypoint', () => {
  const allowed = fixture({
    'code-oracle/runtime-control.ts': `export const runtime = true;\n`,
    'code-oracle/mcp-ndjson.ts': `export const wire = true;\n`,
    'code-oracle/project-snapshot.ts': `import './runtime-control.ts';\n`,
    'code-oracle/lsp-backend.ts': `import './project-snapshot.ts';\n`,
    'code-oracle/static-import-supplement.ts': `import { parseSync } from 'oxc-parser';\nimport './project-snapshot.ts';\nexport { parseSync };\n`,
    'code-oracle/lsp-session.ts': `import './lsp-backend.ts';\nimport './project-snapshot.ts';\nimport './static-import-supplement.ts';\n`,
    'code-oracle/lsp-session-pool.ts': `import './lsp-backend.ts';\nimport './lsp-session.ts';\nimport './project-snapshot.ts';\nimport './runtime-control.ts';\n`,
    'code-oracle/oracle-cache.ts': `import './runtime-control.ts';\n`,
    'code-oracle/server.ts': `import './lsp-backend.ts';\nimport './lsp-session.ts';\nimport './lsp-session-pool.ts';\nimport './mcp-ndjson.ts';\nimport './oracle-cache.ts';\nimport './project-snapshot.ts';\nimport './runtime-control.ts';\n`,
  });
  try {
    assert.deepEqual(checkImportBoundaries(allowed).violations, []);
  } finally {
    rmSync(allowed, { recursive: true, force: true });
  }

  const rejected = fixture({
    'code-oracle/runtime-control.ts': `import './server.ts';\n`,
    'code-oracle/new-helper.ts': `export const unowned = true;\n`,
  });
  try {
    assert.deepEqual(
      checkImportBoundaries(rejected).violations.map(
        (violation) => violation.message,
      ),
      [
        'Source file has no dependency owner.',
        'oracle-runtime must not depend on oracle-entry: ./server.ts',
      ],
    );
  } finally {
    rmSync(rejected, { recursive: true, force: true });
  }
});
