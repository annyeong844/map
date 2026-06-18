import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { disposeAll, query, TOOLS } from '../server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const hasTsgo = !!process.env.TSGO_BIN || existsSync(join(HERE, '../node_modules/@typescript/native-preview/bin/tsgo.js'));

after(() => disposeAll());

test('the three tools are exposed', () => {
  assert.deepEqual(TOOLS.map((t) => t.name).sort(), ['callers', 'definition', 'implementations']);
});

// The interface-dispatch case, as a real fixture (was only a comment + a buggy spike):
// `implementations` must resolve an interface method to its concrete impls — the
// type-aware CHA that a structural call graph cannot draw.
test('implementations resolves an interface method to every concrete impl (type-aware CHA)', { skip: hasTsgo ? false : 'tsgo not installed (npm install in code-oracle/)', timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'code-oracle-'));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', moduleResolution: 'nodenext' }, include: ['*.ts'] }));
  writeFileSync(
    join(root, 'shapes.ts'),
    [
      'export interface Shape {',
      '  area(): number;',
      '}',
      'export class Circle implements Shape {',
      '  area() { return 3.14; }',
      '}',
      'export class Square implements Shape {',
      '  area() { return 4; }',
      '}',
      '',
    ].join('\n'),
  );

  // Point at the interface method's declaration (line 1, the `area` token at col 2).
  const r = (await query('implementations', { file: join(root, 'shapes.ts'), line: 1, character: 2, root })) as {
    tool: string;
    count: number;
    results: { file: string; line: number }[];
  };
  assert.equal(r.tool, 'implementations');
  assert.ok(r.count >= 2, `expected >= 2 concrete impls, got ${r.count}: ${JSON.stringify(r.results)}`);
});
