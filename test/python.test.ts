import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { buildIndex } from '../src/core/build-index.ts';
import {
  resolvePythonBackend,
  resolvePythonCommand,
} from '../src/core/python-command.ts';
import { read, readMany } from '../src/core/read.ts';
import { loadIndex, prepareLookup, saveIndex } from '../src/core/store.ts';

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'map-py-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

function indexProjection(
  report: Awaited<ReturnType<typeof buildIndex>>,
): object {
  return {
    entries: report.index.entries,
    fileTokens: report.index.fileTokens,
    fileImports: report.index.fileImports,
    invalidFiles: report.index.meta.invalidFiles,
    counts: report.index.meta.counts,
    filesMissing: report.filesMissing,
  };
}

const pythonBackend = (() => {
  try {
    return resolvePythonBackend();
  } catch {
    return null;
  }
})();
const hasPython = pythonBackend !== null;
const hasNativePython = (() => {
  try {
    return resolvePythonBackend({ backend: 'native' }).kind === 'native';
  } catch {
    return false;
  }
})();
const hasStdlibPython = (() => {
  try {
    return resolvePythonBackend({ backend: 'stdlib' }).kind === 'stdlib';
  } catch {
    return false;
  }
})();

test('Python launcher uses the platform-native candidates and preserves an override', () => {
  const windowsProbes: string[] = [];
  const windows = resolvePythonCommand({
    platform: 'win32',
    probe: (command, args) => {
      windowsProbes.push([command, ...args].join(' '));
      return command === 'python';
    },
  });
  assert.deepEqual(windowsProbes, ['py -3', 'python3', 'python']);
  assert.deepEqual(windows, { command: 'python', args: [], display: 'python' });

  const linux = resolvePythonCommand({
    platform: 'linux',
    probe: (command) => command === 'python3',
  });
  assert.deepEqual(linux, { command: 'python3', args: [], display: 'python3' });
  assert.deepEqual(resolvePythonCommand({ override: '/opt/python' }), {
    command: '/opt/python',
    args: [],
    display: '/opt/python',
  });
});

test('Python backend prefers native, honors overrides, and falls back explicitly', () => {
  assert.deepEqual(
    resolvePythonBackend({
      backend: 'auto',
      nativeOverride: '/native/code-map-python',
      exists: (path) => path === '/native/code-map-python',
    }),
    {
      kind: 'native',
      command: '/native/code-map-python',
      args: [],
      display: '/native/code-map-python',
    },
  );
  assert.deepEqual(
    resolvePythonBackend({
      backend: 'auto',
      nativeOverride: '/missing-native',
      exists: () => false,
      platform: 'linux',
      probe: (command) => command === 'python3',
    }),
    {
      kind: 'stdlib',
      command: 'python3',
      args: [],
      display: 'python3',
    },
  );
  assert.deepEqual(
    resolvePythonBackend({
      backend: 'auto',
      override: '/opt/python',
      exists: () => true,
    }),
    {
      kind: 'stdlib',
      command: '/opt/python',
      args: [],
      display: '/opt/python',
    },
  );
  assert.throws(
    () =>
      resolvePythonBackend({
        backend: 'native',
        nativeOverride: '/missing-native',
        exists: () => false,
      }),
    /Native Python extractor was not found/,
  );
});

