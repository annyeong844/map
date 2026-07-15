import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../core/util.ts';
import { VERSION } from '../version.ts';

export type SetupHost = 'codex' | 'claude' | 'gemini';

export interface SetupStep {
  command: string;
  args: string[];
  reason: string;
}

interface McpLauncher {
  command: string;
  args: string[];
}

const MCP_PROBE_PROTOCOL = '2025-06-18';
const MCP_PROBE_TIMEOUT_MS = 5_000;
const MAX_MCP_PROBE_ERROR_CHARS = 4_096;
const CMD_COMMAND_INDEX = 2;
const CMD_ARGUMENTS_INDEX = CMD_COMMAND_INDEX + 1;

interface SetupPlanBase {
  packageRoot: string;
}

interface CommandSetupPlan extends SetupPlanBase {
  host: 'codex' | 'claude';
  steps: [SetupStep, SetupStep, SetupStep];
  files?: never;
}

interface GeminiSetupPlan extends SetupPlanBase {
  host: 'gemini';
  steps: [];
  files: [configPath: string, rulesPath: string];
}

export type SetupPlan = CommandSetupPlan | GeminiSetupPlan;

export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export function setupPlan(
  host: SetupHost,
  root = packageRoot,
  home = homedir(),
): SetupPlan {
  switch (host) {
    case 'codex':
      return {
        host,
        packageRoot: root,
        steps: [
          {
            command: 'codex',
            args: ['plugin', 'marketplace', 'add', root],
            reason: 'register the bundled marketplace',
          },
          {
            command: 'codex',
            args: ['plugin', 'add', 'code-map@code-map'],
            reason: 'install the routing skill',
          },
          {
            command: 'codex',
            args: ['mcp', 'add', 'code-map', '--', 'map-mcp'],
            reason: 'register the read MCP',
          },
        ],
      };
    case 'claude':
      return {
        host,
        packageRoot: root,
        steps: [
          {
            command: 'claude',
            args: ['plugin', 'marketplace', 'add', root, '--scope', 'user'],
            reason: 'register the bundled marketplace',
          },
          {
            command: 'claude',
            args: ['plugin', 'install', 'code-map@code-map', '--scope', 'user'],
            reason: 'install the routing skill and hook',
          },
          {
            command: 'claude',
            args: [
              'mcp',
              'add',
              '--scope',
              'user',
              'code-map',
              '--',
              'map-mcp',
            ],
            reason: 'register the read MCP',
          },
        ],
      };
    case 'gemini':
      return {
        host,
        packageRoot: root,
        steps: [],
        files: [
          join(home, '.gemini', 'config', 'mcp_config.json'),
          join(home, '.gemini', 'GEMINI.md'),
        ],
      };
  }
  throw new Error(`Unsupported setup host: ${String(host)}`);
}

