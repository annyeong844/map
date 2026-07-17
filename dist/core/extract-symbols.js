import { parseSync } from 'oxc-parser';
import { isRecord } from './util.js';
/**
 * ONE deep traversal of the AST that tallies `refs`: every Identifier name's
 * occurrence count, the raw material for dead-code intraRefs. Iterative (big files
 * won't overflow the stack).
 */
function walkProgram(program) {
    const refs = {};
    Object.setPrototypeOf(refs, null);
    const stack = [program];
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object')
            continue;
        if (Array.isArray(node)) {
            for (const c of node)
                stack.push(c);
            continue;
        }
        if (!isRecord(node))
            continue;
        const rec = node;
        if (rec.type === 'Identifier' && typeof rec.name === 'string') {
            refs[rec.name] = (refs[rec.name] ?? 0) + 1;
        }
        for (const k in rec) {
            if (k === 'type')
                continue;
            const v = rec[k];
            if (v && typeof v === 'object')
                stack.push(v);
        }
    }
    return { refs };
}
const JS_TS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PY = /\.(py|pyi)$/;
/** Python files are parsed by the stdlib-ast backend (src/py/extract.py), not oxc. */
export function isPython(file) {
    return PY.test(file);
}
export function isParseable(file) {
    return JS_TS.test(file) || PY.test(file);
}
const TYPE_DECL = new Set([
    'TSInterfaceDeclaration',
    'TSTypeAliasDeclaration',
    'TSEnumDeclaration',
    'TSModuleDeclaration',
]);
function isDeclNode(value) {
    if (!isRecord(value) ||
        typeof value.type !== 'string' ||
        typeof value.start !== 'number' ||
        typeof value.end !== 'number') {
        return false;
    }
    const t = value.type;
    return (t === 'FunctionDeclaration' ||
        t === 'TSDeclareFunction' ||
        t === 'ClassDeclaration' ||
        t === 'VariableDeclaration' ||
        t === 'TSImportEqualsDeclaration' ||
        TYPE_DECL.has(t));
}
/** `function local() {}; export { local }` reaches the extractor twice: once as
 * a declaration and once as an export specifier pointing at the same range.
 * Keep the real declaration kind and promote it to exported. Aliases have a
 * different name, so `export { local as publicName }` remains independently routable. */
