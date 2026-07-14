import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.ts';

export type SetupHost = 'codex' | 'claude' | 'gemini';

export interface SetupStep {
  command: string;
  args: string[];
  reason: string;
}

export interface SetupPlan {
  host: SetupHost;
  packageRoot: string;
  steps: SetupStep[];
  files?: string[];
}

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function setupPlan(host: SetupHost, root = packageRoot, home = homedir()): SetupPlan {
  switch (host) {
    case 'codex':
      return {
        host,
        packageRoot: root,
        steps: [
          { command: 'codex', args: ['plugin', 'marketplace', 'add', root], reason: 'register the bundled marketplace' },
          { command: 'codex', args: ['plugin', 'add', 'code-map@code-map'], reason: 'install the routing skill' },
          { command: 'codex', args: ['mcp', 'add', 'code-map', '--', 'map-mcp'], reason: 'register the read MCP' },
        ],
      };
    case 'claude':
      return {
        host,
        packageRoot: root,
        steps: [
          { command: 'claude', args: ['plugin', 'marketplace', 'add', root, '--scope', 'user'], reason: 'register the bundled marketplace' },
          { command: 'claude', args: ['plugin', 'install', 'code-map@code-map', '--scope', 'user'], reason: 'install the routing skill and hook' },
          { command: 'claude', args: ['mcp', 'add', '--scope', 'user', 'code-map', '--', 'map-mcp'], reason: 'register the read MCP' },
        ],
      };
    case 'gemini':
      return {
        host,
        packageRoot: root,
        steps: [],
        files: [join(home, '.gemini', 'config', 'mcp_config.json'), join(home, '.gemini', 'GEMINI.md')],
      };
  }
}

const quote = (value: string): string => {
  if (!/[\s"']/u.test(value)) return value;
  if (process.platform === 'win32') return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
};

export function formatSetupPlan(plan: SetupPlan): string {
  const lines = [`code-map setup for ${plan.host} (dry run)`, `package: ${plan.packageRoot}`];
  for (const step of plan.steps) lines.push(`  ${step.command} ${step.args.map(quote).join(' ')}  # ${step.reason}`);
  for (const file of plan.files ?? []) lines.push(`  update ${file}`);
  lines.push('Run again with --apply to make these changes.');
  return lines.join('\n');
}

interface RunResult { status: number | null; stdout: string; stderr: string; error?: Error }

function run(command: string, args: string[]): RunResult {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function readJson(command: string, args: string[]): unknown | null {
  const result = run(command, args);
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout) as unknown; } catch { return null; }
}

function runRequired(step: SetupStep): void {
  const result = run(step.command, step.args);
  if (result.status === 0) return;
  const detail = result.error?.message ?? result.stderr.trim() ?? result.stdout.trim() ?? `exit ${result.status}`;
  throw new Error(`${step.command} failed while trying to ${step.reason}: ${detail}`);
}

function applyCodex(plan: SetupPlan): string[] {
  const done: string[] = [];
  const marketplaces = readJson('codex', ['plugin', 'marketplace', 'list', '--json']) as
    | { marketplaces?: { name?: string }[] } | null;
  if (!marketplaces?.marketplaces?.some((item) => item.name === 'code-map')) {
    runRequired(plan.steps[0]);
    done.push(plan.steps[0].reason);
  }
  const plugins = readJson('codex', ['plugin', 'list', '--json']) as
    | { installed?: { pluginId?: string }[] } | null;
  if (!plugins?.installed?.some((item) => item.pluginId === 'code-map@code-map')) {
    runRequired(plan.steps[1]);
    done.push(plan.steps[1].reason);
  }
  const servers = readJson('codex', ['mcp', 'list', '--json']) as { name?: string }[] | null;
  if (!servers?.some((item) => item.name === 'code-map')) {
    runRequired(plan.steps[2]);
    done.push(plan.steps[2].reason);
  }
  return done;
}

function applyClaude(plan: SetupPlan): string[] {
  const done: string[] = [];
  const marketplaces = readJson('claude', ['plugin', 'marketplace', 'list', '--json']) as { name?: string }[] | null;
  if (!marketplaces?.some((item) => item.name === 'code-map')) {
    runRequired(plan.steps[0]);
    done.push(plan.steps[0].reason);
  }
  const plugins = readJson('claude', ['plugin', 'list', '--json']) as { id?: string; version?: string }[] | null;
  const installed = plugins?.find((item) => item.id === 'code-map@code-map');
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
      throw new Error(`Could not inspect Claude's MCP configuration: ${server.error?.message ?? detail.trim()}`);
    }
    runRequired(plan.steps[2]);
    done.push(plan.steps[2].reason);
  }
  return done;
}

const GEMINI_START = '<!-- code-map setup:start -->';
const GEMINI_END = '<!-- code-map setup:end -->';

function applyGemini(plan: SetupPlan): string[] {
  const [configPath, rulesPath] = plan.files!;
  mkdirSync(dirname(configPath), { recursive: true });
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object');
      config = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`Refusing to overwrite invalid JSON object at ${configPath}. Fix it, then rerun setup.`);
    }
  }
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers))
    ? config.mcpServers as Record<string, unknown>
    : {};
  servers['code-map'] = process.platform === 'win32'
    ? { command: 'cmd', args: ['/d', '/c', 'map-mcp'] }
    : { command: 'map-mcp' };
  config.mcpServers = servers;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  mkdirSync(dirname(rulesPath), { recursive: true });
  const bundledRules = readFileSync(join(plan.packageRoot, 'GEMINI.md'), 'utf8').trim();
  const block = `${GEMINI_START}\n${bundledRules}\n${GEMINI_END}`;
  const prior = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : '';
  const pattern = new RegExp(`${GEMINI_START}[\\s\\S]*?${GEMINI_END}`, 'u');
  const next = pattern.test(prior) ? prior.replace(pattern, block) : `${prior.trimEnd()}${prior.trim() ? '\n\n' : ''}${block}\n`;
  writeFileSync(rulesPath, next);
  return [`registered MCP in ${configPath}`, `installed routing rules in ${rulesPath}`];
}

export function applySetup(plan: SetupPlan): string[] {
  if (plan.host === 'codex') return applyCodex(plan);
  if (plan.host === 'claude') return applyClaude(plan);
  return applyGemini(plan);
}