const quote = (value: string): string => {
  if (!/[\s"']/u.test(value)) return value;
  if (process.platform === 'win32') return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
};

export function formatSetupPlan(plan: SetupPlan): string {
  const lines = [
    `code-map setup for ${plan.host} (dry run)`,
    `package: ${plan.packageRoot}`,
  ];
  for (const step of plan.steps) {
    lines.push(
      `  ${step.command} ${step.args.map(quote).join(' ')}  # ${step.reason}`,
    );
  }
  if (plan.host === 'gemini') {
    for (const file of plan.files) lines.push(`  update ${file}`);
  }
  lines.push('Run again with --apply to make these changes.');
  return lines.join('\n');
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

function run(command: string, args: string[]): RunResult {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function readJson(command: string, args: string[]): unknown {
  const result = run(command, args);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordArrayAt(value: unknown, key: string): Record<string, unknown>[] {
  return isRecord(value) ? recordArray(value[key]) : [];
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : null;
}

function launcherFromStep(step: SetupStep): McpLauncher | null {
  const separator = step.args.indexOf('--');
  if (separator < 0 || separator + 1 >= step.args.length) return null;
  return {
    command: step.args[separator + 1],
    args: step.args.slice(separator + 2),
  };
}

function launcherFromCodexServer(
  server: Record<string, unknown>,
): McpLauncher | null {
  const transport = isRecord(server.transport) ? server.transport : null;
  if (
    !transport ||
    transport.type !== 'stdio' ||
    typeof transport.command !== 'string'
  ) {
    return null;
  }
  const args = transport.args === undefined ? [] : stringArray(transport.args);
  return args ? { command: transport.command, args } : null;
}

function launcherName(command: string): string {
  const normalized = command.replaceAll('\\', '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return basename.toLowerCase().replace(/\.(?:cmd|exe)$/u, '');
}

function sameArgs(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isWindowsInteropPackageLauncher(launcher: McpLauncher): boolean {
  if (
    !launcher.command
      .replaceAll('\\', '/')
      .toLowerCase()
      .endsWith('/node.exe') ||
    launcher.args.length !== 1
  ) {
    return false;
  }
  const entrypoint = launcher.args[0].replaceAll('\\', '/').toLowerCase();
  return (
    /^[a-z]:\//u.test(entrypoint) &&
    entrypoint.endsWith('/@annyeong844/code-map/dist/mcp/server.js')
  );
}

export function codexMcpMatchesStep(
  server: Record<string, unknown>,
  step: SetupStep,
): boolean {
  const actual = launcherFromCodexServer(server);
  const expected = launcherFromStep(step);
  if (!actual || !expected) return false;
  if (
    launcherName(actual.command) === launcherName(expected.command) &&
    sameArgs(actual.args, expected.args)
  ) {
    return true;
  }
  if (isWindowsInteropPackageLauncher(actual)) return true;
  return (
    launcherName(actual.command) === 'cmd' &&
    actual.args.length > CMD_COMMAND_INDEX &&
    actual.args[0].toLowerCase() === '/d' &&
    actual.args[1].toLowerCase() === '/c' &&
    launcherName(actual.args[CMD_COMMAND_INDEX]) ===
      launcherName(expected.command) &&
    sameArgs(actual.args.slice(CMD_ARGUMENTS_INDEX), expected.args)
  );
}

function probeMcpLauncher(launcher: McpLauncher): void {
  const request = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROBE_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'code-map-setup', version: VERSION },
    },
  })}\n`;
  const result = spawnSync(launcher.command, launcher.args, {
    encoding: 'utf8',
    input: request,
    windowsHide: true,
    timeout: MCP_PROBE_TIMEOUT_MS,
  });
  const firstLine = result.stdout
    ?.split(/\r?\n/u)
    .find((line) => line.trim().length > 0);
  let response: unknown;
  try {
    response = firstLine ? (JSON.parse(firstLine) as unknown) : null;
  } catch {
    response = null;
  }
  const payload = isRecord(response) ? response.result : null;
  const serverInfo = isRecord(payload) ? payload.serverInfo : null;
  if (
    result.status === 0 &&
    isRecord(serverInfo) &&
    serverInfo.name === 'code-map'
  ) {
    return;
  }
  const detail = (
    result.error?.message ||
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    `exit ${String(result.status)}`
  ).slice(-MAX_MCP_PROBE_ERROR_CHARS);
  throw new Error(
    `The code-map MCP launcher failed its initialize probe: ${detail}\n` +
      'Install code-map separately inside the current OS. Do not link a WSL launcher to a Windows checkout/node_modules tree (or the reverse).',
  );
}

function runRequired(step: SetupStep): void {
  const result = run(step.command, step.args);
  if (result.status === 0) return;
  const detail =
    result.error?.message ??
    result.stderr.trim() ??
    result.stdout.trim() ??
    `exit ${result.status}`;
  throw new Error(
    `${step.command} failed while trying to ${step.reason}: ${detail}`,
  );
}

function applyCodex(plan: CommandSetupPlan): string[] {
  const done: string[] = [];
  const marketplaces = recordArrayAt(
    readJson('codex', ['plugin', 'marketplace', 'list', '--json']),
    'marketplaces',
  );
  if (!marketplaces.some((item) => item.name === 'code-map')) {
    runRequired(plan.steps[0]);
    done.push(plan.steps[0].reason);
  }
  const plugins = recordArrayAt(
    readJson('codex', ['plugin', 'list', '--json']),
    'installed',
  );
  if (!plugins.some((item) => item.pluginId === 'code-map@code-map')) {
    runRequired(plan.steps[1]);
    done.push(plan.steps[1].reason);
  }
  const servers = recordArray(readJson('codex', ['mcp', 'list', '--json']));
  const existingServer = servers.find((item) => item.name === 'code-map');
  const serverMatches =
    existingServer !== undefined &&
    codexMcpMatchesStep(existingServer, plan.steps[2]);
  const launcher = serverMatches
    ? launcherFromCodexServer(existingServer)
    : launcherFromStep(plan.steps[2]);
  if (!launcher) {
    throw new Error('Could not resolve the planned code-map MCP launcher.');
  }
  probeMcpLauncher(launcher);
  if (!serverMatches) {
    runRequired(plan.steps[2]);
    done.push(
      existingServer ? 'repair the read MCP launcher' : plan.steps[2].reason,
    );
  }
  return done;
}

function applyClaude(plan: CommandSetupPlan): string[] {
  const done: string[] = [];
  const marketplaces = recordArray(
    readJson('claude', ['plugin', 'marketplace', 'list', '--json']),
  );
  if (!marketplaces.some((item) => item.name === 'code-map')) {
    runRequired(plan.steps[0]);
    done.push(plan.steps[0].reason);
  }
  const plugins = recordArray(readJson('claude', ['plugin', 'list', '--json']));
  const installed = plugins.find((item) => item.id === 'code-map@code-map');
  if (!installed) {
    runRequired(plan.steps[1]);
    done.push(plan.steps[1].reason);
  } else if (installed.version !== VERSION) {
    runRequired({
      command: 'claude',
      args: ['plugin', 'update', 'code-map@code-map', '--scope', 'user'],
      reason: `update the routing skill to ${VERSION}`,
    });
    done.push(`updated the routing skill to ${VERSION}`);
  }
  const server = run('claude', ['mcp', 'get', 'code-map']);
  if (server.status !== 0) {
    const detail = `${server.stderr}\n${server.stdout}`;
    if (!/No MCP server named/u.test(detail)) {
      throw new Error(
        `Could not inspect Claude's MCP configuration: ${server.error?.message ?? detail.trim()}`,
      );
    }
    runRequired(plan.steps[2]);
    done.push(plan.steps[2].reason);
  }
  return done;
}

