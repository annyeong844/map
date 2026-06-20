#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS = resolve(SCRIPT_DIR, '../bench/codex-headless/tasks.example.json');
const USAGE_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'uncached_input_tokens',
  'adjusted_input_tokens',
  'effective_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
];

const STRATEGIES = {
  native: {
    label: 'native grep/read',
    seed: [
      'You are in the native baseline arm of a retrieval benchmark.',
      'Use only shell-based lexical search and direct file reads such as rg, sed, nl, awk, cat, or similar commands.',
      'Do not use code-map or any MCP tool from code-map.',
      'Prefer small, targeted reads. Cite the files or symbols you inspected in the final JSON.',
    ].join('\n'),
  },
  'map-batch': {
    label: 'code-map batched read',
    seed: [
      'You are in the code-map batched arm of a retrieval benchmark.',
      'Search/routing may use rg when needed, but when you know independent symbol refs, call code-map read once with refs: [...] instead of N single reads.',
      'Batch all independent known refs for the task in one MCP call unless a later read depends on an earlier result.',
      'Cite whether you used a batched refs call in the final JSON.',
    ].join('\n'),
  },
};

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'evidence', 'confidence', 'notes'],
  properties: {
    answer: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
};

function usage() {
  return `Usage:
  node scripts/bench-codex-headless.mjs --run --passes 30 --strategies native,map-batch

Options:
  --repo <path>          Target repository. Default: cwd
  --tasks <path>         Task spec JSON. Default: bundled smoke tasks
  --out <path>           Output directory. Default: .bench/codex-headless/<timestamp>
  --passes <n>           Independent passes per strategy. Default: 30
  --strategies <list>    Comma list: native,map-batch. Default: native,map-batch
  --max-tasks <n>        Limit tasks for a smoke run.
  --model <name>         Forwarded to codex exec/resume.
  --codex <bin>          Codex executable. Default: codex
  --map-index <path>     Index path for map-batch. Default: <repo>/.map-index.json
  --auth <mode>          chatgpt or ambient. Default: chatgpt
                         chatgpt checks "codex login status", forces ChatGPT login,
                         and removes API key env vars from child processes.
  --cache-warmup-turns <n>
                         No-op resume turns after seed to warm prompt cache. Default: 1
  --cached-input-weight <n>
                         Weight for cached input in effectiveUsage metrics.
                         effective_input = uncached + cached * weight.
                         Default: 0.1
  --no-overhead-adjustment
                         Do not subtract cached input from adjustedUsage metrics.
  --ignore-user-config   Do not load ~/.codex/config.toml during benchmark runs.
                         Use mainly for native-only debugging; map-batch needs
                         code-map configured as an MCP server.
  --fixed-strategy-order Keep the listed strategy order for every pass.
                         Default alternates order each pass to reduce cache bias.
  --run                  Actually invoke Codex. Without this, print a dry-run plan.
`;
}

