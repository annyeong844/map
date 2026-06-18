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
 * name in the *target* module ('default' for default imports). */
export interface ImportEdge {
  source: string;
  name: string;
}

export interface FileParse {
  symbols: SymbolRec[];
  imports: ImportEdge[];
  /** Identifier-name → occurrence count across the whole file AST (incl. the
   * declaration itself). Lets dead-code classification ask "is this symbol used
   * anywhere in its own file?" — AST-based, so comments/strings never inflate it.
   * Deliberately broad (counts member props / keys too) so it errs toward "used"
   * — a false "alive" is safe; a false "dead" is not. */
  refs: Record<string, number>;
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
    return { symbols: [], imports: [], refs: {} };
  }
  const body = res?.program?.body;
  if (!Array.isArray(body)) return { symbols: [], imports: [], refs: {} };

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
    if (node.type === 'ExportNamedDeclaration') {
      if (node.source) {
        // Re-export `export { x } from './y'`: an edge to y::x, not a local def.
        for (const spec of node.specifiers ?? []) {
          if (spec.type === 'ExportSpecifier' && spec.local?.name) imports.push({ source: node.source.value, name: spec.local.name });
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
      const t = node.declaration ?? node;
      symbols.push({ name: 'default', kind: 'default', charStart: t.start, charEnd: t.end, exported: true });
      continue;
    }
    if (isDeclNode(node.type)) pushDecl(node, false, symbols);
  }
  return { symbols, imports, refs: tallyIdentifiers(res.program) };
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
