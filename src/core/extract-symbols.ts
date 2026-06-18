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
 * `member` marks `obj.m()` (name-only — not type-resolved, so ambiguous). */
export interface CallSite {
  caller: string;
  callee: string;
  member: boolean;
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
 * Collect call sites, attributing each to the enclosing top-level symbol — a
 * function declaration, a class method, or a `const fn = () => …`. Direct calls
 * (`foo()`) carry the callee name; member calls (`obj.m()`) are tagged so the
 * resolver can treat them as ambiguous (no type info to pick the method).
 * Iterative, carrying the current caller down the stack.
 */
function collectCalls(program: unknown): CallSite[] {
  const out: CallSite[] = [];
  const stack: { node: any; caller: string }[] = [{ node: program, caller: '<module>' }];
  while (stack.length) {
    const { node, caller } = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push({ node: c, caller });
      continue;
    }
    let scope = caller;
    if (node.type === 'FunctionDeclaration' && node.id?.name) scope = node.id.name;
    else if (node.type === 'MethodDefinition' && node.key?.name) scope = node.key.name;
    else if (node.type === 'VariableDeclarator' && node.id?.name && (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')) scope = node.id.name;
    if (node.type === 'CallExpression' && node.callee) {
      const c = node.callee;
      if (c.type === 'Identifier') out.push({ caller: scope, callee: c.name, member: false });
      else if (c.type === 'MemberExpression' && !c.computed && c.property?.name) out.push({ caller: scope, callee: c.property.name, member: true });
    }
    for (const k in node) {
      if (k === 'type') continue;
      const v = node[k];
      if (v && typeof v === 'object') stack.push({ node: v, caller: scope });
    }
  }
  return out;
}

/** Count every Identifier name in the AST (iterative — big files won't overflow the stack). */
function tallyIdentifiers(program: unknown): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  const stack: unknown[] = [program];
  while (stack.length) {
    const node = stack.pop() as any;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push(c);
      continue;
    }
    if (node.type === 'Identifier' && typeof node.name === 'string') {
      counts[node.name] = (counts[node.name] ?? 0) + 1;
    }
    for (const k in node) {
      if (k === 'type') continue;
      const v = node[k];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return counts;
}

const JS_TS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export function isParseable(file: string): boolean {
  return JS_TS.test(file);
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
  // at foo's real coordinates rather than the specifier.
  const locals = new Map<string, any>();
  for (const node of body) {
    const decl = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' ? node.declaration : node;
    if (decl && isDeclNode(decl.type)) {
      if (decl.id?.name && !locals.has(decl.id.name)) locals.set(decl.id.name, decl);
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
        if (spec.type === 'ImportSpecifier' && spec.imported?.name) imports.push({ source: node.source.value, name: spec.imported.name });
        else if (spec.type === 'ImportDefaultSpecifier') imports.push({ source: node.source.value, name: 'default' });
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
          if (spec.type === 'ExportSpecifier' && spec.local?.name) imports.push({ source: node.source.value, name: spec.local.name, reexport: true });
        }
        continue;
      }
      if (node.declaration) pushDecl(node.declaration, true, symbols);
      for (const spec of node.specifiers ?? []) {
        if (spec.type !== 'ExportSpecifier' || !spec.exported?.name) continue;
        const local = spec.local?.name ?? spec.exported.name;
        const target = locals.get(local) ?? spec;
        symbols.push({ name: spec.exported.name, kind: 'ExportSpecifier', charStart: target.start, charEnd: target.end, exported: true });
      }
      continue;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      // Named `export default function foo` / `class Bar`: index it like any
      // declaration — real kind, and (for a class) its methods too.
      if (decl && (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id?.name) {
        pushDecl(decl, true, symbols);
        continue;
      }
      // Anonymous default (or an expression): a single 'default' entry.
      const t = decl ?? node;
      symbols.push({ name: 'default', kind: 'default', charStart: t.start, charEnd: t.end, exported: true });
      continue;
    }
    if (isDeclNode(node.type)) pushDecl(node, false, symbols);
  }
  return { symbols, imports, refs: tallyIdentifiers(res.program), calls: collectCalls(res.program) };
}

function pushDecl(decl: any, exported: boolean, out: SymbolRec[]): void {
  const visibility = exported ? undefined : 'module-private';
  if (decl.type === 'FunctionDeclaration') {
    if (decl.id?.name) out.push({ name: decl.id.name, kind: 'FunctionDeclaration', charStart: decl.start, charEnd: decl.end, exported, visibility });
    return;
  }
  if (decl.type === 'ClassDeclaration') {
    if (!decl.id?.name) return;
    out.push({ name: decl.id.name, kind: 'ClassDeclaration', charStart: decl.start, charEnd: decl.end, exported, visibility });
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