function parseArgs(argv) {
  const opts = {
    repo: process.cwd(),
    tasks: '',
    out: '',
    passes: 30,
    strategies: ['native', 'map-batch'],
    maxTasks: 0,
    model: '',
    codex: 'codex',
    mapIndex: '',
    auth: 'chatgpt',
    cacheWarmupTurns: 1,
    cachedInputWeight: 0.1,
    overheadAdjustment: true,
    ignoreUserConfig: false,
    alternateStrategyOrder: true,
    run: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '--repo': opts.repo = next(); break;
      case '--tasks': opts.tasks = next(); break;
      case '--out': opts.out = next(); break;
      case '--passes': opts.passes = Number(next()); break;
      case '--strategies': opts.strategies = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--max-tasks': opts.maxTasks = Number(next()); break;
      case '--model': opts.model = next(); break;
      case '--codex': opts.codex = next(); break;
      case '--map-index': opts.mapIndex = next(); break;
      case '--auth': opts.auth = next(); break;
      case '--cache-warmup-turns': opts.cacheWarmupTurns = Number(next()); break;
      case '--cached-input-weight': opts.cachedInputWeight = Number(next()); break;
      case '--no-overhead-adjustment': opts.overheadAdjustment = false; break;
      case '--ignore-user-config': opts.ignoreUserConfig = true; break;
      case '--fixed-strategy-order': opts.alternateStrategyOrder = false; break;
      case '--run': opts.run = true; break;
      case '-h':
      case '--help':
        console.log(usage());
        process.exit(0);
      default:
        throw new Error(`unknown option: ${a}`);
    }
  }
  if (!Number.isInteger(opts.passes) || opts.passes < 1) throw new Error('--passes must be a positive integer');
  if (opts.maxTasks && (!Number.isInteger(opts.maxTasks) || opts.maxTasks < 1)) throw new Error('--max-tasks must be a positive integer');
  if (!Number.isInteger(opts.cacheWarmupTurns) || opts.cacheWarmupTurns < 0) throw new Error('--cache-warmup-turns must be a non-negative integer');
  if (!Number.isFinite(opts.cachedInputWeight) || opts.cachedInputWeight < 0 || opts.cachedInputWeight > 1) {
    throw new Error('--cached-input-weight must be a number from 0 to 1');
  }
  for (const s of opts.strategies) {
    if (!STRATEGIES[s]) throw new Error(`unknown strategy "${s}"`);
  }
  if (!['chatgpt', 'ambient'].includes(opts.auth)) throw new Error('--auth must be chatgpt or ambient');
  opts.repo = resolve(opts.repo);
  opts.tasks = opts.tasks ? resolve(opts.repo, opts.tasks) : DEFAULT_TASKS;
  opts.out = opts.out ? resolve(opts.out) : resolve(opts.repo, '.bench/codex-headless', timestamp());
  opts.mapIndex = opts.mapIndex ? resolve(opts.mapIndex) : resolve(opts.repo, '.map-index.json');
  return opts;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function loadTasks(path, maxTasks) {
  const spec = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) throw new Error(`task spec has no tasks: ${path}`);
  return { ...spec, tasks: maxTasks ? spec.tasks.slice(0, maxTasks) : spec.tasks };
}

function codexArgs({ opts, strategy, sessionId, schemaPath, finalPath }) {
  const args = sessionId ? ['exec', 'resume'] : ['exec'];
  if (opts.ignoreUserConfig) args.push('--ignore-user-config');
  args.push('--json', '--output-schema', schemaPath, '-o', finalPath);
  if (!sessionId) args.push('-C', opts.repo, '--sandbox', 'read-only');
  if (opts.model) args.push('-m', opts.model);
  args.push('-c', 'approval_policy="never"');
  if (strategy === 'map-batch') {
    args.push('-c', 'mcp_servers."code-map".command="node"');
    args.push('-c', `mcp_servers."code-map".args=["${escapeTomlString(resolve(SCRIPT_DIR, '../src/mcp/server.ts'))}"]`);
    args.push('-c', `mcp_servers."code-map".env.MAP_INDEX="${escapeTomlString(opts.mapIndex)}"`);
  }
  if (opts.auth === 'chatgpt') args.push('-c', 'forced_login_method="chatgpt"');
  if (sessionId) args.push(sessionId);
  args.push('-');
  return args;
}

function escapeTomlString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function seedPrompt(strategy, spec) {
  return [
    `Benchmark: ${spec.name ?? basename(spec.tasksFile ?? 'tasks')}`,
    STRATEGIES[strategy].seed,
    '',
    'You will be resumed for each task in this same headless session.',
    'Keep answers concise and return only JSON matching the provided schema.',
  ].join('\n');
}

function cacheWarmupPrompt(ordinal, total) {
  return [
    `Cache warm-up turn ${ordinal}/${total}.`,
    'Do not inspect files. Do not run commands. Do not call tools.',
    'Return JSON only: {"answer":"cache warmup","evidence":[],"confidence":"high","notes":"no-op cache warmup"}',
  ].join('\n');
}

function taskPrompt(strategy, task, ordinal, total) {
  const chunks = [
    `Task ${ordinal}/${total}: ${task.id}`,
    task.prompt,
    '',
    'Return JSON only. Put the answer in `answer`; list inspected evidence in `evidence`.',
  ];
  if (strategy === 'map-batch' && Array.isArray(task.mapRefs) && task.mapRefs.length) {
    chunks.push('', 'Known independent symbol refs for this task. Use one code-map read call with refs containing all of them before answering:');
    chunks.push(task.mapRefs.map((r) => `- ${r}`).join('\n'));
  }
  if (strategy === 'native' && Array.isArray(task.nativeHints) && task.nativeHints.length) {
    chunks.push('', 'Native baseline hints. Use shell search/read commands to inspect these areas; do not use code-map:');
    chunks.push(task.nativeHints.map((r) => `- ${r}`).join('\n'));
  }
  return chunks.join('\n');
}