const GEMINI_START = '<!-- code-map setup:start -->';
const GEMINI_END = '<!-- code-map setup:end -->';

function applyGemini(plan: GeminiSetupPlan): string[] {
  const [configPath, rulesPath] = plan.files;
  mkdirSync(dirname(configPath), { recursive: true });
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let source: string;
    try {
      source = readFileSync(configPath, 'utf8');
    } catch (error) {
      throw new Error(`Could not read Gemini MCP config at ${configPath}.`, {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw new Error(
        `Refusing to overwrite invalid JSON at ${configPath}. Fix it, then rerun setup.`,
        { cause: error },
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(
        `Refusing to overwrite Gemini config at ${configPath}: its root must be an object.`,
      );
    }
    config = parsed;
  }
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
  servers['code-map'] =
    process.platform === 'win32'
      ? { command: 'cmd', args: ['/d', '/c', 'map-mcp'] }
      : { command: 'map-mcp' };
  config.mcpServers = servers;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  mkdirSync(dirname(rulesPath), { recursive: true });
  const bundledRules = readFileSync(
    join(plan.packageRoot, 'GEMINI.md'),
    'utf8',
  ).trim();
  const block = `${GEMINI_START}\n${bundledRules}\n${GEMINI_END}`;
  const prior = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : '';
  const pattern = new RegExp(`${GEMINI_START}[\\s\\S]*?${GEMINI_END}`, 'u');
  const next = pattern.test(prior)
    ? prior.replace(pattern, block)
    : `${prior.trimEnd()}${prior.trim() ? '\n\n' : ''}${block}\n`;
  writeFileSync(rulesPath, next);
  return [
    `registered MCP in ${configPath}`,
    `installed routing rules in ${rulesPath}`,
  ];
}

export function applySetup(plan: SetupPlan): string[] {
  if (plan.host === 'gemini') return applyGemini(plan);
  if (plan.host === 'codex') return applyCodex(plan);
  return applyClaude(plan);
}
