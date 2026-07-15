import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { scheduler } from 'node:timers/promises';
import { isParseable } from './extract-symbols.ts';
import { posix } from './util.ts';

/** Generated/vendored dirs skipped by the walker — and by the JS grep fallback,
 * so both grep backends see roughly the same corpus (ripgrep adds .gitignore). */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.audit',
  '.cache',
]);
/** 64 MiB: enough for very large repositories without unbounded child output. */
const GIT_FILE_LIST_MAX_BYTES = 67_108_864;
const DIRECTORY_SCAN_CONCURRENCY = 32;
const SCAN_YIELD_INTERVAL = 4096;
const GIT_FILE_LIST_ARGS = [
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
  '-z',
];

/** Keep the gitignore-aware corpus identical when Windows serves a native WSL
 * repository. Windows Git cannot reliably use a WSL UNC worktree and falling
 * back to a raw walk would index ignored/generated files, making Linux and
 * Windows rebuild each other's indexes forever. */
export function gitFileListCommand(
  root: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  const unc =
    platform === 'win32'
      ? /^(?:\\\\|\/\/)(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(?:[\\/](.*))?$/iu.exec(
          root,
        )
      : null;
  if (unc) {
    const nativeRoot = `/${(unc[2] ?? '').replace(/\\/g, '/')}`;
    return {
      file: 'wsl.exe',
      args: [
        '-d',
        unc[1],
        '--',
        'git',
        '-C',
        nativeRoot,
        ...GIT_FILE_LIST_ARGS,
      ],
    };
  }
  return { file: 'git', args: ['-C', root, ...GIT_FILE_LIST_ARGS] };
}

/**
 * Enumerate the source files to index, POSIX-relative to root.
 *
 * In a git repo we ask git: tracked + untracked-but-not-ignored files. That
 * respects `.gitignore` for free, so generated/vendored trees (corpora, build
 * output) stay out — the map reflects the actual codebase, not its fixtures.
 * Outside git, we walk and skip the usual generated directories.
 */
export async function listSourceFiles(
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  // A failed `git` process costs tens of milliseconds on Windows. Check the
  // filesystem marker first so ordinary non-git folders go straight to the
  // walker; linked worktrees/submodules are covered because `.git` may be a file.
  const files = hasGitMarker(root)
    ? ((await gitFiles(root, signal)) ?? (await walkFiles(root, signal)))
    : await walkFiles(root, signal);
  signal?.throwIfAborted();
  files.sort();
  return files;
}

function hasGitMarker(root: string): boolean {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true;
  let dir = resolve(root);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

async function gitFiles(
  root: string,
  signal?: AbortSignal,
): Promise<string[] | null> {
  try {
    const command = gitFileListCommand(root);
    const stdout = await new Promise<string>((resolveOutput, reject) => {
      execFile(
        command.file,
        command.args,
        {
          encoding: 'utf8',
          maxBuffer: GIT_FILE_LIST_MAX_BYTES,
          signal,
        },
        (error, output) => {
          if (error) {
            reject(new Error('git ls-files failed.', { cause: error }));
            return;
          }
          resolveOutput(output);
        },
      );
    });
    const out: string[] = [];
    for (const raw of stdout.split('\0')) {
      if (!raw) continue;
      const file = posix(raw);
      if (isParseable(file)) out.push(file);
    }
    return out;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

async function walkFiles(
  root: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const out: string[] = [];
  const dirs = [{ dir: root, rel: '' }];
  let scannedEntries = 0;
  for (let cursor = 0; cursor < dirs.length; ) {
    signal?.throwIfAborted();
    const batch = dirs.slice(cursor, cursor + DIRECTORY_SCAN_CONCURRENCY);
    cursor += batch.length;
    const listings = await Promise.all(
      batch.map(async ({ dir, rel }) => {
        try {
          return {
            dir,
            rel,
            entries: await readdir(dir, { withFileTypes: true }),
          };
        } catch {
          signal?.throwIfAborted();
          return { dir, rel, entries: [] };
        }
      }),
    );
    signal?.throwIfAborted();
    for (const { dir, rel, entries } of listings) {
      for (const entry of entries) {
        if (++scannedEntries % SCAN_YIELD_INTERVAL === 0) {
          await scheduler.yield();
          signal?.throwIfAborted();
        }
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) {
            dirs.push({ dir: join(dir, entry.name), rel: childRel });
          }
        } else if (entry.isFile() && isParseable(childRel)) {
          out.push(childRel);
        }
      }
    }
  }
  return out;
}