function taskCategory(task) {
  return String(task.category ?? task.scenario ?? 'uncategorized');
}

function taskScenario(task) {
  return String(task.scenario ?? task.category ?? 'uncategorized');
}

async function runCodex({ opts, strategy, sessionId, prompt, schemaPath, turnDir, name }) {
  await mkdir(turnDir, { recursive: true });
  const finalPath = join(turnDir, `${name}.final.json`);
  const jsonlPath = join(turnDir, `${name}.events.jsonl`);
  const stderrPath = join(turnDir, `${name}.stderr.txt`);
  const args = codexArgs({ opts, strategy, sessionId, schemaPath, finalPath });
  const startedAt = Date.now();
  const child = spawn(opts.codex, args, { cwd: opts.repo, stdio: ['pipe', 'pipe', 'pipe'], env: codexEnv(opts) });
  child.stdin.end(prompt);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

  const exitCode = await new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', resolveExit);
  });
  const elapsedMs = Date.now() - startedAt;
  await writeFile(jsonlPath, stdout);
  await writeFile(stderrPath, stderr);
  const events = parseJsonl(stdout);
  const summary = summarizeEvents(events, opts);
  summary.elapsedMs = elapsedMs;
  summary.exitCode = exitCode;
  summary.finalPath = finalPath;
  summary.jsonlPath = jsonlPath;
  summary.stderrPath = stderrPath;
  if (existsSync(finalPath)) {
    summary.finalText = await readFile(finalPath, 'utf8');
  } else {
    summary.finalText = summary.finalMessage ?? '';
  }
  if (exitCode !== 0) summary.error = `codex exited with ${exitCode}`;
  return summary;
}

function codexEnv(opts) {
  const env = { ...process.env };
  if (opts.auth === 'chatgpt') {
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
  }
  return env;
}

function checkAuth(opts) {
  if (opts.auth !== 'chatgpt') return { ok: true, mode: 'ambient', status: 'not checked' };
  const res = spawnSync(opts.codex, ['login', 'status'], { cwd: opts.repo, encoding: 'utf8', env: codexEnv(opts) });
  const status = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  if (res.status !== 0) {
    return { ok: false, mode: 'chatgpt', status, reason: `codex login status exited with ${res.status}` };
  }
  if (!/logged in using chatgpt/i.test(status)) {
    return {
      ok: false,
      mode: 'chatgpt',
      status,
      reason: 'expected saved ChatGPT/OAuth credentials, not API-key auth',
    };
  }
  return { ok: true, mode: 'chatgpt', status };
}

function parseJsonl(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { type: 'parse_error', line };
    }
  });
}

function summarizeEvents(events, opts) {
  const out = {
    threadId: '',
    turns: 0,
    usage: emptyUsage(),
    itemCounts: {},
    toolCounts: {},
    commandCount: 0,
    mcpCallCount: 0,
    mcpFailedCallCount: 0,
    mcpReadCallCount: 0,
    mcpBatchReadCallCount: 0,
    finalMessage: '',
    errors: [],
  };
  for (const e of events) {
    if (e.type === 'thread.started' && e.thread_id) out.threadId = e.thread_id;
    if (e.type === 'turn.completed') {
      out.turns++;
      addUsage(out.usage, normalizeUsage(e.usage, opts));
    }
    if (e.type === 'turn.failed') out.errors.push(e.error ?? e);
    if (e.type === 'error') out.errors.push(e.error ?? e.message ?? e);
    const item = e.item;
    if (item && e.type === 'item.completed') {
      const itemType = item.type ?? 'unknown';
      out.itemCounts[itemType] = (out.itemCounts[itemType] ?? 0) + 1;
      if (itemType === 'agent_message' && typeof item.text === 'string') out.finalMessage = item.text;
      if (itemType === 'command_execution') {
        out.commandCount++;
        const key = item.command ? `command:${String(item.command).split(/\s+/)[0]}` : 'command';
        out.toolCounts[key] = (out.toolCounts[key] ?? 0) + 1;
      }
      if (itemType.includes('mcp') || item.server || item.tool || item.name === 'read') {
        out.mcpCallCount++;
        const failed = item.status === 'failed' || item.error;
        if (failed) out.mcpFailedCallCount++;
        const toolName = item.tool ?? item.name;
        if (!failed && item.server === 'code-map' && toolName === 'read') {
          out.mcpReadCallCount++;
          if (Array.isArray(item.arguments?.refs)) out.mcpBatchReadCallCount++;
        }
        const key = `mcp:${item.server ?? toolName ?? itemType}`;
        out.toolCounts[key] = (out.toolCounts[key] ?? 0) + 1;
      }
      if (itemType === 'web_search') out.toolCounts.web_search = (out.toolCounts.web_search ?? 0) + 1;
    }
  }
  return out;
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    uncached_input_tokens: 0,
    adjusted_input_tokens: 0,
    effective_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    adjusted_total_tokens: 0,
    effective_total_tokens: 0,
  };
}

