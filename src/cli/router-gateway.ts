/** `phm router serve|models|pick|config` and `phm run --model auto|<lane:model>`:
 * thin argv handlers over src/core/router-gateway. */
import type { RoutingDifficulty, RoutingTask } from '../core/routing/types.js';

export const ROUTER_GATEWAY_VERBS = ['serve', 'models', 'pick', 'config'] as const;

export const ROUTER_GATEWAY_USAGE = [
  'Usage:',
  '  phm router serve [--port N] [--config FILE] [--json]   Start the loopback OpenAI-compatible endpoint (127.0.0.1 only)',
  '  phm router models [--config FILE] [--json]             List "auto", aliases and <lane>:<model> ids',
  '  phm router pick --model M [--task T] [--difficulty D] [--config FILE] [--json]',
  '                                                          Show which seats a call would try, without calling a model',
  '  phm router config [--init] [--config FILE] [--json]    Show (or create) the versioned routing config',
  '  phm run --model auto|<lane:model> "<prompt>" [--system TEXT] [--task T] [--difficulty D] [--json]',
  '                                                          One routed completion',
  'M is "auto", "<lane>:<model>" (e.g. codex-personal:gpt-5.5, local:qwen3:8b) or an alias from the config.',
  'Config: ~/.ashlr/router/gateway.json. Token: ~/.ashlr/router/token (bearer; never printed). Docs: docs/ROUTER-GATEWAY.md',
].join('\n');

const TASKS = ['code', 'review', 'plan', 'bulk', 'leader'];
const DIFFICULTIES = ['low', 'medium', 'high'];

interface Flags {
  json: boolean;
  init: boolean;
  port?: number;
  config?: string;
  model?: string;
  task?: RoutingTask;
  difficulty?: RoutingDifficulty;
  system?: string;
  positional: string[];
}

function parseFlags(args: readonly string[], allowed: readonly string[]): Flags | string {
  const flags: Flags = { json: false, init: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = (): string | null => {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i++;
      return next;
    };
    if (!arg.startsWith('--')) { flags.positional.push(arg); continue; }
    if (!allowed.includes(arg)) return `Unknown flag ${arg}.`;
    if (arg === '--json') flags.json = true;
    else if (arg === '--init') flags.init = true;
    else if (arg === '--port') {
      const v = value();
      const n = Number(v);
      if (!v || !Number.isSafeInteger(n) || n < 1024 || n > 65535) return '--port needs a number from 1024 to 65535.';
      flags.port = n;
    } else if (arg === '--config') {
      const v = value();
      if (!v) return '--config needs a file path.';
      flags.config = v;
    } else if (arg === '--model') {
      const v = value();
      if (!v) return '--model needs "auto", "<lane>:<model>" or an alias.';
      flags.model = v;
    } else if (arg === '--task') {
      const v = value();
      if (!v || !TASKS.includes(v)) return `--task must be one of ${TASKS.join(', ')}.`;
      flags.task = v as RoutingTask;
    } else if (arg === '--difficulty') {
      const v = value();
      if (!v || !DIFFICULTIES.includes(v)) return `--difficulty must be one of ${DIFFICULTIES.join(', ')}.`;
      flags.difficulty = v as RoutingDifficulty;
    } else if (arg === '--system') {
      const v = value();
      if (v === null) return '--system needs text.';
      flags.system = v;
    }
  }
  return flags;
}

function usageError(message: string): number {
  process.stderr.write(`${message}\n${ROUTER_GATEWAY_USAGE}\n`);
  return 2;
}

