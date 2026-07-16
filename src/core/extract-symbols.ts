import { parseSync } from 'oxc-parser';
import { isRecord } from './util.ts';

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
  namePath?: string;
  kind: string;
  charStart: number;
  charEnd: number;
  anchorOffset?: number;
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

/**
 * ONE deep traversal of the AST that tallies `refs`: every Identifier name's
 * occurrence count, the raw material for dead-code intraRefs. Iterative (big files
 * won't overflow the stack).
 */
function walkProgram(program: unknown): { refs: Record<string, number> } {
  const refs: Record<string, number> = {};
  Object.setPrototypeOf(refs, null);
  const stack: unknown[] = [program];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const c of node) stack.push(c);
      continue;
    }
    if (!isRecord(node)) continue;
    const rec = node;
    if (rec.type === 'Identifier' && typeof rec.name === 'string') {
      refs[rec.name] = (refs[rec.name] ?? 0) + 1;
    }
    for (const k in rec) {
      if (k === 'type') continue;
      const v = rec[k];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return { refs };
}

/** The slice of an oxc declaration node that `pushDecl` reads — a minimal structural view of
 * the AST boundary so the extractor stays `any`-free (oxc's full union is heavier than the
 * handful of fields used here). Coordinates (`start`/`end`) plus the kind-specific shapes. */
interface DeclNode {
  type: string;
  start: number;
  end: number;
  id?: { name?: string; type?: string };
  superClass?: { type?: string; name?: string };
  body?: { body?: DeclNode[] };
  declarations?: DeclNode[];
  kind?: string;
  key?: { name?: string; type?: string; value?: unknown };
  static?: boolean;
  accessibility?: string;
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

const TYPE_DECL = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
]);

function isDeclNode(value: unknown): value is DeclNode {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    typeof value.start !== 'number' ||
    typeof value.end !== 'number'
  ) {
    return false;
  }
  const t = value.type;
  return (
    t === 'FunctionDeclaration' ||
    t === 'ClassDeclaration' ||
    t === 'VariableDeclaration' ||
    TYPE_DECL.has(t)
  );
}

/** `function local() {}; export { local }` reaches the extractor twice: once as
 * a declaration and once as an export specifier pointing at the same range.
 * Keep the real declaration kind and promote it to exported. Aliases have a
 * different name, so `export { local as publicName }` remains independently routable. */
function consolidateLocalExports(symbols: SymbolRec[]): SymbolRec[] {
  const out: SymbolRec[] = [];
  const byCoordinate = new Map<string, number>();
  for (const symbol of symbols) {
    const key = `${symbol.name}\0${symbol.charStart}\0${symbol.charEnd}`;
    const existingAt = byCoordinate.get(key);
    if (existingAt === undefined) {
      byCoordinate.set(key, out.length);
      out.push(symbol);
      continue;
    }
    const existing = out[existingAt];
    const preferred =
      existing.kind === 'ExportSpecifier' && symbol.kind !== 'ExportSpecifier'
        ? symbol
        : existing;
    const exported = existing.exported || symbol.exported;
    out[existingAt] = {
      ...preferred,
      exported,
      visibility: exported ? undefined : preferred.visibility,
      default: existing.default || symbol.default || undefined,
    };
  }
  return out;
}

function idName(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  return typeof node.name === 'string' ? node.name : undefined;
}