function normalizeUsage(usage = {}, opts = {}) {
  const out = emptyUsage();
  const cachedWeight = Number.isFinite(opts.cachedInputWeight) ? opts.cachedInputWeight : 0.1;
  out.input_tokens = Number(usage.input_tokens ?? 0);
  out.cached_input_tokens = Number(usage.cached_input_tokens ?? 0);
  out.uncached_input_tokens = Math.max(0, out.input_tokens - out.cached_input_tokens);
  out.adjusted_input_tokens = opts.overheadAdjustment === false ? out.input_tokens : out.uncached_input_tokens;
  out.effective_input_tokens = Math.round(out.uncached_input_tokens + out.cached_input_tokens * cachedWeight);
  out.output_tokens = Number(usage.output_tokens ?? 0);
  out.reasoning_output_tokens = Number(usage.reasoning_output_tokens ?? 0);
  out.total_tokens = out.input_tokens + out.output_tokens;
  out.adjusted_total_tokens = out.adjusted_input_tokens + out.output_tokens;
  out.effective_total_tokens = out.effective_input_tokens + out.output_tokens;
  return out;
}

function addUsage(total, usage = {}) {
  for (const key of USAGE_KEYS) total[key] += Number(usage[key] ?? 0);
  total.total_tokens = total.input_tokens + total.output_tokens;
  total.adjusted_total_tokens = total.adjusted_input_tokens + total.output_tokens;
  total.effective_total_tokens = total.effective_input_tokens + total.output_tokens;
}

function evaluate(finalText, expected = {}) {
  let parsed = null;
  try {
    parsed = JSON.parse(finalText);
  } catch {
    // Keep parsed null; substring checks still run against raw text.
  }
  const haystack = `${finalText}\n${parsed ? JSON.stringify(parsed) : ''}`;
  const misses = [];
  for (const s of expected.requiredSubstrings ?? []) {
    if (!haystack.toLowerCase().includes(String(s).toLowerCase())) misses.push(`missing substring: ${s}`);
  }
  for (const r of expected.requiredRegex ?? []) {
    if (!new RegExp(r, 'is').test(haystack)) misses.push(`missing regex: ${r}`);
  }
  for (const r of expected.forbiddenRegex ?? []) {
    if (new RegExp(r, 'is').test(haystack)) misses.push(`forbidden regex matched: ${r}`);
  }
  return { passed: misses.length === 0, misses, parsed };
}

function applyStrategyChecks(strategy, task, check, turn) {
  const misses = [...check.misses];
  if (strategy === 'native' && turn.mcpCallCount > 0) {
    misses.push(`native strategy used MCP ${turn.mcpCallCount} time(s)`);
  }
  if (strategy === 'map-batch' && Array.isArray(task.mapRefs) && task.mapRefs.length) {
    if (turn.mcpBatchReadCallCount < 1) misses.push('map-batch strategy did not complete a batched code-map read call');
    if (turn.mcpFailedCallCount > 0) misses.push(`map-batch strategy had ${turn.mcpFailedCallCount} failed MCP call(s)`);
  }
  return { ...check, misses, passed: misses.length === 0 };
}

function sumUsage(rows) {
  const usage = emptyUsage();
  for (const row of rows) addUsage(usage, row.usage);
  return usage;
}

