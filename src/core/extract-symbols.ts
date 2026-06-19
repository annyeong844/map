import { parseSync } from 'oxc-parser';

/**
 * Extract every routable symbol AND every cross-module import edge from one
 * TS/JS file with oxc — the map's own AST pass, owing nothing to any external
 * symbol graph. oxc returns UTF-16 char offsets for start/end, which is exactly
 * what read() slices by.
 *
 * Symbols: top-level declarations (exported or module-private) and class
 * methods, each with a precise char range. Edges: which named symbol this file
 * pulls from which module specifier — the raw material for native fan-in.
 */
export interface SymbolRec {
  name: string;
  kind: string;
  charStart: number;
  charEnd: number;
  exported: boolean;
  className?: string;
  static?: boolean;
  visibility?: string;
  /** Superclass name for a ClassDeclaration (`class C extends B` → 'B'), used to
   * resolve inherited `this.m()` / `super.m()` calls without a type checker. */
  extends?: string;
  /** `export default function foo` — exported under the name `default`, so a
   * `import foo from …` (which references `default`, not `foo`) counts toward fan-in. */
  default?: boolean;
}

/** A named symbol pulled from another module: `{ source, name }`. `name` is the
 * name in the *target* module ('default' for default imports, '*' for `export *`).
 * `reexport` marks an `export … from` edge — these (not plain imports) propagate
 * public-API reachability from an entry file. */
export interface ImportEdge {
  source: string;
  name: string;
  reexport?: boolean;
}

/** A call site: the enclosing top-level symbol (`caller`) calls `callee`.
 * `member` marks a `x.m()` call; `recv` says what `x` is — `this`/`super` (the
 * enclosing class, deterministically resolvable) vs `other` (`obj.m()`, needs
 * types). `callerClass` is the class enclosing the call, so `this.m()` resolves
 * to the right class's method. */
export interface CallSite {
  caller: string;
  callee: string;
  member: boolean;
  recv?: 'this' | 'super' | 'other';
  callerClass?: string;
}

export interface FileParse {
  symbols: SymbolRec[];
  imports: ImportEdge[];
  calls: CallSite[];
  /** Identifier-name → occurrence count across the whole file AST (incl. the
   * declaration itself). Lets dead-code classification ask "is this symbol used
   * anywhere in its own file?" — AST-based, so comments/strings never inflate it.
   * Deliberately broad (counts member props / keys too) so it errs toward "used"
   * — a false "alive" is safe; a false "dead" is not. */
  refs: Record<string, number>;
}

/**
 * ONE deep traversal of the AST that does both jobs — was two separate full walks
 * (identifier tally + call collection), now merged so each node is visited once:
 *   • `refs`: every Identifier name's occurrence count (for dead-code intraRefs).
 *   • `calls`: call sites attributed to the enclosing top-level symbol (function,
 *     class method, or `const fn = () => …`). Direct `foo()` carries the callee
 *     name; member `obj.m()` is tagged (no type info to pick the method).
 * Iterative, carrying the current caller down the stack (big files won't overflow).
 */
