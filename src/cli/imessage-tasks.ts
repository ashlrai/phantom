/** Scoped teammate tasks: argument parsing only; send policy stays in core. */
import { parseArgs } from 'node:util';
import { loadConfigReadOnlyStrict } from '../core/config.js';
import { enqueueTeammateTask, listTeammateTasks, runTeammateTasks, teammateTaskPeers } from '../core/comms/imessage-teammate-tasks.js';

const USAGE = `Usage: phm imessage tasks enqueue --peer dot|instinct --job <id>
  --kind research|triage|report|rebase --scope <text> --repo <owner/name>
  [--pr <number> ...] --format <text> --deadline <ISO timestamp>
  [--apply|--dry-run] [--json]
       phm imessage tasks dispatch [--apply|--dry-run] [--json]
       phm imessage tasks list|peers [--json]
Enqueue and dispatch preview by default. Apply reserves work or uses the
existing approved teammate transport. Reports omit message bodies and handles.`;

export interface IMessageTasksDeps {
  enqueue?: typeof enqueueTeammateTask;
  list?: typeof listTeammateTasks;
  dispatch?: typeof runTeammateTasks;
  peers?: typeof teammateTaskPeers;
  config?: typeof loadConfigReadOnlyStrict;
  output?: (text: string) => void;
}

export async function cmdIMessageTasks(args: string[], deps: IMessageTasksDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const json = args.includes('--json');
  let parsed = false;
  try {
    const { values, positionals, tokens } = parseArgs({ args, allowPositionals: true, strict: true, tokens: true, options: {
      json: { type: 'boolean' }, apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      peer: { type: 'string' }, job: { type: 'string' }, kind: { type: 'string' },
      scope: { type: 'string' }, repo: { type: 'string' }, format: { type: 'string' },
      deadline: { type: 'string' }, pr: { type: 'string', multiple: true },
    } });
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== 'option') continue;
      if (token.name !== 'pr' && seen.has(token.name)) throw new Error('Duplicate option');
      seen.add(token.name);
    }
    if (values.help) { output(json ? JSON.stringify({ usage: USAGE }) : USAGE); return 0; }
    const [command] = positionals;
    if (positionals.length !== 1 || !['enqueue', 'dispatch', 'list', 'peers'].includes(command)) throw new Error('Invalid command');
    const allowed = command === 'enqueue'
      ? ['json', 'apply', 'dry-run', 'peer', 'job', 'kind', 'scope', 'repo', 'format', 'deadline', 'pr']
      : command === 'dispatch' ? ['json', 'apply', 'dry-run'] : ['json'];
    if (Object.keys(values).some(key => !allowed.includes(key)) || values.apply && values['dry-run']) throw new Error('Invalid options');
    let result: object;
    if (command === 'enqueue') {
      const { peer, kind, job: jobId, scope, repo, format, deadline } = values;
      if ((peer !== 'dot' && peer !== 'instinct') ||
          (kind !== 'research' && kind !== 'triage' && kind !== 'report' && kind !== 'rebase') ||
          !jobId?.trim() || !scope?.trim() || !repo?.trim() || !format?.trim() || !deadline?.trim()) throw new Error('Missing task fields');
      const prRefs = values.pr?.map(value => {
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid PR');
        return Number(value);
      });
      if (prRefs && new Set(prRefs).size !== prRefs.length) throw new Error('Duplicate PR');
      parsed = true;
      result = await (deps.enqueue ?? enqueueTeammateTask)({ jobId, peer, kind, scope, repo, format, deadline, ...(prRefs ? { prRefs } : {}) },
        (deps.config ?? loadConfigReadOnlyStrict)(), { apply: values.apply === true });
    } else {
      parsed = true;
      result = command === 'list' ? await (deps.list ?? listTeammateTasks)()
        : command === 'peers' ? await (deps.peers ?? teammateTaskPeers)()
        : await (deps.dispatch ?? runTeammateTasks)((deps.config ?? loadConfigReadOnlyStrict)(), { apply: values.apply === true });
    }
    output(JSON.stringify(result, null, json ? undefined : 2));
    const report = result as { state?: string; ok?: boolean };
    return report.ok === false || ['error', 'unavailable', 'refused'].includes(report.state ?? '') ? 1 : 0;
  } catch {
    const error = parsed ? 'Teammate task operation unavailable; check configuration and task state.' : 'Invalid teammate task arguments.';
    output(json ? JSON.stringify({ error, ...(parsed ? {} : { usage: USAGE }) }) : `${error}${parsed ? '' : `\n${USAGE}`}`);
    return parsed ? 1 : 2;
  }
}
