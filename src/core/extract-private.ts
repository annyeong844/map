import { parseSync } from 'oxc-parser';

/**
 * Module-private top-level definitions — the coverage the symbol graph leaves
 * out (it indexes the export surface, since that is all dead-export / fan-in
 * analysis needs). The map fills the gap by parsing each source file with oxc
 * and keeping only what isn't exported.
 *
 * oxc returns UTF-16 char offsets for start/end — identical to the convention
 * the rest of the map slices by, so no offset conversion is needed.
 */
export interface PrivateDef {
  name: string;
  kind: string;
  charStart: number;
  charEnd: number;
}

const JS_TS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Only files oxc can parse (TS/JS family). The symbol graph still covers .vue/.py/.go exports. */
export function isParseable(file: string): boolean {
  return JS_TS.test(file);
}

/**
 * Top-level declarations NOT already in the file's export surface.
 * Exported declarations arrive as Export* nodes (skipped here); a name that is
 * declared bare then exported via `export { foo }` is filtered by exportedNames.
 */
export function extractPrivateDefs(file: string, text: string, exportedNames: Set<string>): PrivateDef[] {
  let res: ReturnType<typeof parseSync>;
  try {
    res = parseSync(file, text);
  } catch {
    return [];
  }
  const body = res?.program?.body;
  if (!Array.isArray(body)) return [];

  const out: PrivateDef[] = [];
  const add = (name: string | undefined, kind: string, node: { start: number; end: number }) => {
    if (!name || exportedNames.has(name)) return;
    out.push({ name, kind, charStart: node.start, charEnd: node.end });
  };

  for (const node of body) {
    switch (node.type) {
      case 'FunctionDeclaration':
        add(node.id?.name, 'FunctionDeclaration', node);
        break;
      case 'ClassDeclaration':
        add(node.id?.name, 'ClassDeclaration', node);
        break;
      case 'VariableDeclaration':
        for (const d of node.declarations ?? []) {
          if (d.id?.type === 'Identifier') add(d.id.name, `${node.kind}-var`, d);
        }
        break;
      case 'TSInterfaceDeclaration':
        add(node.id?.name, 'TSInterfaceDeclaration', node);
        break;
      case 'TSTypeAliasDeclaration':
        add(node.id?.name, 'TSTypeAliasDeclaration', node);
        break;
      case 'TSEnumDeclaration':
        add(node.id?.name, 'TSEnumDeclaration', node);
        break;
      case 'TSModuleDeclaration':
        if (typeof node.id?.name === 'string') add(node.id.name, 'TSModuleDeclaration', node);
        break;
    }
  }
  return out;
}