function walkProgram(program: unknown): { refs: Record<string, number>; calls: CallSite[] } {
  const refs: Record<string, number> = Object.create(null);
  const calls: CallSite[] = [];
  const stack: { node: any; caller: string; klass: string }[] = [{ node: program, caller: '<module>', klass: '' }];
  while (stack.length) {
    const { node, caller, klass } = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push({ node: c, caller, klass });
      continue;
    }
    if (node.type === 'Identifier' && typeof node.name === 'string') {
      refs[node.name] = (refs[node.name] ?? 0) + 1;
    }
    let scope = caller;
    let cls = klass;
    // Only the OUTERMOST symbol level sets the scope; a function nested inside an
    // already-entered symbol keeps it, so calls in a nested helper roll up to the
    // enclosing top-level symbol instead of being attributed to (and lost with) the
    // un-indexed nested name. `<module>` means we haven't entered a symbol yet.
    const atTop = caller === '<module>';
    if (node.type === 'ClassDeclaration' && node.id?.name) cls = node.id.name;
    else if (atTop && node.type === 'FunctionDeclaration' && node.id?.name) scope = node.id.name;
    else if (atTop && node.type === 'MethodDefinition' && node.key?.name) scope = node.key.name;
    else if (atTop && node.type === 'VariableDeclarator' && node.id?.name && (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')) scope = node.id.name;
    if (node.type === 'CallExpression' && node.callee) {
      const c = node.callee;
      if (c.type === 'Identifier') calls.push({ caller: scope, callee: c.name, member: false });
      else if (c.type === 'MemberExpression' && !c.computed && c.property?.name) {
        const recv = c.object?.type === 'ThisExpression' ? 'this' : c.object?.type === 'Super' ? 'super' : 'other';
        calls.push({ caller: scope, callee: c.property.name, member: true, recv, callerClass: cls || undefined });
      }
    }
    for (const k in node) {
      if (k === 'type') continue;
      const v = node[k];
      if (v && typeof v === 'object') stack.push({ node: v, caller: scope, klass: cls });
    }
  }
  return { refs, calls };
}

const JS_TS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PY = /\.(py|pyi)$/;

/** Python files are parsed by the stdlib-ast backend (src/py/extract.py), not oxc. */
export function isPython(file: string): boolean {
  return PY.test(file);
}

export function isParseable(file: string): boolean {
  return JS_TS.test(file) || PY.test(file);
}

const TYPE_DECL = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration']);

function isDeclNode(t: string): boolean {
  return t === 'FunctionDeclaration' || t === 'ClassDeclaration' || t === 'VariableDeclaration' || TYPE_DECL.has(t);
}

export function extractSymbols(file: string, text: string): FileParse {
  let res: ReturnType<typeof parseSync>;
  try {
    res = parseSync(file, text);
  } catch {
    return { symbols: [], imports: [], refs: {}, calls: [] };
  }
  const body = res?.program?.body;
  if (!Array.isArray(body)) return { symbols: [], imports: [], refs: {}, calls: [] };

  // Local top-level declarations by name, so `export { foo as bar }` can point
  // at foo's real coordinates rather than the specifier. Also track imported
  // bindings → their source export, so `import { x }; export { x }` is recognized
  // as a re-export (an edge to the real definition) rather than a local symbol.
  const locals = new Map<string, any>();
  const importedFrom = new Map<string, { source: string; name: string }>();
  // oxc types specifier names as Identifier | StringLiteral and declaration ids as a
  // broad node union; read the identifier name via a real runtime narrowing so this
  // stays type-honest under strict (not an `any` escape).
  const idName = (n: unknown): string | undefined =>
    n && typeof n === 'object' && 'name' in n && typeof (n as { name?: unknown }).name === 'string' ? (n as { name: string }).name : undefined;
  for (const node of body) {
    if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers ?? []) {
        const ln = idName(spec.local);
        if (!ln || importedFrom.has(ln)) continue;
        if (spec.type === 'ImportSpecifier') {
          const im = idName(spec.imported);
          if (im) importedFrom.set(ln, { source: node.source.value, name: im });
        } else if (spec.type === 'ImportDefaultSpecifier') importedFrom.set(ln, { source: node.source.value, name: 'default' });
        else if (spec.type === 'ImportNamespaceSpecifier') importedFrom.set(ln, { source: node.source.value, name: '*' });
      }
      continue;
    }
    const decl = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' ? node.declaration : node;
    if (decl && isDeclNode(decl.type)) {
      const did = idName((decl as { id?: unknown }).id);
      if (did && !locals.has(did)) locals.set(did, decl);
      if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations ?? []) if (d.id?.type === 'Identifier' && !locals.has(d.id.name)) locals.set(d.id.name, d);
      }
    }
  }

  const symbols: SymbolRec[] = [];
  const imports: ImportEdge[] = [];

  for (const node of body) {
    if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers ?? []) {
        if (spec.type === 'ImportSpecifier') {
          const im = idName(spec.imported);
          if (im) imports.push({ source: node.source.value, name: im });
        } else if (spec.type === 'ImportDefaultSpecifier') imports.push({ source: node.source.value, name: 'default' });
        // ImportNamespaceSpecifier: no per-symbol attribution — skipped.
      }
      continue;
    }
    if (node.type === 'ExportAllDeclaration' && node.source) {
      // `export * from './y'` — re-exports y's whole surface (name unknown).
      imports.push({ source: node.source.value, name: '*', reexport: true });
      continue;
    }
    if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        // Re-export `export { x } from './y'`: an edge to y::x, not a local def.
        for (const spec of node.specifiers ?? []) {
          if (spec.type !== 'ExportSpecifier') continue;
          const ln = idName(spec.local);
          if (ln) imports.push({ source: node.source.value, name: ln, reexport: true });
        }
        continue;
      }
      if (node.declaration) pushDecl(node.declaration, true, symbols);
      for (const spec of node.specifiers ?? []) {
        if (spec.type !== 'ExportSpecifier') continue;
        const exp = idName(spec.exported);
        if (!exp) continue;
        const local = idName(spec.local) ?? exp;
        const reexp = importedFrom.get(local);
        if (reexp) {
          // `import { x } …; export { x }` — re-export of an imported binding. Edge
          // to the true definition, NOT a local symbol (else this barrel shadows it).
          imports.push({ source: reexp.source, name: reexp.name, reexport: true });
          continue;
        }
        const target = locals.get(local) ?? spec;
        symbols.push({ name: exp, kind: 'ExportSpecifier', charStart: target.start, charEnd: target.end, exported: true });
      }
      continue;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      // Named `export default function foo` / `class Bar`: index it like any
      // declaration — real kind, and (for a class) its methods too.
      if (decl && (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id?.name) {
        const at = symbols.length;
        pushDecl(decl, true, symbols);
        if (symbols[at]) symbols[at].default = true; // foo is also the module's `default` export
        continue;
      }
      // Anonymous default (or an expression): a single 'default' entry.
      const t = decl ?? node;
      symbols.push({ name: 'default', kind: 'default', charStart: t.start, charEnd: t.end, exported: true });
      continue;
    }
    if (isDeclNode(node.type)) pushDecl(node, false, symbols);
  }
  const { refs, calls } = walkProgram(res.program);
  return { symbols, imports, refs, calls };
}

