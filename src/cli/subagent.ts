import { TASK_CLASSES } from '../core/decide/registry.js';
import { listSubagents, planSubagentSpawn, type SubagentOptions, type SubagentSpawnInput } from '../core/subagent/spawn.js';
import { readSubagentResult } from '../core/subagent/result.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm subagent spawn --parent <id> --tier fast|mid|work|frontier --task <text>
  [--tools a,b] [--write-scope p1,p2] [--max-tokens N] [--max-cost-class local|included|metered]
  [--task-class <class>] [--repo <repo>] [--dry-run|--apply] [--json]
       phm subagent list --parent <id> [--json]
       phm subagent result <id> [--json]
Default dry-run. Apply only stores a held scope record; it never dispatches.`;
export interface SubagentCliDeps {
  options?: SubagentOptions; spawn?: typeof planSubagentSpawn;
  list?: typeof listSubagents; result?: typeof readSubagentResult;
}
export async function cmdSubagent(args: string[], deps: SubagentCliDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  const verb = rest.shift();
  const print = (value: unknown) => console.log(json ? JSON.stringify(sanitizePublicJson(value)) : JSON.stringify(sanitizePublicJson(value), null, 2));
  const invalid = () => { console.error(usage); return 2; };
  const options = deps.options ?? {};
  if (verb === 'result' && rest.length === 1 && !rest[0].startsWith('-')) {
    const result = await (deps.result ?? readSubagentResult)(rest[0], options);
    print(result); return result.found ? 0 : 1;
  }
  if (verb !== 'spawn' && verb !== 'list') return invalid();
  const flags: Record<string, string> = {};
  const allowed = verb === 'list' ? ['--parent'] : ['--parent', '--tier', '--task', '--tools', '--write-scope', '--max-tokens', '--max-cost-class', '--task-class', '--repo', '--dry-run', '--apply'];
  while (rest.length) {
    const flag = rest.shift()!;
    if (!allowed.includes(flag) || flag in flags) return invalid();
    if (flag === '--dry-run' || flag === '--apply') flags[flag] = 'true';
    else {
      const value = rest.shift();
      if (!value || value.startsWith('--')) return invalid();
      flags[flag] = value;
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(flags['--parent'] ?? '')) return invalid();
  if (verb === 'list') { print(await (deps.list ?? listSubagents)(flags['--parent'], options)); return 0; }
  if (!['fast', 'mid', 'work', 'frontier'].includes(flags['--tier']) || !flags['--task']?.trim()
    || (flags['--apply'] && flags['--dry-run'])
    || (flags['--max-tokens'] !== undefined && (!/^\d+$/.test(flags['--max-tokens']) || !Number.isSafeInteger(Number(flags['--max-tokens'])) || Number(flags['--max-tokens']) <= 0))
    || (flags['--max-cost-class'] !== undefined && !['local', 'included', 'metered'].includes(flags['--max-cost-class']))
    || (flags['--task-class'] !== undefined && !(TASK_CLASSES as readonly string[]).includes(flags['--task-class']))
    || (flags['--repo'] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(flags['--repo']))) return invalid();
  const input: SubagentSpawnInput = {
    parent_id: flags['--parent'], tier: flags['--tier'] as SubagentSpawnInput['tier'], task: flags['--task'], apply: !!flags['--apply'],
    ...(flags['--tools'] !== undefined ? { tools_allowed: flags['--tools'].split(',') } : {}),
    ...(flags['--write-scope'] !== undefined ? { write_scope: flags['--write-scope'].split(',') } : {}),
    ...(flags['--max-tokens'] ? { max_tokens: Number(flags['--max-tokens']) } : {}),
    ...(flags['--max-cost-class'] ? { max_cost_class: flags['--max-cost-class'] as SubagentSpawnInput['max_cost_class'] } : {}),
    ...(flags['--task-class'] ? { task_class: flags['--task-class'] as SubagentSpawnInput['task_class'] } : {}),
    ...(flags['--repo'] ? { repo: flags['--repo'] } : {}),
  };
  const result = await (deps.spawn ?? planSubagentSpawn)(input, options);
  print(result); return result.ok ? 0 : 1;
}
