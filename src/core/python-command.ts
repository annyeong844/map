import { spawnSync } from 'node:child_process';

export interface PythonCommand {
  command: string;
  args: string[];
  display: string;
}

interface ResolvePythonOptions {
  platform?: NodeJS.Platform;
  override?: string;
  probe?: (command: string, args: string[]) => boolean;
}

const defaultProbe = (command: string, args: string[]): boolean => {
  const result = spawnSync(command, [...args, '--version'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return result.status === 0;
};

/** Find Python 3 without assuming Unix's `python3` spelling on Windows. */
export function resolvePythonCommand(
  options: ResolvePythonOptions = {},
): PythonCommand {
  const override = options.override ?? process.env.CODE_MAP_PYTHON;
  if (override) return { command: override, args: [], display: override };

  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? defaultProbe;
  const candidates: PythonCommand[] =
    platform === 'win32'
      ? [
          { command: 'py', args: ['-3'], display: 'py -3' },
          { command: 'python3', args: [], display: 'python3' },
          { command: 'python', args: [], display: 'python' },
        ]
      : [
          { command: 'python3', args: [], display: 'python3' },
          { command: 'python', args: [], display: 'python' },
        ];

  for (const candidate of candidates) {
    if (probe(candidate.command, candidate.args)) return candidate;
  }
  throw new Error(
    `Python 3 was not found (tried ${candidates.map((candidate) => candidate.display).join(', ')}). ` +
      'Install Python 3 or set CODE_MAP_PYTHON to its executable.',
  );
}