function pushDecl(decl: any, exported: boolean, out: SymbolRec[]): void {
  const visibility = exported ? undefined : 'module-private';
  if (decl.type === 'FunctionDeclaration') {
    if (decl.id?.name) out.push({ name: decl.id.name, kind: 'FunctionDeclaration', charStart: decl.start, charEnd: decl.end, exported, visibility });
    return;
  }
  if (decl.type === 'ClassDeclaration') {
    if (!decl.id?.name) return;
    const superName = decl.superClass?.type === 'Identifier' ? decl.superClass.name : undefined;
    out.push({ name: decl.id.name, kind: 'ClassDeclaration', charStart: decl.start, charEnd: decl.end, exported, visibility, extends: superName });
    for (const m of decl.body?.body ?? []) {
      if (m.type !== 'MethodDefinition' || !m.key) continue;
      const name = m.key.name ?? (m.key.type === 'Literal' ? String(m.key.value) : null);
      if (!name) continue;
      out.push({
        name,
        kind: 'ClassMethod',
        charStart: m.start,
        charEnd: m.end,
        exported,
        className: decl.id.name,
        static: !!m.static,
        visibility: m.accessibility ?? undefined,
      });
    }
    return;
  }
  if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations ?? []) {
      if (d.id?.type === 'Identifier') out.push({ name: d.id.name, kind: `${decl.kind}-var`, charStart: d.start, charEnd: d.end, exported, visibility });
    }
    return;
  }
  if (TYPE_DECL.has(decl.type) && typeof decl.id?.name === 'string') {
    out.push({ name: decl.id.name, kind: decl.type, charStart: decl.start, charEnd: decl.end, exported, visibility });
  }
}