test(
  'native and stdlib Python backends emit the same index contract',
  {
    skip:
      hasNativePython && hasStdlibPython
        ? false
        : 'both native and stdlib Python backends are required',
  },
  async () => {
    const root = repo({
      'base.py':
        'class Base:\r\n    def ping(self):\r\n        return "😀"\r\n',
      'child.py':
        'from base import Base\n\n@decorate\nclass Child(Base):\n    def ping(self):\n        def nested():\n            return super().ping()\n        return nested()\n',
    });
    const previousBackend = process.env.CODE_MAP_PY_BACKEND;
    try {
      process.env.CODE_MAP_PY_BACKEND = 'native';
      const native = await buildIndex({ root });
      process.env.CODE_MAP_PY_BACKEND = 'stdlib';
      const stdlib = await buildIndex({ root });
      assert.deepEqual(
        {
          entries: native.index.entries,
          fileImports: native.index.fileImports,
          fileTokens: native.index.fileTokens,
          filesMissing: native.filesMissing,
          filesInvalid: native.filesInvalid,
          defs: native.defs,
          methods: native.methods,
          privateDefs: native.privateDefs,
          nestedDefs: native.nestedDefs,
        },
        {
          entries: stdlib.index.entries,
          fileImports: stdlib.index.fileImports,
          fileTokens: stdlib.index.fileTokens,
          filesMissing: stdlib.filesMissing,
          filesInvalid: stdlib.filesInvalid,
          defs: stdlib.defs,
          methods: stdlib.methods,
          privateDefs: stdlib.privateDefs,
          nestedDefs: stdlib.nestedDefs,
        },
      );
    } finally {
      if (previousBackend === undefined) delete process.env.CODE_MAP_PY_BACKEND;
      else process.env.CODE_MAP_PY_BACKEND = previousBackend;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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

test(
  'Python is a first-class backend: symbols, exact reads, fan-in (incl. from-import edges)',
  { skip: hasPython ? false : 'python3 not available' },
  async () => {
    const root = repo({ 'mod.py': MOD, 'app.py': APP });
    const { index } = await buildIndex({ root });

    // Symbols extracted through the shared native/stdlib contract.
    const shared = index.entries.find(
      (e) => e.name === 'shared_util' && e.file === 'mod.py',
    )!;
    const greeter = index.entries.find((e) => e.name === 'Greeter')!;
    const greet = index.entries.find((e) => e.name === 'greet')!;
    const shout = index.entries.find((e) => e.name === 'shout')!;
    const run = index.entries.find((e) => e.name === 'run')!;
    assert.ok(shared && greeter && run, 'function + class + caller indexed');
    assert.equal(shared.kind, 'FunctionDeclaration');
    assert.equal(greeter.kind, 'ClassDeclaration');
    assert.equal(greet.kind, 'ClassMethod');
    assert.equal(greet.className, 'Greeter');
    assert.ok(
      (shout.intraRefs ?? 0) >= 2,
      'one AST pass counts the declaration plus self.shout()',
    );

    // Read comes back `exact` — char offsets + drift token agree with the slice.
    const r = read(index, shared.id);
    assert.equal(r.status, 'exact', 'python read is exact');
    assert.match(r.raw ?? '', /def shared_util/);

    // Native fan-in via the from-import edge: app.py imports shared_util → counted.
    assert.ok((shared.fanIn ?? 0) >= 1, `fan-in counted (got ${shared.fanIn})`);
  },
);

test(
  'Python indexes AST-proven module bindings without leaking locals or class fields',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'bindings.py': `PUBLIC = 1
_private = 2
left, *rest = (3, 4, 5)
first = chained = 6
ANNOTATED: int = 7
type Alias[T] = list[T]
π = "😀"; AFTER = 14
(
    multi,
    *tail,
) = (15, 16, 17)

if PUBLIC:
    CONDITIONAL = 8

class Container:
    class_field = 9

    def method(self):
        local = 10
        return local

def outer():
    local = 11
    return local
`,
      'consumer.py':
        'from bindings import Alias, PUBLIC\n\nvalue: Alias[int] = [PUBLIC]\n',
    });
    try {
      const { index } = await buildIndex({ root });
      const expected = new Map([
        ['PUBLIC', 'assign-var'],
        ['_private', 'assign-var'],
        ['left', 'assign-var'],
        ['rest', 'assign-var'],
        ['first', 'assign-var'],
        ['chained', 'assign-var'],
        ['ANNOTATED', 'ann-var'],
        ['Alias', 'TypeAlias'],
        ['π', 'assign-var'],
        ['AFTER', 'assign-var'],
        ['multi', 'assign-var'],
        ['tail', 'assign-var'],
        ['CONDITIONAL', 'assign-var'],
      ]);
      for (const [name, kind] of expected) {
        const entry = index.entries.find(
          (candidate) =>
            candidate.file === 'bindings.py' && candidate.name === name,
        );
        assert.ok(entry, `${name} is indexed as a module binding`);
        assert.equal(entry.kind, kind);
        assert.equal(read(index, entry.id).status, 'exact');
      }

      const publicBinding = index.entries.find(
        (entry) => entry.file === 'bindings.py' && entry.name === 'PUBLIC',
      )!;
      const alias = index.entries.find(
        (entry) => entry.file === 'bindings.py' && entry.name === 'Alias',
      )!;
      const left = index.entries.find(
        (entry) => entry.file === 'bindings.py' && entry.name === 'left',
      )!;
      const rest = index.entries.find(
        (entry) => entry.file === 'bindings.py' && entry.name === 'rest',
      )!;
      assert.equal(read(index, publicBinding.id).raw, 'PUBLIC = 1');
      assert.equal(read(index, alias.id).raw, 'type Alias[T] = list[T]');
      assert.equal(read(index, left.id).raw, 'left, *rest = (3, 4, 5)');
      assert.equal(read(index, rest.id).raw, 'left, *rest = (3, 4, 5)');
      assert.equal(
        read(index, index.entries.find((entry) => entry.name === 'π')!.id).raw,
        'π = "😀"',
      );
      assert.equal(
        read(index, index.entries.find((entry) => entry.name === 'AFTER')!.id)
          .raw,
        'AFTER = 14',
      );
      assert.equal(
        read(index, index.entries.find((entry) => entry.name === 'multi')!.id)
          .raw,
        '(\n    multi,\n    *tail,\n) = (15, 16, 17)',
      );
      assert.equal(publicBinding.fanIn, 1);
      assert.equal(alias.fanIn, 1);
      assert.equal(publicBinding.intraRefs, 2, 'binding plus local use');
      assert.equal(alias.intraRefs, 1, 'the alias declaration is counted once');
      assert.equal(
        index.entries.find((entry) => entry.name === '_private')?.visibility,
        'module-private',
      );

      assert.ok(
        !index.entries.some(
          (entry) => entry.name === 'class_field' || entry.name === 'local',
        ),
        'class fields and function locals remain outside the symbol surface',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python nested declarations have exact hierarchical refs without breaking legacy ids',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'nested.py': `class TypeScriptLanguageServer:
    def _create_dependency_provider(self):
        def local_factory():
            return "local"
        return local_factory()

    class DependencyProvider:
        def _get_or_install_core_dependency(self):
            return "tsgo"
`,
    });
    try {
      const { index } = await buildIndex({ root });
      const directMethod = index.entries.find(
        (entry) =>
          entry.name === '_create_dependency_provider' &&
          entry.className === 'TypeScriptLanguageServer',
      );
      const nestedClass = index.entries.find(
        (entry) =>
          entry.namePath === 'TypeScriptLanguageServer/DependencyProvider',
      );
      const nestedMethod = index.entries.find(
        (entry) =>
          entry.name === '_get_or_install_core_dependency' &&
          entry.className === 'TypeScriptLanguageServer/DependencyProvider',
      );
      const localFunction = index.entries.find(
        (entry) =>
          entry.namePath ===
          'TypeScriptLanguageServer/_create_dependency_provider/local_factory',
      );

      assert.ok(directMethod && nestedClass && nestedMethod && localFunction);
      assert.equal(
        directMethod.id,
        'nested.py#_create_dependency_provider',
        'an existing direct method keeps its legacy canonical id',
      );
      assert.equal(nestedClass.kind, 'ClassDeclaration');
      assert.equal(nestedMethod.kind, 'ClassMethod');
      assert.equal(
        nestedMethod.className,
        'TypeScriptLanguageServer/DependencyProvider',
      );
      assert.equal(localFunction.kind, 'FunctionDeclaration');
      assert.equal(index.meta.counts?.nestedDefs, 2);

      const [nestedClassRead, localBatchRead] = readMany(index, [
        'nested.py#TypeScriptLanguageServer/DependencyProvider',
        'nested.py#TypeScriptLanguageServer/_create_dependency_provider/local_factory',
      ]);
      assert.equal(nestedClassRead.status, 'exact');
      assert.match(nestedClassRead.raw ?? '', /^class DependencyProvider:/);
      assert.equal(localBatchRead.status, 'exact');
      assert.match(localBatchRead.raw ?? '', /^def local_factory\(\):/);

      prepareLookup(index);
      const nestedMethodRead = read(
        index,
        'nested.py#TypeScriptLanguageServer/DependencyProvider/_get_or_install_core_dependency',
      );
      assert.equal(nestedMethodRead.status, 'exact');
      assert.match(
        nestedMethodRead.raw ?? '',
        /^def _get_or_install_core_dependency\(self\):/,
      );
      const localRead = read(
        index,
        'nested.py#TypeScriptLanguageServer/_create_dependency_provider/local_factory',
      );
      assert.equal(localRead.status, 'exact');
      assert.match(localRead.raw ?? '', /^def local_factory\(\):/);

      const legacyLeafRead = read(index, 'nested.py#DependencyProvider');
      assert.equal(legacyLeafRead.status, 'exact');
      assert.match(legacyLeafRead.raw ?? '', /^class DependencyProvider:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python exact and dirty reads preserve decorators',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'decorated.py': `from dataclasses import dataclass

@dataclass(frozen=True)
class Config:
    value: int


class Service:
    @property
    def value(self):
        return 1
`,
    });
    try {
      const { index } = await buildIndex({ root });
      const config = index.entries.find((entry) => entry.name === 'Config')!;
      const value = index.entries.find(
        (entry) => entry.name === 'value' && entry.className === 'Service',
      )!;

      assert.equal(config.line, 3, 'the symbol begins at its first decorator');
      assert.ok((config.anchorOffset ?? 0) > 0);
      assert.equal(value.line, 9);
      assert.match(
        read(index, config.id).raw ?? '',
        /^@dataclass\(frozen=True\)\nclass Config:/,
      );
      assert.match(
        read(index, 'decorated.py#Service/value').raw ?? '',
        /^@property\n    def value\(self\):/,
      );

      writeFileSync(
        join(root, 'decorated.py'),
        `from dataclasses import dataclass

@dataclass(frozen=True)
class Config:
    value: int


class Service:
    @property
    def value(self):
        updated = 2
        return updated
`,
      );
      const relocated = read(index, 'decorated.py#Service/value');
      assert.equal(relocated.status, 'relocated');
      assert.match(relocated.raw ?? '', /^@property\n    def value\(self\):/);
      assert.match(relocated.raw ?? '', /return updated/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python definition walk keeps nested declarations inside control-flow suites',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'control.py': `def outer(flag):
    if flag:
        def branch():
            return "branch"
    try:
        def guarded():
            return "guarded"
    except Exception:
        async def recovery():
            return "recovery"
`,
    });
    try {
      const { index } = await buildIndex({ root });
      for (const name of ['branch', 'guarded', 'recovery']) {
        const entry = index.entries.find(
          (candidate) => candidate.namePath === `outer/${name}`,
        );
        assert.ok(entry, `${name} remains indexed below its lexical owner`);
        assert.equal(read(index, entry.id).status, 'exact');
      }
      assert.equal(index.meta.counts?.nestedDefs, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python definition walk covers every compound statement suite',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'suites.py': `async def outer(flag, manager):
    if flag == 1:
        def in_if():
            pass
    elif flag == 2:
        async def in_elif():
            pass
    else:
        class InElse:
            def method(self):
                pass
    for item in ():
        def in_for():
            pass
    else:
        def in_for_else():
            pass
    while False:
        def in_while():
            pass
    else:
        def in_while_else():
            pass
    with manager:
        def in_with():
            pass
    async with manager:
        def in_async_with():
            pass
    try:
        def in_try():
            pass
    except ValueError:
        def in_except():
            pass
    else:
        def in_try_else():
            pass
    finally:
        def in_finally():
            pass
    match flag:
        case 3 if flag:
            def in_case():
                pass
    try:
        pass
    except* RuntimeError:
        def in_except_star():
            pass
`,
    });
    try {
      const { index } = await buildIndex({ root });
      for (const name of [
        'in_if',
        'in_elif',
        'in_for',
        'in_for_else',
        'in_while',
        'in_while_else',
        'in_with',
        'in_async_with',
        'in_try',
        'in_except',
        'in_try_else',
        'in_finally',
        'in_case',
        'in_except_star',
      ]) {
        const entry = index.entries.find(
          (candidate) => candidate.namePath === `outer/${name}`,
        );
        assert.ok(entry, `${name} is indexed below its lexical owner`);
        assert.equal(read(index, entry.id).status, 'exact');
      }
      const nestedClass = index.entries.find(
        (entry) => entry.namePath === 'outer/InElse',
      );
      const nestedMethod = index.entries.find(
        (entry) =>
          entry.name === 'method' && entry.className === 'outer/InElse',
      );
      assert.ok(nestedClass && nestedMethod);
      assert.equal(index.meta.counts?.nestedDefs, 15);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python primary-base metadata never substitutes a later mixin',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'bases.py': `class Base:
    pass

class Mixin:
    pass

class Direct(Base):
    pass

class Qualified(pkg.Base, Mixin):
    pass
`,
    });
    try {
      const { index } = await buildIndex({ root });
      const direct = index.entries.find((entry) => entry.name === 'Direct');
      const qualified = index.entries.find(
        (entry) => entry.name === 'Qualified',
      );
      assert.equal(direct?.extends, 'Base');
      assert.equal(
        qualified?.extends,
        undefined,
        'an unsupported primary base must not be replaced by a later base',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python fan-in resolves named imports from .pyi modules',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'api.pyi': 'def exported(value: int) -> int: ...\n',
      'consumer.py':
        'from api import exported as local_export\n\nvalue = local_export(1)\n',
      'pkg/__init__.py': '',
      'pkg/stub.pyi': 'def relative_export() -> None: ...\n',
      'pkg/user.py':
        'from .stub import relative_export as local_relative\n\nlocal_relative()\n',
    });
    try {
      const { index } = await buildIndex({ root });
      const exported = index.entries.find(
        (entry) => entry.file === 'api.pyi' && entry.name === 'exported',
      );
      const relative = index.entries.find(
        (entry) =>
          entry.file === 'pkg/stub.pyi' && entry.name === 'relative_export',
      );
      assert.equal(exported?.fanIn, 1);
      assert.equal(relative?.fanIn, 1);
      assert.equal(read(index, exported!.id).status, 'exact');
      assert.equal(read(index, relative!.id).status, 'exact');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python incremental indexing removes deleted paths and reindexes renames',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'old.py': 'def moved():\n    return "old"\n',
      'gone.py': 'def removed():\n    return False\n',
      'stable.py': 'def stable():\n    return True\n',
    });
    try {
      const first = await buildIndex({ root });
      renameSync(join(root, 'old.py'), join(root, 'renamed.py'));
      rmSync(join(root, 'gone.py'));

      const second = await buildIndex({ root, previous: first.index });
      assert.ok(!second.index.entries.some((entry) => entry.file === 'old.py'));
      assert.ok(
        !second.index.entries.some((entry) => entry.file === 'gone.py'),
      );
      assert.equal(second.index.fileTokens['old.py'], undefined);
      assert.equal(second.index.fileTokens['gone.py'], undefined);
      assert.equal(second.index.fileStats['old.py'], undefined);
      assert.equal(second.index.fileImports?.['gone.py'], undefined);

      const moved = second.index.entries.find(
        (entry) => entry.file === 'renamed.py' && entry.name === 'moved',
      );
      assert.ok(moved);
      assert.equal(read(second.index, moved.id).status, 'exact');
      assert.equal(second.filesMissing.length, 0);

      const noOp = await buildIndex({ root, previous: second.index });
      assert.equal(noOp.unchanged, true);
      assert.equal(noOp.index, second.index);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python incremental state converges to a forced rebuild after mixed edits',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'a.py': 'VALUE = 1\n\ndef alpha():\n    return VALUE\n',
      'b.py': 'from a import alpha\n\ndef beta():\n    return alpha()\n',
      'c.py': 'def gamma():\n    return 3\n',
    });
    try {
      let previous = (await buildIndex({ root })).index;
      const converge = async (label: string): Promise<void> => {
        const incremental = await buildIndex({ root, previous });
        const forced = await buildIndex({ root, force: true });
        assert.deepEqual(
          indexProjection(incremental),
          indexProjection(forced),
          label,
        );
        previous = incremental.index;
      };

      writeFileSync(
        join(root, 'a.py'),
        'VALUE = 20\n\ndef alpha():\n    expanded = VALUE + 1\n    return expanded\n',
      );
      await converge('body growth and a binding edit converge');

      writeFileSync(
        join(root, 'new.py'),
        'from a import VALUE\n\ndef added():\n    return VALUE\n',
      );
      rmSync(join(root, 'c.py'));
      renameSync(join(root, 'b.py'), join(root, 'renamed.py'));
      await converge('add, delete, and rename converge');

      writeFileSync(join(root, 'a.py'), 'def alpha(:\n    return broken\n');
      const degraded = await buildIndex({ root, previous });
      assert.deepEqual(degraded.filesInvalid, ['a.py']);
      assert.ok(degraded.index.entries.some((entry) => entry.name === 'alpha'));
      previous = degraded.index;

      writeFileSync(
        join(root, 'a.py'),
        'VALUE = 30\n\ndef repaired():\n    return VALUE\n',
      );
      await converge('repair after stale preservation converges');

      const noOp = await buildIndex({ root, previous });
      assert.equal(noOp.unchanged, true);
      assert.equal(noOp.index, previous);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python duplicate lexical aliases return selectable canonical ids',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'duplicate.py': `if ENABLED:
    class Watcher:
        def __init__(self):
            self.mode = "live"
else:
    class Watcher:
        def __init__(self):
            self.mode = "stub"
`,
    });
    try {
      const { index } = await buildIndex({ root });
      const result = read(index, 'duplicate.py#Watcher/__init__');
      assert.equal(result.status, 'ambiguous');
      const previews = result.candidates.map((candidate) => candidate.preview);
      assert.equal(
        new Set(previews).size,
        previews.length,
        'every displayed candidate must be selectable and unique',
      );
      assert.ok(
        previews.some((preview) =>
          preview.startsWith('duplicate.py#__init__ (alias:'),
        ),
      );
      assert.ok(
        previews.some((preview) =>
          preview.startsWith('duplicate.py#__init__#ClassMethod (alias:'),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python offsets are UTF-16 — read stays exact past a non-BMP (astral) char',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    // The emoji is 1 code point but 2 UTF-16 units; a code-point offset would slice
    // the wrong range for `target` and still claim `exact`. The slice must be correct.
    const root = repo({
      'astral.py':
        'EMOJI = "\u{1F600}\u{1F600}"\n\n\ndef target():\n    return 42\n',
    });
    const { index } = await buildIndex({ root });
    const fn = index.entries.find((e) => e.name === 'target')!;
    assert.ok(fn, 'target indexed');
    const r = read(index, fn.id);
    assert.equal(r.status, 'exact');
    assert.match(
      r.raw ?? '',
      /^def target\(\):/,
      'slice starts exactly at the def, not shifted by the astral chars',
    );
    assert.ok(
      (r.raw ?? '').includes('return 42'),
      'slice includes the whole body',
    );
  },
);

test(
  'Python hashes and coordinates preserve CRLF source bytes',
  { skip: hasPython ? false : 'Python backend not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'windows.py':
        'VALUE = "before"\r\n\r\n\r\ndef target():\r\n    return "after"\r\n',
    });
    try {
      const { index } = await buildIndex({ root });
      const target = index.entries.find((entry) => entry.name === 'target')!;
      const result = read(index, target.id);
      assert.equal(result.status, 'exact');
      assert.equal(result.raw, 'def target():\r\n    return "after"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python exact reads preserve legal CR-only newlines and a UTF-8 BOM',
  {
    skip:
      hasNativePython || hasStdlibPython
        ? false
        : 'Python backend not available',
    timeout: 60_000,
  },
  async () => {
    const backends = [
      ...(hasNativePython ? (['native'] as const) : []),
      ...(hasStdlibPython ? (['stdlib'] as const) : []),
    ];
    const previousBackend = process.env.CODE_MAP_PY_BACKEND;
    try {
      for (const backend of backends) {
        process.env.CODE_MAP_PY_BACKEND = backend;
        const root = repo({
          'carriage.py':
            'PREFIX = "\u{1F600}"\r\rdef target():\r    return 42\r',
          'bom.py': '\uFEFFdef bom_target():\n    return 7\n',
        });
        try {
          const report = await buildIndex({ root });
          assert.deepEqual(
            report.filesInvalid,
            [],
            `${backend} accepts both legal source forms`,
          );

          const target = report.index.entries.find(
            (entry) => entry.name === 'target',
          );
          assert.ok(target, `${backend} indexes the CR-only declaration`);
          assert.equal(target.line, 3, `${backend} counts bare CR newlines`);
          assert.equal(
            read(report.index, target.id).raw,
            'def target():\r    return 42',
          );

          const bomTarget = report.index.entries.find(
            (entry) => entry.name === 'bom_target',
          );
          assert.ok(bomTarget, `${backend} indexes a UTF-8-BOM source`);
          assert.equal(bomTarget.charStart, 1, `${backend} skips the BOM`);
          assert.equal(
            read(report.index, bomTarget.id).raw,
            'def bom_target():\n    return 7',
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    } finally {
      if (previousBackend === undefined) delete process.env.CODE_MAP_PY_BACKEND;
      else process.env.CODE_MAP_PY_BACKEND = previousBackend;
    }
  },
);

test(
  'Python non-UTF-8 source is degraded instead of reported missing',
  {
    skip:
      hasNativePython || hasStdlibPython
        ? false
        : 'Python backend not available',
    timeout: 60_000,
  },
  async () => {
    const backends = [
      ...(hasNativePython ? (['native'] as const) : []),
      ...(hasStdlibPython ? (['stdlib'] as const) : []),
    ];
    const previousBackend = process.env.CODE_MAP_PY_BACKEND;
    try {
      for (const backend of backends) {
        process.env.CODE_MAP_PY_BACKEND = backend;
        const root = repo({});
        try {
          writeFileSync(
            join(root, 'latin1.py'),
            Buffer.from('# coding: latin-1\nNAME = "café"\n', 'latin1'),
          );
          const report = await buildIndex({ root });
          assert.deepEqual(report.filesMissing, [], `${backend}: not missing`);
          assert.deepEqual(report.filesInvalid, ['latin1.py']);
          assert.ok(report.index.fileTokens['latin1.py']);
          assert.ok(
            !report.index.entries.some((entry) => entry.file === 'latin1.py'),
          );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    } finally {
      if (previousBackend === undefined) delete process.env.CODE_MAP_PY_BACKEND;
      else process.env.CODE_MAP_PY_BACKEND = previousBackend;
    }
  },
);

test(
  'Python dirty reads do not truncate a function that grew after indexing',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'module.py':
        'def target():\n    return 1\n\ndef sibling():\n    return 2\n',
    });
    try {
      const { index } = await buildIndex({ root });
      const target = index.entries.find((entry) => entry.name === 'target')!;
      writeFileSync(
        join(root, 'module.py'),
        'def target():\n    first = 1\n    second = 2\n    # tail added after indexing\n    return first + second\n\ndef sibling():\n    return 2\n',
      );

      const result = read(index, target.id);
      assert.equal(result.status, 'relocated');
      assert.match(result.raw ?? '', /tail added after indexing/);
      assert.match(result.raw ?? '', /return first \+ second/);
      assert.doesNotMatch(result.raw ?? '', /def sibling/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python dirty binding reads anchor on the declaration, not its changing value',
  { skip: hasPython ? false : 'python3 not available', timeout: 60_000 },
  async () => {
    const root = repo({
      'bindings.py': 'TARGET = 1\nNEXT = 2\n',
    });
    try {
      const { index } = await buildIndex({ root });
      const target = index.entries.find((entry) => entry.name === 'TARGET')!;
      writeFileSync(
        join(root, 'bindings.py'),
        'TARGET = {"expanded": [1, 2, 3]}\nNEXT = 2\n',
      );

      const result = read(index, target.id);
      assert.equal(result.status, 'relocated');
      assert.match(result.raw ?? '', /^TARGET = \{"expanded": \[1, 2, 3\]\}/);
      assert.doesNotMatch(result.raw ?? '', /NEXT = 2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'Python backend failure aborts instead of silently deleting prior symbols',
  { skip: hasPython ? false : 'Python 3 not available' },
  async () => {
    const root = repo({ 'mod.py': 'def alpha():\n    return 1\n' });
    const previousCommand = process.env.CODE_MAP_PYTHON;
    try {
      const first = await buildIndex({ root });
      assert.ok(first.index.entries.some((e) => e.name === 'alpha'));
      writeFileSync(join(root, 'mod.py'), 'def beta():\n    return 2\n');
      process.env.CODE_MAP_PYTHON = join(root, 'missing-python-executable');
      await assert.rejects(
        () => buildIndex({ root, previous: first.index }),
        /Python backend failed/,
      );
      assert.ok(
        first.index.entries.some((e) => e.name === 'alpha'),
        'the prior good index remains intact',
      );
    } finally {
      if (previousCommand === undefined) delete process.env.CODE_MAP_PYTHON;
      else process.env.CODE_MAP_PYTHON = previousCommand;
    }
  },
);

test(
  'Python syntax errors preserve prior symbols and remain explicitly degraded',
  { skip: hasPython ? false : 'Python 3 not available', timeout: 60_000 },
  async () => {
    const root = repo({ 'mod.py': 'def alpha():\n    return 1\n' });
    try {
      const first = await buildIndex({ root });
      const alpha = first.index.entries.find(
        (entry) => entry.name === 'alpha',
      )!;
      const priorToken = first.index.fileTokens['mod.py'];

      writeFileSync(join(root, 'mod.py'), 'def alpha(:\n    return broken\n');
      const degraded = await buildIndex({
        root,
        previous: first.index,
      });
      assert.deepEqual(degraded.filesInvalid, ['mod.py']);
      assert.deepEqual(degraded.index.meta.invalidFiles, ['mod.py']);
      assert.equal(
        degraded.index.entries.find((entry) => entry.name === 'alpha')?.id,
        alpha.id,
        'the last known-good symbol survives a transient syntax error',
      );
      assert.equal(
        degraded.index.fileTokens['mod.py'],
        priorToken,
        'the stale coordinates must not be blessed with the invalid file token',
      );
      assert.notEqual(read(degraded.index, alpha.id).status, 'exact');

      const indexPath = join(root, '.map-index.json');
      saveIndex(degraded.index, indexPath);
      const persisted = loadIndex(indexPath);
      assert.deepEqual(persisted.meta.invalidFiles, ['mod.py']);
      assert.ok(persisted.entries.some((entry) => entry.id === alpha.id));

      const unchangedInvalid = await buildIndex({
        root,
        previous: persisted,
      });
      assert.equal(unchangedInvalid.unchanged, true);
      assert.deepEqual(unchangedInvalid.filesInvalid, ['mod.py']);

      writeFileSync(
        join(root, 'mod.py'),
        'def beta():\n    repaired = True\n    return repaired\n',
      );
      const repaired = await buildIndex({
        root,
        previous: degraded.index,
      });
      assert.deepEqual(repaired.filesInvalid, []);
      assert.deepEqual(repaired.index.meta.invalidFiles, []);
      assert.ok(repaired.index.entries.some((entry) => entry.name === 'beta'));
      assert.ok(
        !repaired.index.entries.some((entry) => entry.name === 'alpha'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