function consolidateLocalExports(symbols) {
    const out = [];
    const byCoordinate = new Map();
    for (const symbol of symbols) {
        const key = `${symbol.name}\0${symbol.charStart}\0${symbol.charEnd}`;
        const existingAt = byCoordinate.get(key);
        if (existingAt === undefined) {
            byCoordinate.set(key, out.length);
            out.push(symbol);
            continue;
        }
        const existing = out[existingAt];
        const preferred = existing.kind === 'ExportSpecifier' && symbol.kind !== 'ExportSpecifier'
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
function idName(node) {
    if (!isRecord(node))
        return undefined;
    if (typeof node.name === 'string')
        return node.name;
    return typeof node.value === 'string' ? node.value : undefined;
}
function bindingNames(value) {
    const names = [];
    const stack = [value];
    while (stack.length) {
        const node = stack.pop();
        if (!isRecord(node) || typeof node.type !== 'string')
            continue;
        if (node.type === 'Identifier') {
            if (typeof node.name === 'string')
                names.push(node.name);
            continue;
        }
        if (node.type === 'ObjectPattern') {
            if (Array.isArray(node.properties)) {
                for (let i = node.properties.length - 1; i >= 0; i--) {
                    stack.push(node.properties[i]);
                }
            }
            continue;
        }
        if (node.type === 'ArrayPattern') {
            if (Array.isArray(node.elements)) {
                for (let i = node.elements.length - 1; i >= 0; i--) {
                    stack.push(node.elements[i]);
                }
            }
            continue;
        }
        if (node.type === 'Property') {
            stack.push(node.value);
        }
        else if (node.type === 'AssignmentPattern') {
            stack.push(node.left);
        }
        else if (node.type === 'RestElement') {
            stack.push(node.argument);
        }
    }
    return names;
}
function externalImportSource(value) {
    if (!isRecord(value) || value.type !== 'TSImportEqualsDeclaration') {
        return undefined;
    }
    const reference = value.moduleReference;
    if (!isRecord(reference) || reference.type !== 'TSExternalModuleReference') {
        return undefined;
    }
    return idName(reference.expression);
}
function rememberLocal(locals, name, range) {
    const existing = locals.get(name);
    if (existing === undefined) {
        locals.set(name, range);
    }
    else if (Array.isArray(existing)) {
        existing.push(range);
    }
    else {
        locals.set(name, [existing, range]);
    }
}
function localTargets(ranges, fallback) {
    if (ranges === undefined)
        return [fallback];
    return Array.isArray(ranges) ? ranges : [ranges];
}
export function extractSymbols(file, text, opts = {}) {
    let res;
    try {
        // Parenthesis wrapper nodes carry no routing information. Omitting them
        // preserves declaration/identifier coordinates while shrinking the AST
        // that the refs walk must traverse and later collect.
        res = parseSync(file, text, { preserveParens: false });
    }
    catch (error) {
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
    const locals = new Map();
    const importedFrom = new Map();
    // oxc types specifier names as Identifier | StringLiteral and declaration ids as a
    // broad node union; read the identifier name via a real runtime narrowing so this
    // stays type-honest under strict (not an `any` escape).
    for (const node of body) {
        if (node.type === 'ImportDeclaration') {
            for (const spec of node.specifiers ?? []) {
                const ln = idName(spec.local);
                if (!ln || importedFrom.has(ln))
                    continue;
                if (spec.type === 'ImportSpecifier') {
                    const im = idName(spec.imported);
                    if (im !== undefined) {
                        importedFrom.set(ln, { source: node.source.value, name: im });
                    }
                }
                else if (spec.type === 'ImportDefaultSpecifier') {
                    importedFrom.set(ln, { source: node.source.value, name: 'default' });
                }
                else if (spec.type === 'ImportNamespaceSpecifier') {
                    importedFrom.set(ln, { source: node.source.value, name: '*' });
                }
            }
            continue;
        }
        if (node.type === 'TSImportEqualsDeclaration') {
            const local = idName(node.id);
            const source = externalImportSource(node);
            if (local && source !== undefined) {
                importedFrom.set(local, { source, name: '*' });
            }
            continue;
        }
        const decl = node.type === 'ExportNamedDeclaration' ||
            node.type === 'ExportDefaultDeclaration'
            ? node.declaration
            : node;
        if (isDeclNode(decl)) {
            const did = idName(decl.id);
            if (did)
                rememberLocal(locals, did, decl);
            if (decl.type === 'VariableDeclaration') {
                for (const d of decl.declarations ?? []) {
                    for (const name of bindingNames(d.id)) {
                        rememberLocal(locals, name, decl);
                    }
                }
            }
            else if (decl.type === 'TSImportEqualsDeclaration') {
                const local = idName(decl.id);
                const source = externalImportSource(decl);
                if (local && source !== undefined) {
                    importedFrom.set(local, { source, name: '*' });
                }
            }
        }
    }
    const symbols = [];
    const imports = [];
    let hasLocalExportSpecifiers = false;
    for (const node of body) {
        if (node.type === 'ImportDeclaration') {
            if ((node.specifiers?.length ?? 0) === 0) {
                imports.push({ source: node.source.value, name: '*' });
            }
            for (const spec of node.specifiers ?? []) {
                if (spec.type === 'ImportSpecifier') {
                    const im = idName(spec.imported);
                    if (im !== undefined) {
                        imports.push({ source: node.source.value, name: im });
                    }
                }
                else if (spec.type === 'ImportDefaultSpecifier') {
                    imports.push({ source: node.source.value, name: 'default' });
                }
                else if (spec.type === 'ImportNamespaceSpecifier') {
                    // Namespace members cannot be attributed to one exported symbol, but
                    // the module dependency still belongs in the topology graph.
                    imports.push({ source: node.source.value, name: '*' });
                }
            }
            continue;
        }
        if (node.type === 'TSImportEqualsDeclaration') {
            const source = externalImportSource(node);
            if (source !== undefined)
                imports.push({ source, name: '*' });
            continue;
        }
        if (node.type === 'ExportAllDeclaration' && node.source) {
            const namespaceName = idName(node.exported);
            if (namespaceName !== undefined) {
                // `export * as ns from './y'` creates one local namespace export. It is
                // a dependency edge, not a wildcard forwarding route.
                imports.push({ source: node.source.value, name: '*' });
                symbols.push({
                    name: namespaceName,
                    kind: 'ExportNamespaceSpecifier',
                    charStart: node.start,
                    charEnd: node.end,
                    exported: true,
                });
            }
            else {
                // `export * from './y'` forwards y's whole surface (name unknown).
                imports.push({ source: node.source.value, name: '*', reexport: true });
            }
            continue;
        }
        if (node.type === 'ExportNamedDeclaration') {
            if (node.source) {
                // Re-export `export { x as y } from './z'`: route y to z::x, not a
                // local definition. Keeping both names is required for aliased barrels.
                for (const spec of node.specifiers ?? []) {
                    if (spec.type !== 'ExportSpecifier')
                        continue;
                    const sourceName = idName(spec.local);
                    if (sourceName === undefined)
                        continue;
                    const name = idName(spec.exported) ?? sourceName;
                    const edge = {
                        source: node.source.value,
                        name,
                        reexport: true,
                    };
                    if (sourceName !== name)
                        edge.sourceName = sourceName;
                    imports.push(edge);
                }
                continue;
            }
            if (isDeclNode(node.declaration)) {
                const source = externalImportSource(node.declaration);
                if (source !== undefined)
                    imports.push({ source, name: '*' });
                pushDecl(node.declaration, true, symbols, node);
            }
            for (const spec of node.specifiers ?? []) {
                if (spec.type !== 'ExportSpecifier')
                    continue;
                const exp = idName(spec.exported);
                if (exp === undefined)
                    continue;
                const local = idName(spec.local) ?? exp;
                const reexp = importedFrom.get(local);
                if (reexp) {
                    if (reexp.name === '*') {
                        // `import * as ns …; export { ns as api }` creates a namespace
                        // object owned by this module. It must not behave like `export *`.
                        hasLocalExportSpecifiers = true;
                        symbols.push({
                            name: exp,
                            kind: 'ExportNamespaceSpecifier',
                            charStart: node.start,
                            charEnd: node.end,
                            exported: true,
                        });
                    }
                    else {
                        // Re-export an imported binding to the true definition. Preserve
                        // aliases so the fan-in router can follow `x as y` chains.
                        const edge = {
                            source: reexp.source,
                            name: exp,
                            reexport: true,
                        };
                        if (reexp.name !== exp)
                            edge.sourceName = reexp.name;
                        imports.push(edge);
                    }
                    continue;
                }
                hasLocalExportSpecifiers = true;
                for (const target of localTargets(locals.get(local), spec)) {
                    symbols.push({
                        name: exp,
                        kind: 'ExportSpecifier',
                        charStart: target.start,
                        charEnd: target.end,
                        exported: true,
                    });
                }
            }
            continue;
        }
        if (node.type === 'TSExportAssignment') {
            const local = idName(node.expression);
            const targets = local ? locals.get(local) : undefined;
            if (local && targets) {
                hasLocalExportSpecifiers = true;
                for (const target of localTargets(targets, node)) {
                    symbols.push({
                        name: local,
                        kind: 'ExportSpecifier',
                        charStart: target.start,
                        charEnd: target.end,
                        exported: true,
                    });
                }
            }
            else {
                symbols.push({
                    name: 'export=',
                    kind: 'TSExportAssignment',
                    charStart: node.start,
                    charEnd: node.end,
                    exported: true,
                });
            }
            continue;
        }
        if (node.type === 'TSNamespaceExportDeclaration') {
            const name = idName(node.id);
            if (name) {
                symbols.push({
                    name,
                    kind: 'TSNamespaceExportDeclaration',
                    charStart: node.start,
                    charEnd: node.end,
                    exported: true,
                });
            }
            continue;
        }
        if (node.type === 'ExportDefaultDeclaration') {
            const decl = node.declaration;
            // Declarations keep their real kind. Anonymous functions/classes use the
            // routable name `default`; arbitrary expressions remain generic defaults.
            const declaredName = isDeclNode(decl) ? idName(decl.id) : undefined;
            const anonymousDeclaration = isDeclNode(decl) &&
                (decl.type === 'FunctionDeclaration' ||
                    decl.type === 'ClassDeclaration');
            if (isDeclNode(decl) && (declaredName || anonymousDeclaration)) {
                const at = symbols.length;
                pushDecl(decl, true, symbols, node, declaredName ? undefined : 'default');
                if (symbols[at])
                    symbols[at].default = true;
                continue;
            }
            // Default expression: a single generic `default` entry.
            symbols.push({
                name: 'default',
                kind: 'default',
                charStart: node.start,
                charEnd: node.end,
                exported: true,
            });
            continue;
        }
        if (isDeclNode(node))
            pushDecl(node, false, symbols);
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
function pushDecl(decl, exported, out, topLevelRange, fallbackName) {
    const visibility = exported ? undefined : 'module-private';
    const wrapperStart = topLevelRange?.start ?? decl.start;
    const firstDecoratorStart = decl.decorators?.[0]?.start;
    const topLevelStart = typeof firstDecoratorStart === 'number'
        ? Math.min(wrapperStart, firstDecoratorStart)
        : wrapperStart;
    const topLevelEnd = topLevelRange?.end ?? decl.end;
    if (decl.type === 'FunctionDeclaration' ||
        decl.type === 'TSDeclareFunction') {
        const name = idName(decl.id) ?? fallbackName;
        if (name) {
            out.push({
                name,
                kind: decl.type,
                charStart: topLevelStart,
                charEnd: topLevelEnd,
                exported,
                visibility,
            });
        }
        return;
    }
    if (decl.type === 'ClassDeclaration') {
        const className = idName(decl.id) ?? fallbackName;
        if (!className)
            return;
        const superName = decl.superClass?.type === 'Identifier' ? decl.superClass.name : undefined;
        out.push({
            name: className,
            kind: 'ClassDeclaration',
            charStart: topLevelStart,
            charEnd: topLevelEnd,
            exported,
            visibility,
            extends: superName,
        });
        for (const m of decl.body?.body ?? []) {
            if ((m.type !== 'MethodDefinition' &&
                m.type !== 'TSAbstractMethodDefinition') ||
                !m.key) {
                continue;
            }
            let name = null;
            if (m.computed) {
                if (m.key.type === 'Literal')
                    name = String(m.key.value);
            }
            else {
                name =
                    m.key.name ?? (m.key.type === 'Literal' ? String(m.key.value) : null);
            }
            if (name === null)
                continue;
            out.push({
                name,
                kind: 'ClassMethod',
                charStart: m.start,
                charEnd: m.end,
                exported,
                className,
                static: !!m.static,
                visibility: m.key.type === 'PrivateIdentifier'
                    ? 'private'
                    : (m.accessibility ?? undefined),
            });
        }
        return;
    }
    if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations ?? []) {
            for (const name of bindingNames(d.id)) {
                out.push({
                    name,
                    kind: `${decl.kind}-var`,
                    charStart: topLevelStart,
                    charEnd: topLevelEnd,
                    exported,
                    visibility,
                });
            }
        }
        return;
    }
    const name = idName(decl.id);
    if (decl.type === 'TSImportEqualsDeclaration') {
        if (exported && name) {
            out.push({
                name,
                kind: decl.type,
                charStart: topLevelStart,
                charEnd: topLevelEnd,
                exported: true,
            });
        }
        return;
    }
    if (TYPE_DECL.has(decl.type) && name !== undefined) {
        out.push({
            name,
            kind: decl.type,
            charStart: topLevelStart,
            charEnd: topLevelEnd,
            exported,
            visibility,
        });
    }
}
