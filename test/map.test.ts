import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildIndex } from '../src/core/build-index.ts';
import { grep } from '../src/core/grep.ts';
import { locate } from '../src/core/locate.ts';
import { read } from '../src/core/read.ts';

/** Build a throwaway repo + a minimal symbol-graph-shaped artifact for it. */
function fixture(source: string, eol: '\n' | '\r\n' = '\n') {
  const root = mkdtempSync(join(tmpdir(), 'map-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const text = source.replace(/\n/g, eol);
  writeFileSync(join(root, 'src/sample.ts'), text);

  // Derive real char offsets so the artifact mirrors what the symbol graph emits.
  const defOf = (name: string) => {
    const decl = `function ${name}`;
    const start = text.indexOf(decl);
    const end = text.indexOf('}', start) + 1;
    const line = text.slice(0, start).split(eol).length;
    return { name, kind: 'FunctionDeclaration', line, definitionId: `src/sample.ts#FunctionDeclaration:${start}-${end}` };
  };
  const symbols = {
    meta: { tool: 'symbol-graph', root, schemaVersion: 3 },
    defIndex: { 'src/sample.ts': { alpha: defOf('alpha'), beta: defOf('beta') } },
    classMethodIndex: {},
  };
  const symbolsPath = join(root, 'symbols.json');
  writeFileSync(symbolsPath, JSON.stringify(symbols));
  return { root, symbolsPath, sourcePath: join(root, 'src/sample.ts'), text };
}

const SRC = `// header
export function alpha(x: number): number {
  return x + 1;
}

export function beta(y: number): number {
  return y * 2;
}
`;

test('index extracts coordinates and a signature anchor, no meaning', async () => {
  const fx = fixture(SRC);
  const { index } = await buildIndex({ symbolsPath: fx.symbolsPath });
  const beta = index.entries.find((e) => e.name === 'beta')!;
  assert.ok(beta, 'beta indexed');
  assert.equal(beta.searchText, 'function beta(y: number): number {');
  assert.equal(typeof beta.charStart, 'number');
  assert.equal(typeof beta.charEnd, 'number');
  // The map stores no interpretation fields.
  assert.equal((beta as Record<string, unknown>).summary, undefined);
  assert.equal((beta as Record<string, unknown>).intent, undefined);
  assert.ok(index.fileTokens['src/sample.ts'], 'per-file token present');
});

test('locate ranks exact above fuzzy', async () => {
  const fx = fixture(SRC);
  const { index } = await buildIndex({ symbolsPath: fx.symbolsPath });
  const hits = locate(index, 'alpha');
  assert.equal(hits[0].name, 'alpha');
  assert.equal(hits[0].match, 'exact');
});

test('read returns the exact source when the file is unchanged', async () => {
  const fx = fixture(SRC);
  const { index } = await buildIndex({ symbolsPath: fx.symbolsPath });
  const beta = index.entries.find((e) => e.name === 'beta')!;
  const r = read(index, beta.id);
  assert.equal(r.status, 'exact');
  assert.equal(r.raw, 'function beta(y: number): number {\n  return y * 2;\n}');
});

test('read re-anchors via searchText after the file drifts', async () => {
  const fx = fixture(SRC);
  const { index } = await buildIndex({ symbolsPath: fx.symbolsPath });
  const beta = index.entries.find((e) => e.name === 'beta')!;
  // Prepend lines: every offset and line number shifts.
  writeFileSync(fx.sourcePath, '// A\n// B\n// C\n' + fx.text);
  const r = read(index, beta.id);
  assert.equal(r.status, 'relocated');
  assert.match(r.raw ?? '', /function beta/);
  assert.equal(r.line, beta.line + 3);
});

test('read falls back to grep when the anchor is destroyed', async () => {
  const fx = fixture(SRC);
  const { index } = await buildIndex({ symbolsPath: fx.symbolsPath });
  const beta = index.entries.find((e) => e.name === 'beta')!;
  writeFileSync(fx.sourcePath, '// beta moved to another module\nexport const x = 1;\n');
  const r = read(index, beta.id);
  assert.equal(r.status, 'grep-fallback');
  assert.ok((r.candidates ?? []).some((c) => /beta/.test(c.preview)));
});

test('fan-in breaks ties within a match tier, never across tiers', async () => {
  // Two files define alpha(); one is referenced more. A third file has a fuzzy-only name.
  const root = mkdtempSync(join(tmpdir(), 'map-fanin-'));
  mkdirSync(join(root, 'a'), { recursive: true });
  mkdirSync(join(root, 'b'), { recursive: true });
  const body = 'export function alpha(x: number): number {\n  return x + 1;\n}\n';
  writeFileSync(join(root, 'a/m.ts'), body);
  writeFileSync(join(root, 'b/m.ts'), body);
  writeFileSync(join(root, 'other.ts'), 'export function alphaBetaGamma(): void {}\n');
  const range = (t: string) => {
    const s = t.indexOf('function alpha');
    return `#FunctionDeclaration:${s}-${t.indexOf('}', s) + 1}`;
  };
  const symbols = {
    meta: { tool: 'symbol-graph', root, schemaVersion: 3 },
    defIndex: {
      'a/m.ts': { alpha: { name: 'alpha', kind: 'FunctionDeclaration', line: 1, definitionId: `a/m.ts#FunctionDeclaration:14-${body.indexOf('}') + 1}` } },
      'b/m.ts': { alpha: { name: 'alpha', kind: 'FunctionDeclaration', line: 1, definitionId: `b/m.ts#FunctionDeclaration:14-${body.indexOf('}') + 1}` } },
      'other.ts': { alphaBetaGamma: { name: 'alphaBetaGamma', kind: 'FunctionDeclaration', line: 1, definitionId: 'other.ts#FunctionDeclaration:14-40' } },
    },
    classMethodIndex: {},
    fanInByIdentity: { 'a/m.ts::alpha': 3, 'b/m.ts::alpha': 30, 'other.ts::alphaBetaGamma': 999 },
  };
  const symbolsPath = join(root, 'symbols.json');
  writeFileSync(symbolsPath, JSON.stringify(symbols));
  const { index } = await buildIndex({ symbolsPath });

  const hits = locate(index, 'alpha');
  // Exact matches (both alpha) rank above the fuzzy-only alphaBetaGamma despite its huge fan-in.
  assert.equal(hits[0].name, 'alpha');
  assert.equal(hits[1].name, 'alpha');
  assert.equal(hits[2].name, 'alphaBetaGamma');
  // Within the exact tier, higher fan-in wins.
  assert.equal(hits[0].file, 'b/m.ts');
  assert.equal(hits[0].fanIn, 30);
});

test('private pass (oxc) covers module-private defs the symbol graph omits', async () => {
  // The symbol graph's defIndex carries only the export surface. The map parses the file
  // itself and adds the rest. Source has 1 export + 2 private decls; the
  // artifact lists only the export.
  const root = mkdtempSync(join(tmpdir(), 'map-priv-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const text = [
    'function helper(n) {',
    '  return n * 2;',
    '}',
    '',
    'const SECRET = 42;',
    '',
    'export function pub(x) {',
    '  return helper(x) + SECRET;',
    '}',
    '',
  ].join('\n');
  writeFileSync(join(root, 'src/m.ts'), text);
  const pubStart = text.indexOf('function pub');
  const symbols = {
    meta: { tool: 'symbol-graph', root, schemaVersion: 3 },
    defIndex: {
      'src/m.ts': {
        pub: { name: 'pub', kind: 'FunctionDeclaration', line: 7, definitionId: `src/m.ts#FunctionDeclaration:${pubStart}-${text.indexOf('}', pubStart) + 1}` },
      },
    },
    classMethodIndex: {},
  };
  const symbolsPath = join(root, 'symbols.json');
  writeFileSync(symbolsPath, JSON.stringify(symbols));
  const { index, privateDefs } = await buildIndex({ symbolsPath });

  assert.equal(privateDefs, 2, 'helper + SECRET picked up');
  const helper = index.entries.find((e) => e.name === 'helper');
  assert.ok(helper, 'private function indexed');
  assert.equal(helper!.visibility, 'module-private');
  assert.equal(helper!.kind, 'FunctionDeclaration');
  // Exact coordinates from oxc → read slices the whole function.
  const r = read(index, helper!.id);
  assert.equal(r.status, 'exact');
  assert.equal(r.raw, 'function helper(n) {\n  return n * 2;\n}');
  // The export is NOT duplicated into the private set.
  assert.equal(index.entries.filter((e) => e.name === 'pub').length, 1);
});

test('incremental rebuild reuses unchanged files, re-reads changed ones', async () => {
  const root = mkdtempSync(join(tmpdir(), 'map-inc-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const aPath = join(root, 'src/a.ts');
  const bPath = join(root, 'src/b.ts');
  const aV1 = 'function helperA(){ return 1; }\nexport function aaa(){ return helperA(); }\n';
  writeFileSync(aPath, aV1);
  writeFileSync(bPath, 'export function bbb(){ return 2; }\n');
  const idOf = (txt: string, decl: string) => {
    const s = txt.indexOf(decl);
    return `${s}-${txt.indexOf('}', s) + 1}`;
  };
  const symbols = {
    meta: { tool: 'symbol-graph', root, schemaVersion: 3 },
    defIndex: {
      'src/a.ts': { aaa: { name: 'aaa', kind: 'FunctionDeclaration', line: 2, definitionId: `src/a.ts#FunctionDeclaration:${idOf(aV1, 'function aaa')}` } },
      'src/b.ts': { bbb: { name: 'bbb', kind: 'FunctionDeclaration', line: 1, definitionId: 'src/b.ts#FunctionDeclaration:0-34' } },
    },
    classMethodIndex: {},
  };
  const symbolsPath = join(root, 'symbols.json');
  writeFileSync(symbolsPath, JSON.stringify(symbols));

  const first = await buildIndex({ symbolsPath });
  assert.equal(first.changed, 2, 'first build reads both files');

  // Rebuild with no changes → both reused, nothing re-read.
  const second = await buildIndex({ symbolsPath, previous: first.index });
  assert.equal(second.reused, 2);
  assert.equal(second.changed, 0);
  assert.equal(second.index.meta.entryCount, first.index.meta.entryCount);

  // Change a.ts only → a re-read, b reused; the new private symbol appears.
  writeFileSync(aPath, aV1 + 'function helperA2(){ return 3; }\n');
  const third = await buildIndex({ symbolsPath, previous: second.index });
  assert.equal(third.reused, 1, 'b.ts reused');
  assert.equal(third.changed, 1, 'a.ts re-read');
  assert.ok(locate(third.index, 'helperA2').some((h) => h.file === 'src/a.ts'));
  // --force ignores the prior index entirely.
  const forced = await buildIndex({ symbolsPath, previous: third.index, force: true });
  assert.equal(forced.reused, 0);
  assert.equal(forced.changed, 2);
});

test('grep parses matches on CRLF files', async () => {
  const fx = fixture(SRC, '\r\n');
  const matches = grep(fx.root, 'function beta', { fixed: true });
  assert.ok(matches.length >= 1, 'found at least one match on CRLF source');
  assert.equal(matches[0].file, 'src/sample.ts');
});