export function extractSymbols(
  file: string,
  text: string,
  opts: { includeRefs?: boolean } = {},
): FileParse {
  let res: ReturnType<typeof parseSync>;
  try {
    // Parenthesis wrapper nodes carry no routing information. Omitting them
    // preserves declaration/identifier coordinates while shrinking the AST
    // that the refs walk must traverse and later collect.
    res = parseSync(file, text, { preserveParens: false });
  } catch (error) {
    throw new Error(`Oxc could not parse ${file}.`, { cause: error });
  }
  const body = res?.program?.body;
  if (!Array.isArray(body)) {
    throw new Error(`Oxc returned no program body for ${file}.`);
  }

  // Local top-level declarations by name, so `export { foo as bar }` can point
  // at foo's real coordinates rather than the specifier. Also track imported
  // bindings → their source export, so `import { x }; export { x }` is recognized
  // as a re-export (an edge to the real definition) rather than a local symbol.
  const locals = new Map<string, { start: number; end: number }>();
  const importedFrom = new Map<string, { source: string; name: string }>();
  // oxc types specifier names as Identifier | StringLiteral and declaration ids as a
  // broad node union; read the identifier name via a real runtime narrowing so this
  // stays type-honest under strict (not an `any` escape).
  for (const node of body) {
    if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers ?? []) {
        const ln = idName(spec.local);
        if (!ln || importedFrom.has(ln)) continue;
        if (spec.type === 'ImportSpecifier') {
          const im = idName(spec.imported);
          if (im) importedFrom.set(ln, { source: node.source.value, name: im });
        } else if (spec.type === 'ImportDefaultSpecifier') {
          importedFrom.set(ln, { source: node.source.value, name: 'default' });
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          importedFrom.set(ln, { source: node.source.value, name: '*' });
        }
      }
      continue;
    }
    const decl =
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportDefaultDeclaration'
        ? node.declaration
        : node;
    if (isDeclNode(decl)) {
      const did = idName(decl.id);
      if (did && !locals.has(did)) locals.set(did, decl);
      if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations ?? []) {
          if (d.id?.type === 'Identifier' && !locals.has(d.id.name)) {
            locals.set(d.id.name, d);
          }
        }
      }
    }
  }

  const symbols: SymbolRec[] = [];
  const imports: ImportEdge[] = [];
  let hasLocalExportSpecifiers = false;

  for (const node of body) {
    if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers ?? []) {
        if (spec.type === 'ImportSpecifier') {
          const im = idName(spec.imported);
          if (im) imports.push({ source: node.source.value, name: im });
        } else if (spec.type === 'ImportDefaultSpecifier') {
          imports.push({ source: node.source.value, name: 'default' });
        }
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
          if (ln) {
            imports.push({
              source: node.source.value,
              name: ln,
              reexport: true,
            });
          }
        }
        continue;
      }
      if (isDeclNode(node.declaration)) {
        pushDecl(node.declaration, true, symbols, node);
      }
      for (const spec of node.specifiers ?? []) {
        if (spec.type !== 'ExportSpecifier') continue;
        const exp = idName(spec.exported);
        if (!exp) continue;
        const local = idName(spec.local) ?? exp;
        const reexp = importedFrom.get(local);
        if (reexp) {
          // `import { x } …; export { x }` — re-export of an imported binding. Edge
          // to the true definition, NOT a local symbol (else this barrel shadows it).
          imports.push({
            source: reexp.source,
            name: reexp.name,
            reexport: true,
          });
          continue;
        }
        const target = locals.get(local) ?? spec;
        hasLocalExportSpecifiers = true;
        symbols.push({
          name: exp,
          kind: 'ExportSpecifier',
          charStart: target.start,
          charEnd: target.end,
          exported: true,
        });
      }
      continue;
    }
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = node.declaration;
      // Named `export default function foo` / `class Bar`: index it like any
      // declaration — real kind, and (for a class) its methods too.
      if (
        isDeclNode(decl) &&
        (decl.type === 'FunctionDeclaration' ||
          decl.type === 'ClassDeclaration') &&
        decl.id?.name
      ) {
        const at = symbols.length;
        pushDecl(decl, true, symbols, node);
        if (symbols[at]) symbols[at].default = true; // foo is also the module's `default` export
        continue;
      }
      // Anonymous default (or an expression): a single 'default' entry.
      symbols.push({
        name: 'default',
        kind: 'default',
        charStart: node.start,
        charEnd: node.end,
        exported: true,
      });
      continue;
    }
    if (isDeclNode(node)) pushDecl(node, false, symbols);
  }
  const refs = opts.includeRefs === false ? {} : walkProgram(res.program).refs;
  return {
    symbols: hasLocalExportSpecifiers
      ? consolidateLocalExports(symbols)
      : symbols,
    imports,
    refs,
  };
}

function pushDecl(
  decl: DeclNode,
  exported: boolean,
  out: SymbolRec[],
  topLevelRange?: { start: number; end: number },
): void {
  const visibility = exported ? undefined : 'module-private';
  const topLevelStart = topLevelRange?.start ?? decl.start;
  const topLevelEnd = topLevelRange?.end ?? decl.end;
  if (decl.type === 'FunctionDeclaration') {
    if (decl.id?.name) {
      out.push({
        name: decl.id.name,
        kind: 'FunctionDeclaration',
        charStart: topLevelStart,
        charEnd: topLevelEnd,
        exported,
        visibility,
      });
    }
    return;
  }
  if (decl.type === 'ClassDeclaration') {
    if (!decl.id?.name) return;
    const superName =
      decl.superClass?.type === 'Identifier' ? decl.superClass.name : undefined;
    out.push({
      name: decl.id.name,
      kind: 'ClassDeclaration',
      charStart: topLevelStart,
      charEnd: topLevelEnd,
      exported,
      visibility,
      extends: superName,
    });
    for (const m of decl.body?.body ?? []) {
      if (m.type !== 'MethodDefinition' || !m.key) continue;
      const name =
        m.key.name ?? (m.key.type === 'Literal' ? String(m.key.value) : null);
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
      if (d.id?.type === 'Identifier' && d.id.name) {
        out.push({
          name: d.id.name,
          kind: `${decl.kind}-var`,
          charStart: topLevelRange?.start ?? d.start,
          charEnd: topLevelRange?.end ?? d.end,
          exported,
          visibility,
        });
      }
    }
    return;
  }
  if (TYPE_DECL.has(decl.type) && typeof decl.id?.name === 'string') {
    out.push({
      name: decl.id.name,
      kind: decl.type,
      charStart: topLevelStart,
      charEnd: topLevelEnd,
      exported,
      visibility,
    });
  }
}
