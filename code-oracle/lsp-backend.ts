/**
 * Trusted checker discovery and language/project routing.
 *
 * OS packaging and executable trust policy change independently from the LSP
 * protocol lifecycle, so they live outside the session owner.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Lang } from './project-snapshot.ts';

const NODE_LAUNCHER_PREFIX_BYTES = 64;
const HERE = dirname(fileURLToPath(import.meta.url));

export interface LspBackendSpec {
  cmd: string;
  args: string[];
  languageId: string;
}

const PINNED_TY_REQUIREMENT = 'ty==0.0.50';

export function lspLanguageId(file: string, fallback: string): string {
  if (fallback !== 'typescript') return fallback;
  const lower = file.toLowerCase();
  if (lower.endsWith('.jsx')) return 'javascriptreact';
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  ) {
    return 'javascript';
  }
  if (lower.endsWith('.tsx')) return 'typescriptreact';
  return 'typescript';
}

/** Build the tsgo spawn command for either a native executable or a Node
 * launcher. New native-preview releases use an extensionless `bin/tsgo`
 * Node wrapper; older releases used `bin/tsgo.js`. */
export function tsgoSpawnCommand(bin: string): { cmd: string; args: string[] } {
  let nodeLauncher = /\.[cm]?js$/i.test(bin);
  if (!nodeLauncher) {
    let fd: number | undefined;
    try {
      fd = openSync(bin, 'r');
      const prefix = Buffer.alloc(NODE_LAUNCHER_PREFIX_BYTES);
      const bytes = readSync(fd, prefix, 0, prefix.length, 0);
      nodeLauncher = /^#![^\r\n]*\bnode(?:\s|$)/i.test(
        prefix.subarray(0, bytes).toString('utf8'),
      );
    } catch {
      nodeLauncher = false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const args = ['--lsp', '--stdio'];
  return nodeLauncher
    ? { cmd: process.execPath, args: [bin, ...args] }
    : { cmd: bin, args };
}

/** Resolve package-managed tsgo only from a trusted Node resolution anchor. */
export function resolveTsgoPackageBin(
  anchor: string | URL,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  try {
    const from = createRequire(anchor);
    from.resolve('@typescript/native-preview/package.json');
    const platformRoot = dirname(
      from.resolve(
        `@typescript/native-preview-${platform}-${arch}/package.json`,
      ),
    );
    const executable = join(
      platformRoot,
      'lib',
      platform === 'win32' ? 'tsgo.exe' : 'tsgo',
    );
    return existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

/** Select tsgo for TS/JS and ty for Python without resolving executables from
 * the queried workspace. */
export function backend(lang: Lang): LspBackendSpec | null {
  if (lang === 'ts') {
    if (process.env.TSGO_BIN && existsSync(process.env.TSGO_BIN)) {
      return {
        ...tsgoSpawnCommand(process.env.TSGO_BIN),
        languageId: 'typescript',
      };
    }
    const platform = join(
      HERE,
      'node_modules/@typescript',
      `native-preview-${process.platform}-${process.arch}`,
    );
    const native = join(
      platform,
      'lib',
      process.platform === 'win32' ? 'tsgo.exe' : 'tsgo',
    );
    if (existsSync(native)) {
      return { ...tsgoSpawnCommand(native), languageId: 'typescript' };
    }
    const resolved = resolveTsgoPackageBin(import.meta.url);
    return resolved
      ? { ...tsgoSpawnCommand(resolved), languageId: 'typescript' }
      : null;
  }
  const tyBin = process.env.TY_BIN ?? process.env.TY_CMD;
  return tyBin
    ? { cmd: tyBin, args: ['server'], languageId: 'python' }
    : {
        cmd: 'uvx',
        args: ['--no-config', '--from', PINNED_TY_REQUIREMENT, 'ty', 'server'],
        languageId: 'python',
      };
}

const ROOT_MARKERS: Record<Lang, string[]> = {
  ts: ['tsconfig.json'],
  py: ['pyproject.toml', 'setup.py', 'setup.cfg'],
};

export function projectRoot(file: string, lang: Lang): string {
  const markers = ROOT_MARKERS[lang];
  let dir = dirname(resolve(file));
  for (;;) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return dirname(resolve(file));
    dir = parent;
  }
}
