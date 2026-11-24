/** `phm agents apps` dispatcher. Parsing only; adapters live in src/core/agents/apps/. */
import { describeAgentApps, type AgentAppRegistry, type AgentAppResult } from '../core/agents/apps/adapter.js';
import { createAgentAppRegistry } from '../core/agents/apps/registry.js';
import { scrubSecrets } from '../core/util/scrub.js';

export const AGENTS_APPS_HELP = `ashlr agents apps [--json]
ashlr agents apps <id> sessions|show <session>|usage [--window <title>] --json
ashlr agents apps <id> launch --prompt <text> [--model <id>] [--cwd <abs>] --json
ashlr agents apps <id> send <session> --prompt <text> --json
Ids: codex-cli, claude-cli, devin-cli, <devin|claude|codex|grok|cursor>-desktop.
See docs/AGENT-APPS.md.`;

const VALUE_FLAGS = new Set(['--prompt', '--model', '--cwd', '--window']);

export async function runAgentsAppsCli(
  args: string[],
  out: (text: string) => void = console.log,
  err: (text: string) => void = console.error,
  registry: AgentAppRegistry = createAgentAppRegistry(),
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { out(AGENTS_APPS_HELP); return 0; }
  const json = args.includes('--json');
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    const value = args[i + 1];
    if (!VALUE_FLAGS.has(arg) || flags[arg] !== undefined || value === undefined || value.startsWith('--')) {
      if (arg.startsWith('--')) return invalid(err, json);
      positional.push(arg);
      continue;
    }
    flags[arg] = value;
    i += 1;
  }
  if (positional.length === 0 && Object.keys(flags).length === 0) {
    const described = await describeAgentApps(registry);
    out(json ? JSON.stringify(described) : described.apps.map((app) =>
      `${app.id}  ${app.available === null ? 'probe' : app.available ? 'ready' : 'unavailable'}  ${Object.entries(app.capabilities).filter(([, c]) => c.supported).map(([k]) => k).join(',') || '-'}`).join('\n'));
    return 0;
  }
  const [id, verb, session, ...extra] = positional;
  const adapter = id ? registry.get(id) : undefined;
  if (!adapter || !json || extra.length > 0) return invalid(err, json);
  let result: AgentAppResult<unknown>;
  if (verb === 'sessions' && session === undefined) result = await adapter.listSessions();
  else if (verb === 'show' && session !== undefined) result = await adapter.readSession(session);
  else if (verb === 'usage' && session === undefined) result = await adapter.readUsage(flags['--window'] ? { window: flags['--window'] } : {});
  else if (verb === 'launch' && session === undefined && flags['--prompt']) {
    result = await adapter.launchTask({ prompt: flags['--prompt'], ...(flags['--model'] ? { model: flags['--model'] } : {}), ...(flags['--cwd'] ? { cwd: flags['--cwd'] } : {}) });
  } else if (verb === 'send' && session !== undefined && flags['--prompt']) result = await adapter.sendMessage(session, flags['--prompt']);
  else return invalid(err, json);
  out(scrubSecrets(JSON.stringify(result)));
  return result.ok ? 0 : 1;
}

function invalid(err: (text: string) => void, json: boolean): 2 {
  return err(json ? JSON.stringify({ ok: false, code: 'invalid', error: 'Invalid agents apps arguments. Run phm agents apps --help.' }) : AGENTS_APPS_HELP), 2;
}