function aggregate(results) {
  const byStrategy = {};
  for (const row of results) {
    const s = row.strategy;
    byStrategy[s] ??= {
      strategy: s,
      passes: new Set(),
      scoredTasks: 0,
      passed: 0,
      turns: 0,
      comparisonTurns: 0,
      commandCount: 0,
      comparisonCommandCount: 0,
      mcpCallCount: 0,
      comparisonMcpCallCount: 0,
      mcpFailedCallCount: 0,
      comparisonMcpFailedCallCount: 0,
      mcpReadCallCount: 0,
      comparisonMcpReadCallCount: 0,
      mcpBatchReadCallCount: 0,
      comparisonMcpBatchReadCallCount: 0,
      elapsedMs: 0,
      comparisonElapsedMs: 0,
      usageRows: [],
      comparisonRows: [],
      setupRows: [],
      taskPasses: new Map(),
    };
    byStrategy[s].passes.add(row.pass);
    if (row.scored) {
      byStrategy[s].scoredTasks++;
      if (row.passed) byStrategy[s].passed++;
      const task = byStrategy[s].taskPasses.get(row.task) ?? false;
      byStrategy[s].taskPasses.set(row.task, task || row.passed);
    }
    byStrategy[s].turns += row.turns;
    byStrategy[s].commandCount += row.commandCount;
    byStrategy[s].mcpCallCount += row.mcpCallCount;
    byStrategy[s].mcpFailedCallCount += row.mcpFailedCallCount;
    byStrategy[s].mcpReadCallCount += row.mcpReadCallCount;
    byStrategy[s].mcpBatchReadCallCount += row.mcpBatchReadCallCount;
    byStrategy[s].elapsedMs += row.elapsedMs;
    byStrategy[s].usageRows.push(row);
    if (row.includeInComparison) {
      byStrategy[s].comparisonTurns += row.turns;
      byStrategy[s].comparisonCommandCount += row.commandCount;
      byStrategy[s].comparisonMcpCallCount += row.mcpCallCount;
      byStrategy[s].comparisonMcpFailedCallCount += row.mcpFailedCallCount;
      byStrategy[s].comparisonMcpReadCallCount += row.mcpReadCallCount;
      byStrategy[s].comparisonMcpBatchReadCallCount += row.mcpBatchReadCallCount;
      byStrategy[s].comparisonElapsedMs += row.elapsedMs;
      byStrategy[s].comparisonRows.push(row);
    } else {
      byStrategy[s].setupRows.push(row);
    }
  }
  return Object.values(byStrategy).map((x) => ({
    strategy: x.strategy,
    passes: x.passes.size,
    tasks: x.scoredTasks,
    passed: x.passed,
    attemptPassRate: x.scoredTasks ? x.passed / x.scoredTasks : 0,
    passAtK: x.taskPasses.size ? Array.from(x.taskPasses.values()).filter(Boolean).length / x.taskPasses.size : 0,
    turns: x.turns,
    comparisonTurns: x.comparisonTurns,
    commandCount: x.commandCount,
    comparisonCommandCount: x.comparisonCommandCount,
    mcpCallCount: x.mcpCallCount,
    comparisonMcpCallCount: x.comparisonMcpCallCount,
    mcpFailedCallCount: x.mcpFailedCallCount,
    comparisonMcpFailedCallCount: x.comparisonMcpFailedCallCount,
    mcpReadCallCount: x.mcpReadCallCount,
    comparisonMcpReadCallCount: x.comparisonMcpReadCallCount,
    mcpBatchReadCallCount: x.mcpBatchReadCallCount,
    comparisonMcpBatchReadCallCount: x.comparisonMcpBatchReadCallCount,
    elapsedMs: x.elapsedMs,
    comparisonElapsedMs: x.comparisonElapsedMs,
    comparisonAvgElapsedMs: x.comparisonRows.length ? x.comparisonElapsedMs / x.comparisonRows.length : 0,
    usage: sumUsage(x.usageRows),
    comparisonUsage: sumUsage(x.comparisonRows),
    setupUsage: sumUsage(x.setupRows),
    cacheHitRate: rate(sumUsage(x.usageRows).cached_input_tokens, sumUsage(x.usageRows).input_tokens),
    comparisonCacheHitRate: rate(sumUsage(x.comparisonRows).cached_input_tokens, sumUsage(x.comparisonRows).input_tokens),
  }));
}

