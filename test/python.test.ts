import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildIndex } from '../src/core/build-index.ts';
import { graph } from '../src/core/call-graph.ts';
import { read } from '../src/core/read.ts';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'map-py-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

const hasPython = (() => {
  for (const c of [process.env.CODE_MAP_PYTHON, 'python3', 'python'].filter(Boolean) as string[]) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
})();

const MOD = `def shared_util(x):
    """A helper imported across the package."""
    return x + 1


class Greeter:
    def greet(self):
        return self.shout()

    def shout(self):
        return "HI"
`;

const APP = `from mod import shared_util


def run():
    return shared_util(41)
`;

test('Python is a first-class backend: symbols, exact reads, fan-in, call graph (incl. self.m())', { skip: hasPython ? false : 'python3 not available' }, async () => {
  const root = repo({ 'mod.py': MOD, 'app.py': APP });
  const { index } = await buildIndex({ root });

  // Symbols extracted by the stdlib-ast backend.
  const shared = index.entries.find((e) => e.name === 'shared_util' && e.file === 'mod.py')!;
  const greeter = index.entries.find((e) => e.name === 'Greeter')!;
  const greet = index.entries.find((e) => e.name === 'greet')!;
  const shout = index.entries.find((e) => e.name === 'shout')!;
  const run = index.entries.find((e) => e.name === 'run')!;
  assert.ok(shared && greeter && run, 'function + class + caller indexed');
  assert.equal(shared.kind, 'FunctionDeclaration');
  assert.equal(greeter.kind, 'ClassDeclaration');
  assert.equal(greet.kind, 'ClassMethod');
  assert.equal(greet.className, 'Greeter');

  // Read comes back `exact` — char offsets + drift token agree with the slice.
  const r = read(index, shared.id);
  assert.equal(r.status, 'exact', 'python read is exact');
  assert.match(r.raw ?? '', /def shared_util/);

  // Native fan-in: app.py imports shared_util → cross-module reference counted.
  assert.ok((shared.fanIn ?? 0) >= 1, `fan-in counted (got ${shared.fanIn})`);

  // Call graph (shared pipeline): from-import call run()→shared_util resolves...
  const callers = graph(index, shared.id, { direction: 'callers' });
  assert.ok(callers.nodes.some((n) => n.id === run.id), 'run() resolved as a caller via from-import');

  // ...and self.m() resolves to the enclosing class's method (Python's `this`).
  const greetCallees = graph(index, greet.id, { direction: 'callees' });
  assert.ok(greetCallees.nodes.some((n) => n.id === shout.id), 'self.shout() resolved to Greeter.shout');
});
