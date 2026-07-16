import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

const SOURCE_EXTENSION_BY_RUNTIME_EXTENSION = new Map([
  ['.js', '.ts'],
  ['.jsx', '.tsx'],
  ['.mjs', '.mts'],
  ['.cjs', '.cts'],
]);
const SOURCE_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

export interface FileIdentity {
  mtimeMs: number;
  size: number;
  ctimeMs: number;
  ino: number;
}

export function fileIdentity(path: string): FileIdentity | null {
  try {
    const value = statSync(path);
    return {
      mtimeMs: value.mtimeMs,
      size: value.size,
      ctimeMs: value.ctimeMs,
      ino: value.ino,
    };
  } catch {
    return null;
  }
}

export function sourceIdentityChanged(
  start: FileIdentity | null,
  current: FileIdentity | null,
): boolean {
  if (!start || !current) return start !== current;
  return (
    start.mtimeMs !== current.mtimeMs ||
    start.size !== current.size ||
    start.ctimeMs !== current.ctimeMs ||
    start.ino !== current.ino
  );
}

function resolveLocalModuleFile(
  importer: string,
  specifier: string,
): string | null {
  const base = resolve(dirname(importer), specifier);
  const extension = extname(base);
  const sourceExtension = SOURCE_EXTENSION_BY_RUNTIME_EXTENSION.get(extension);
  const candidates = extension
    ? [
        base,
        ...(sourceExtension
          ? [`${base.slice(0, -extension.length)}${sourceExtension}`]
          : []),
      ]
    : [
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
        join(base, 'index.js'),
      ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // A missing candidate is expected while resolving extension variants.
    }
  }
  return null;
}

export function resolveLocalModuleFiles(
  entryFile: string,
  specifiers: readonly string[],
): string[] {
  const entry = resolve(entryFile);
  const sourceMode = SOURCE_FILE_EXTENSIONS.has(extname(entry));
  const files = new Set([entry]);
  for (const specifier of specifiers) {
    const extension = extname(specifier);
    const sourceExtension = sourceMode
      ? SOURCE_EXTENSION_BY_RUNTIME_EXTENSION.get(extension)
      : undefined;
    const localSpecifier = sourceExtension
      ? `${specifier.slice(0, -extension.length)}${sourceExtension}`
      : specifier;
    files.add(resolve(dirname(entry), localSpecifier));
  }
  return [...files].sort();
}

/** Discover the local static module graph once. If a new import is added later,
 * the already-tracked importer changes and still forces a restart. */
export function discoverLocalModuleFiles(entryFile: string): string[] {
  const pending = [realpathSync(entryFile)];
  const discovered = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (discovered.has(file)) continue;
    discovered.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g,
    )) {
      const dependency = resolveLocalModuleFile(file, match[1]);
      if (dependency && !discovered.has(dependency)) pending.push(dependency);
    }
  }
  return [...discovered].sort();
}

export function sourceIdentitySnapshot(
  files: readonly string[],
): Map<string, FileIdentity | null> {
  const snapshot = new Map<string, FileIdentity | null>();
  for (const file of files) snapshot.set(file, fileIdentity(file));
  return snapshot;
}

export function changedSourceFiles(
  start: ReadonlyMap<string, FileIdentity | null>,
): string[] {
  const changed: string[] = [];
  for (const [file, identity] of start) {
    if (sourceIdentityChanged(identity, fileIdentity(file))) changed.push(file);
  }
  return changed;
}