function aggregateByScenario(results) {
  const buckets = {};
  for (const row of results) {
    if (!row.includeInComparison) continue;
    const scenario = row.scenario || row.category || 'uncategorized';
    const key = `${scenario}\0${row.strategy}`;
    buckets[key] ??= {
      scenario,
      category: row.category || scenario,
      strategy: row.strategy,
      attempts: 0,
      passed: 0,
      turns: 0,
      elapsedMs: 0,
      commandCount: 0,
      mcpCallCount: 0,
      mcpFailedCallCount: 0,
      mcpReadCallCount: 0,
      mcpBatchReadCallCount: 0,
      rows: [],
    };
    buckets[key].attempts++;
    if (row.passed) buckets[key].passed++;
    buckets[key].turns += row.turns;
    buckets[key].elapsedMs += row.elapsedMs;
    buckets[key].commandCount += row.commandCount;
    buckets[key].mcpCallCount += row.mcpCallCount;
    buckets[key].mcpFailedCallCount += row.mcpFailedCallCount;
    buckets[key].mcpReadCallCount += row.mcpReadCallCount;
    buckets[key].mcpBatchReadCallCount += row.mcpBatchReadCallCount;
    buckets[key].rows.push(row);
  }
  return Object.values(buckets)
    .map((x) => {
      const usage = sumUsage(x.rows);
      return {
        scenario: x.scenario,
        category: x.category,
        strategy: x.strategy,
        attempts: x.attempts,
        passed: x.passed,
        passRate: x.attempts ? x.passed / x.attempts : 0,
        turns: x.turns,
        elapsedMs: x.elapsedMs,
        avgElapsedMs: x.attempts ? x.elapsedMs / x.attempts : 0,
        commandCount: x.commandCount,
        mcpCallCount: x.mcpCallCount,
        mcpFailedCallCount: x.mcpFailedCallCount,
        mcpReadCallCount: x.mcpReadCallCount,
        mcpBatchReadCallCount: x.mcpBatchReadCallCount,
        usage,
        cacheHitRate: rate(usage.cached_input_tokens, usage.input_tokens),
      };
    })
    .sort((a, b) => a.scenario.localeCompare(b.scenario) || a.strategy.localeCompare(b.strategy));
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function csv(results) {
  const header = [
    'strategy',
    'pass',
    'phase',
    'task',
    'category',
    'scenario',
    'scored',
    'includeInComparison',
    'passed',
    'turns',
    'input_tokens',
    'cached_input_tokens',
    'uncached_input_tokens',
    'adjusted_input_tokens',
    'effective_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
    'total_tokens',
    'adjusted_total_tokens',
    'effective_total_tokens',
    'commandCount',
    'mcpCallCount',
    'mcpFailedCallCount',
    'mcpReadCallCount',
    'mcpBatchReadCallCount',
    'elapsedMs',
  ];
  const lines = [header.join(',')];
  for (const r of results) {
    lines.push(header.map((h) => JSON.stringify(valueForCsv(r, h) ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function valueForCsv(row, key) {
  if (key in row) return row[key];
  if (row.usage && key in row.usage) return row.usage[key];
  return '';
}

async function writeSummary(outDir, opts, spec, rows) {
  const summary = {
    generatedAt: new Date().toISOString(),
    repo: opts.repo,
    taskSpec: opts.tasks,
    passesRequested: opts.passes,
    strategies: opts.strategies,
    alternateStrategyOrder: opts.alternateStrategyOrder,
    cachedInputWeight: opts.cachedInputWeight,
    tasks: spec.tasks.map((t) => t.id),
    aggregate: aggregate(rows),
    scenarioAggregate: aggregateByScenario(rows),
    results: rows,
  };
  await writeFile(join(outDir, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(outDir, 'results.csv'), csv(rows));
  await writeFile(join(outDir, 'summary.md'), markdownSummary(summary));
}

function markdownSummary(summary) {
  const lines = [
    '# Codex Headless Retrieval Benchmark',
    '',
    `- generatedAt: ${summary.generatedAt}`,
    `- repo: ${summary.repo}`,
    `- taskSpec: ${summary.taskSpec}`,
    `- passesRequested: ${summary.passesRequested}`,
    `- cachedInputWeight: ${summary.cachedInputWeight}`,
    '- comparisonUsage uses scored task turns only; seed/cache-warmup setup turns stay in results.json.',
    '- adjusted input = input_tokens - cached_input_tokens, so repeated cached prompt prefix is excluded from comparison.',
    '- effective input = uncached_input_tokens + cached_input_tokens * cachedInputWeight.',
    '',
    '| strategy | passes | tasks | passed | passRate | cmp turns | effective input | adjusted input | raw input | output | elapsed ms | avg ms | commands | mcp calls | batch reads | mcp failed | cache hit |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const a of summary.aggregate) {
    lines.push(`| ${a.strategy} | ${a.passes} | ${a.tasks} | ${a.passed} | attempt ${a.attemptPassRate.toFixed(3)} / pass@${a.passes} ${a.passAtK.toFixed(3)} | ${a.comparisonTurns} | ${a.comparisonUsage.effective_input_tokens} | ${a.comparisonUsage.adjusted_input_tokens} | ${a.comparisonUsage.input_tokens} | ${a.comparisonUsage.output_tokens} | ${a.comparisonElapsedMs} | ${a.comparisonAvgElapsedMs.toFixed(0)} | ${a.comparisonCommandCount} | ${a.comparisonMcpCallCount} | ${a.comparisonMcpBatchReadCallCount} | ${a.comparisonMcpFailedCallCount} | ${a.comparisonCacheHitRate.toFixed(3)} |`);
  }
  if (summary.scenarioAggregate.length) {
    lines.push('');
    lines.push('## By Scenario');
    lines.push('');
    lines.push('| scenario | strategy | attempts | passed | passRate | effective input | adjusted input | raw input | output | elapsed ms | avg ms | commands | batch reads | mcp failed |');
    lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const a of summary.scenarioAggregate) {
      lines.push(`| ${a.scenario} | ${a.strategy} | ${a.attempts} | ${a.passed} | ${a.passRate.toFixed(3)} | ${a.usage.effective_input_tokens} | ${a.usage.adjusted_input_tokens} | ${a.usage.input_tokens} | ${a.usage.output_tokens} | ${a.elapsedMs} | ${a.avgElapsedMs.toFixed(0)} | ${a.commandCount} | ${a.mcpBatchReadCallCount} | ${a.mcpFailedCallCount} |`);
    }
  }
  lines.push('');
  lines.push('Raw all-row usage, setup usage, and Codex JSONL event streams are preserved under `results.json` and `runs/`.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const spec = await loadTasks(opts.tasks, opts.maxTasks);
  spec.tasksFile = opts.tasks;
  await mkdir(opts.out, { recursive: true });
  const schemaPath = join(opts.out, 'response.schema.json');
  const auth = checkAuth(opts);
  if (!auth.ok) {
    await writeFile(join(opts.out, 'auth-error.json'), `${JSON.stringify(auth, null, 2)}\n`);
    throw new Error(`${auth.reason}. Run \`codex login --device-auth\` (headless) or \`codex login\` (browser), then retry. Status: ${auth.status || '(empty)'}`);
  }
  await writeFile(schemaPath, `${JSON.stringify(RESPONSE_SCHEMA, null, 2)}\n`);
  await writeFile(join(opts.out, 'plan.json'), `${JSON.stringify({ ...opts, auth, taskIds: spec.tasks.map((t) => t.id) }, null, 2)}\n`);

  if (!opts.run) {
    console.log(`Dry run. Would write results to ${opts.out}`);
    console.log(`Passes: ${opts.passes}`);
    console.log(`Strategies: ${opts.strategies.join(', ')}`);
    console.log(`Tasks: ${spec.tasks.map((t) => t.id).join(', ')}`);
    console.log(`Auth: ${auth.status}`);
    console.log(`Cache warm-up turns per pass: ${opts.cacheWarmupTurns}`);
    console.log(`Cached input weight for effective metrics: ${opts.cachedInputWeight}`);
    console.log(`Adjusted input subtracts cached input: ${opts.overheadAdjustment ? 'yes' : 'no'}`);
    console.log(`Ignore user config during runs: ${opts.ignoreUserConfig ? 'yes' : 'no'}`);
    console.log(`Alternate strategy order by pass: ${opts.alternateStrategyOrder ? 'yes' : 'no'}`);
    console.log('Add --run to invoke Codex.');
    return;
  }

  const rows = [];
  for (let pass = 1; pass <= opts.passes; pass++) {
    const passStrategies = opts.alternateStrategyOrder && pass % 2 === 0 ? [...opts.strategies].reverse() : opts.strategies;
    for (const strategy of passStrategies) {
      const passId = String(pass).padStart(3, '0');
      const passDir = join(opts.out, 'runs', strategy, `pass-${passId}-${randomUUID().slice(0, 8)}`);
      const seed = await runCodex({
        opts,
        strategy,
        sessionId: '',
        prompt: seedPrompt(strategy, spec),
        schemaPath,
        turnDir: passDir,
        name: 'seed',
      });
      if (!seed.threadId) throw new Error(`seed run did not emit thread.started for ${strategy} pass ${pass}`);
      rows.push({
        strategy,
        pass,
        phase: 'seed',
        task: '__seed__',
        category: '',
        scenario: '',
        scored: false,
        includeInComparison: false,
        passed: true,
        misses: [],
        turns: seed.turns,
        usage: seed.usage,
        itemCounts: seed.itemCounts,
        toolCounts: seed.toolCounts,
        commandCount: seed.commandCount,
        mcpCallCount: seed.mcpCallCount,
        mcpFailedCallCount: seed.mcpFailedCallCount,
        mcpReadCallCount: seed.mcpReadCallCount,
        mcpBatchReadCallCount: seed.mcpBatchReadCallCount,
        elapsedMs: seed.elapsedMs,
        threadId: seed.threadId,
        finalPath: seed.finalPath,
        jsonlPath: seed.jsonlPath,
        stderrPath: seed.stderrPath,
      });
      for (let warmupIndex = 1; warmupIndex <= opts.cacheWarmupTurns; warmupIndex++) {
        const warmup = await runCodex({
          opts,
          strategy,
          sessionId: seed.threadId,
          prompt: cacheWarmupPrompt(warmupIndex, opts.cacheWarmupTurns),
          schemaPath,
          turnDir: passDir,
          name: `cache-warmup-${warmupIndex}`,
        });
        rows.push({
          strategy,
          pass,
          phase: 'cache_warmup',
          task: `__cache_warmup_${warmupIndex}__`,
          category: '',
          scenario: '',
          scored: false,
          includeInComparison: false,
          passed: warmup.exitCode === 0,
          misses: [],
          turns: warmup.turns,
          usage: warmup.usage,
          itemCounts: warmup.itemCounts,
          toolCounts: warmup.toolCounts,
          commandCount: warmup.commandCount,
          mcpCallCount: warmup.mcpCallCount,
          mcpFailedCallCount: warmup.mcpFailedCallCount,
          mcpReadCallCount: warmup.mcpReadCallCount,
          mcpBatchReadCallCount: warmup.mcpBatchReadCallCount,
          elapsedMs: warmup.elapsedMs,
          threadId: seed.threadId,
          finalPath: warmup.finalPath,
          jsonlPath: warmup.jsonlPath,
          stderrPath: warmup.stderrPath,
        });
        await writeSummary(opts.out, opts, spec, rows);
      }
      for (let i = 0; i < spec.tasks.length; i++) {
        const task = spec.tasks[i];
        const turn = await runCodex({
          opts,
          strategy,
          sessionId: seed.threadId,
          prompt: taskPrompt(strategy, task, i + 1, spec.tasks.length),
          schemaPath,
          turnDir: passDir,
          name: `task-${task.id}`,
        });
        const check = applyStrategyChecks(strategy, task, evaluate(turn.finalText, task.expected), turn);
        rows.push({
          strategy,
          pass,
          phase: 'task',
          task: task.id,
          category: taskCategory(task),
          scenario: taskScenario(task),
          scored: true,
          includeInComparison: true,
          passed: check.passed,
          misses: check.misses,
          turns: turn.turns,
          usage: turn.usage,
          itemCounts: turn.itemCounts,
          toolCounts: turn.toolCounts,
          commandCount: turn.commandCount,
          mcpCallCount: turn.mcpCallCount,
          mcpFailedCallCount: turn.mcpFailedCallCount,
          mcpReadCallCount: turn.mcpReadCallCount,
          mcpBatchReadCallCount: turn.mcpBatchReadCallCount,
          elapsedMs: turn.elapsedMs,
          threadId: seed.threadId,
          finalPath: turn.finalPath,
          jsonlPath: turn.jsonlPath,
          stderrPath: turn.stderrPath,
        });
        await writeSummary(opts.out, opts, spec, rows);
      }
    }
  }
  await writeSummary(opts.out, opts, spec, rows);
  console.log(`Wrote ${join(opts.out, 'summary.md')}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
