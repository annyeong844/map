/**
 * Config-less TypeScript caller supplement.
 *
 * This is a filesystem/Oxc reverse-import analysis, not an LSP concern. It is
 * deliberately over-approximate and labels every site it contributes.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProjectFile } from './project-snapshot.ts';

const LINE_FEED_BYTE = 10;
const STATIC_GRAPH_READ_CONCURRENCY = 32;
const MAX_DEGRADATION_EXAMPLES = 8;

const importOxcParser = () => import('oxc-parser');
type OxcParser = Awaited<ReturnType<typeof importOxcParser>>;
let oxcParserPromise: Promise<OxcParser> | null = null;

function loadOxcParser(): Promise<OxcParser> {
  oxcParserPromise ??= importOxcParser();
  return oxcParserPromise;
}

function staticModuleSpecifiers(
  file: string,
  text: string,
  parser: OxcParser,
): string[] {
  const parsed = parser.parseSync(file, text);
  return [
    ...parsed.module.staticImports.map((item) => item.moduleRequest.value),
    ...parsed.module.staticExports.flatMap((item) =>
      item.entries.flatMap((entry) =>
        entry.moduleRequest ? [entry.moduleRequest.value] : [],
      ),
    ),
  ];
}

function projectPathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function modulePathCandidates(base: string): string[] {
  const extension = extname(base).toLowerCase();
  const stem = extension ? base.slice(0, -extension.length) : base;
  if (extension === '.js') return [base, `${stem}.ts`, `${stem}.tsx`];
  if (extension === '.mjs') return [base, `${stem}.mts`];
  if (extension === '.cjs') return [base, `${stem}.cts`];
  if (extension === '.jsx') return [base, `${stem}.tsx`];
  if (extension) return [base];
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.mts'),
    join(base, 'index.cts'),
    join(base, 'index.js'),
    join(base, 'index.jsx'),
    join(base, 'index.mjs'),
    join(base, 'index.cjs'),
  ];
}

function resolveProjectImport(
  source: string,
  specifier: string,
  projectPaths: Map<string, string>,
): string | null {
  let base: string;
  try {
    if (specifier.startsWith('file:')) {
      base = fileURLToPath(specifier);
    } else if (specifier.startsWith('.') || isAbsolute(specifier)) {
      base = resolve(dirname(source), specifier);
    } else if (specifier.startsWith('#')) {
      base = createRequire(source).resolve(specifier);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  for (const candidate of modulePathCandidates(base)) {
    const projectPath = projectPaths.get(projectPathKey(candidate));
    if (projectPath) return projectPath;
  }
  return null;
}

interface StaticProjectGraph {
  reverse: Map<string, string[]>;
  paths: Map<string, string>;
  failureCount: number;
  failureExamples: string[];
}

export type StaticSupplementDegradation = {
  failureCount: number;
  examples: string[];
};

interface StaticImporterEvidence {
  calls: { line: number; character: number }[];
  reexports: string[];
}

function sourceLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === LINE_FEED_BYTE) starts.push(index + 1);
  }
  return starts;
}

function positionAt(
  starts: number[],
  offset: number,
): { line: number; character: number } {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  const line = Math.max(0, low - 1);
  return { line, character: offset - starts[line] };
}

function analyzeStaticImporter(
  text: string,
  source: string,
  target: string,
  exportedName: string,
  graph: StaticProjectGraph,
  parser: OxcParser,
): StaticImporterEvidence {
  const parsed = parser.parseSync(source, text);
  const { ExportImportNameKind, ExportLocalNameKind, ImportNameKind } = parser;
  const locals = new Set<string>();
  const namespaces = new Set<string>();
  const reexports = new Set<string>();

  const targetKey = projectPathKey(target);
  for (const imported of parsed.module.staticImports) {
    const resolved = resolveProjectImport(
      source,
      imported.moduleRequest.value,
      graph.paths,
    );
    if (!resolved || projectPathKey(resolved) !== targetKey) continue;
    for (const entry of imported.entries) {
      if (entry.isType) continue;
      if (
        (entry.importName.kind === ImportNameKind.Name &&
          entry.importName.name === exportedName) ||
        (entry.importName.kind === ImportNameKind.Default &&
          exportedName === 'default')
      ) {
        locals.add(entry.localName.value);
      } else if (entry.importName.kind === ImportNameKind.NamespaceObject) {
        namespaces.add(entry.localName.value);
      }
    }
  }

  for (const exported of parsed.module.staticExports) {
    for (const entry of exported.entries) {
      if (entry.isType) continue;
      if (entry.moduleRequest) {
        const resolved = resolveProjectImport(
          source,
          entry.moduleRequest.value,
          graph.paths,
        );
        if (!resolved || projectPathKey(resolved) !== targetKey) continue;
        if (entry.importName.kind === ExportImportNameKind.AllButDefault) {
          reexports.add(exportedName);
        } else if (
          entry.importName.kind === ExportImportNameKind.Name &&
          entry.importName.name === exportedName &&
          entry.exportName.name
        ) {
          reexports.add(entry.exportName.name);
        }
      } else if (
        entry.localName.kind === ExportLocalNameKind.Name &&
        entry.localName.name &&
        locals.has(entry.localName.name) &&
        entry.exportName.name
      ) {
        reexports.add(entry.exportName.name);
      }
    }
  }

  const callOffsets = new Set<number>();
  new parser.Visitor({
    CallExpression(node) {
      const callee = node.callee;
      if (callee.type === 'Identifier' && locals.has(callee.name)) {
        callOffsets.add(callee.start);
        return;
      }
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        namespaces.has(callee.object.name) &&
        callee.property.type === 'Identifier' &&
        callee.property.name === exportedName
      ) {
        callOffsets.add(callee.property.start);
      }
    },
  }).visit(parsed.program);

  const lineStarts = sourceLineStarts(text);
  return {
    calls: [...callOffsets].map((offset) => positionAt(lineStarts, offset)),
    reexports: [...reexports],
  };
}

interface StaticCallSite {
  uri: string;
  line: number;
  character: number;
  basis: 'static-import-call';
}

export class StaticImportSupplement {
  private graph: StaticProjectGraph | null = null;
  private readonly root: string;
  private readonly projectFiles: ReadonlyMap<string, ProjectFile>;

  constructor(root: string, projectFiles: ReadonlyMap<string, ProjectFile>) {
    this.root = resolve(root);
    this.projectFiles = projectFiles;
  }

  private hasConfiguredProject(file: string): boolean {
    let dir = dirname(resolve(file));
    for (;;) {
      if (
        this.projectFiles.has(join(dir, 'tsconfig.json')) ||
        this.projectFiles.has(join(dir, 'jsconfig.json'))
      ) {
        return true;
      }
      if (dir === this.root) return false;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }

  private async projectGraph(signal: AbortSignal): Promise<StaticProjectGraph> {
    if (this.graph) return this.graph;
    signal.throwIfAborted();
    const parser = await loadOxcParser();
    signal.throwIfAborted();
    const sources = [...this.projectFiles]
      .filter(([, file]) => file.kind === 'ts')
      .map(([path]) => path);
    const projectPaths = new Map(
      sources.map((path) => [projectPathKey(path), path]),
    );
    const reverse = new Map<string, string[]>();
    let failureCount = 0;
    const failureExamples: string[] = [];
    const recordFailure = (source: string, error: unknown): void => {
      failureCount++;
      if (failureExamples.length >= MAX_DEGRADATION_EXAMPLES) return;
      failureExamples.push(
        `${source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    };
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < sources.length) {
        signal.throwIfAborted();
        const source = sources[cursor++];
        let text: string;
        try {
          text = await readFile(source, { encoding: 'utf8', signal });
        } catch (error) {
          signal.throwIfAborted();
          recordFailure(source, error);
          continue;
        }
        for (const specifier of staticModuleSpecifiers(source, text, parser)) {
          const target = resolveProjectImport(source, specifier, projectPaths);
          if (!target) continue;
          const targetKey = projectPathKey(target);
          const importers = reverse.get(targetKey);
          if (importers) importers.push(source);
          else reverse.set(targetKey, [source]);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(STATIC_GRAPH_READ_CONCURRENCY, sources.length) },
        worker,
      ),
    );
    signal.throwIfAborted();
    this.graph = {
      reverse,
      paths: projectPaths,
      failureCount,
      failureExamples,
    };
    return this.graph;
  }

  async callers(
    queriedFile: string,
    name: string | null,
    signal: AbortSignal,
  ): Promise<{
    applied: boolean;
    locations: StaticCallSite[];
    degradation: StaticSupplementDegradation | null;
  }> {
    signal.throwIfAborted();
    if (this.hasConfiguredProject(queriedFile) || !name || name.includes('.')) {
      return { applied: false, locations: [], degradation: null };
    }

    const graph = await this.projectGraph(signal);
    const parser = await loadOxcParser();
    let failureCount = graph.failureCount;
    const failureExamples = [...graph.failureExamples];
    const queue = [{ file: resolve(queriedFile), exportedName: name }];
    const seen = new Set(
      queue.map((item) => `${projectPathKey(item.file)}\0${item.exportedName}`),
    );
    const locations: StaticCallSite[] = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      signal.throwIfAborted();
      const target = queue[cursor];
      for (const importer of graph.reverse.get(projectPathKey(target.file)) ??
        []) {
        let text: string;
        try {
          text = await readFile(importer, { encoding: 'utf8', signal });
        } catch (error) {
          signal.throwIfAborted();
          failureCount++;
          if (failureExamples.length < MAX_DEGRADATION_EXAMPLES) {
            failureExamples.push(
              `${importer}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          continue;
        }
        const evidence = analyzeStaticImporter(
          text,
          importer,
          target.file,
          target.exportedName,
          graph,
          parser,
        );
        for (const call of evidence.calls) {
          locations.push({
            uri: pathToFileURL(importer).href,
            ...call,
            basis: 'static-import-call',
          });
        }
        for (const exportedName of evidence.reexports) {
          const key = `${projectPathKey(importer)}\0${exportedName}`;
          if (seen.has(key)) continue;
          seen.add(key);
          queue.push({ file: importer, exportedName });
        }
      }
    }
    return {
      applied: true,
      locations,
      degradation:
        failureCount === 0
          ? null
          : {
              failureCount,
              examples: failureExamples,
            },
    };
  }
}