function configError(error: unknown): number {
  process.stderr.write(`Router config: ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
}

export async function cmdRouterGateway(args: readonly string[]): Promise<number> {
  const [verb, ...rest] = args;
  if (rest.includes('--help') || rest.includes('-h')) { console.log(ROUTER_GATEWAY_USAGE); return 0; }
  const core = await import('../core/router-gateway/index.js');
  if (verb === 'config') {
    const flags = parseFlags(rest, ['--json', '--init', '--config']);
    if (typeof flags === 'string' || flags.positional.length) return usageError(typeof flags === 'string' ? flags : 'Unexpected argument.');
    const path = flags.config ?? core.routerGatewayConfigPath();
    let created = false;
    try {
      if (flags.init) created = core.initRouterGatewayConfig(path);
      const loaded = core.loadRouterGatewayConfig(path);
      if (flags.json) console.log(JSON.stringify({ schema: 'router.config.v1', path, exists: loaded.exists, created, config: loaded.config }));
      else {
        console.log(`${loaded.exists ? (created ? 'Created' : 'Using') : 'No file yet; defaults apply'}: ${path}`);
        console.log(JSON.stringify(loaded.config, null, 2));
        if (!loaded.exists) console.log('Run `phm router config --init` to write this as a file you can edit and commit.');
      }
      return 0;
    } catch (error) { return configError(error); }
  }
  if (verb === 'models') {
    const flags = parseFlags(rest, ['--json', '--config']);
    if (typeof flags === 'string' || flags.positional.length) return usageError(typeof flags === 'string' ? flags : 'Unexpected argument.');
    let rows;
    try { rows = await core.listModelsViaRouter({ configPath: flags.config }); } catch (error) { return configError(error); }
    if (flags.json) console.log(JSON.stringify({ schema: 'router.models.v1', models: rows }));
    else for (const row of rows) console.log(`${row.id}\t${row.kind}${row.kind === 'alias' ? `\t→ ${row.target}` : ''}`);
    return 0;
  }
  if (verb === 'pick') {
    const flags = parseFlags(rest, ['--json', '--config', '--model', '--task', '--difficulty']);
    if (typeof flags === 'string' || flags.positional.length) return usageError(typeof flags === 'string' ? flags : 'Unexpected argument.');
    if (!flags.model) return usageError('pick needs --model.');
    let plan;
    try {
      plan = await core.planViaRouter({ model: flags.model, system: '', prompt: 'routing preview',
        ...(flags.task ? { task: flags.task } : {}), ...(flags.difficulty ? { difficulty: flags.difficulty } : {}) },
      { configPath: flags.config });
    } catch (error) { return configError(error); }
    if (flags.json) console.log(JSON.stringify(plan));
    else {
      console.log(plan.reason);
      plan.steps.forEach((step, i) => console.log(`  ${i + 1}. ${step.seatId} (${step.engine}) ${step.model}`));
      for (const out of plan.ruledOut) console.log(`  skipped ${out.seatId}: ${out.reason}`);
    }
    return plan.ok ? 0 : plan.status === 'bad-request' ? 2 : 1;
  }
  if (verb === 'serve') {
    const flags = parseFlags(rest, ['--json', '--config', '--port']);
    if (typeof flags === 'string' || flags.positional.length) return usageError(typeof flags === 'string' ? flags : 'Unexpected argument.');
    let served;
    try { served = await core.serveRouterGateway({ configPath: flags.config, ...(flags.port ? { port: flags.port } : {}) }); }
    catch (error) {
      process.stderr.write(`Router gateway did not start: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    const info = { schema: core.ROUTER_GATEWAY_SCHEMA, url: served.running.url, port: served.running.port,
      config: served.configPath, configExists: served.configExists, tokenFile: served.tokenFile };
    if (flags.json) console.log(JSON.stringify(info));
    else {
      console.log(`Router gateway on ${info.url} (loopback only).`);
      console.log(`Bearer token file: ${info.tokenFile}`);
      console.log(`Config: ${info.config}${info.configExists ? '' : ' (absent; defaults apply)'}`);
      console.log('Press Ctrl-C to stop.');
    }
    await new Promise<void>((resolve) => {
      const stop = (): void => { void served.running.close().then(resolve); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  }
  return usageError(`Unknown router verb ${verb ?? ''}.`.trim());
}

/** `phm run --model auto|<lane:model> "<prompt>"`: one routed completion through the same core path. */
export async function cmdRunRouted(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, ['--json', '--config', '--model', '--task', '--difficulty', '--system']);
  if (typeof flags === 'string') return usageError(flags);
  if (!flags.model) return usageError('--model is required.');
  const prompt = flags.positional.join(' ').trim();
  if (!prompt) return usageError('Give the prompt as an argument: phm run --model auto "<prompt>".');
  const core = await import('../core/router-gateway/index.js');
  const abort = new AbortController();
  const onSignal = (): void => abort.abort();
  process.once('SIGINT', onSignal);
  let result;
  try {
    result = await core.completeViaRouter({
      model: flags.model, system: flags.system ?? '', prompt, signal: abort.signal,
      ...(flags.task ? { task: flags.task } : {}), ...(flags.difficulty ? { difficulty: flags.difficulty } : {}),
    }, { configPath: flags.config });
  } catch (error) {
    return configError(error);
  } finally {
    process.off('SIGINT', onSignal);
  }
  if (flags.json) console.log(JSON.stringify(result));
  else if (result.ok) {
    process.stdout.write(`${result.text.replace(/\n?$/, '\n')}`);
    process.stderr.write(`[${result.seatId} · ${result.model}]\n`);
  } else {
    process.stderr.write(`${result.reason}\n`);
    for (const attempt of result.attempts) process.stderr.write(`  ${attempt.seatId} ${attempt.outcome}: ${attempt.reason ?? ''}\n`);
  }
  return result.ok ? 0 : result.status === 'bad-request' ? 2 : 1;
}
