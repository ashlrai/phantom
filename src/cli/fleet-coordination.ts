/** Local-only advisory ledger commands. No worker/dispatch imports belong here. */
import {
  claimFleetWork, handoffFleetClaim, postFleetMessage, proposeFleetAssignment,
  readFleetBoard, releaseFleetClaim,
} from '../core/fleet/coordination.js';

export const FLEET_COORDINATION_HELP = [
  'phm fleet claim --repo owner/repo --task "work" --agent name [--ttl-seconds 3600] [--json]',
  'phm fleet release <claim-id> --agent name --lease <lease> [--json]',
  'phm fleet handoff <claim-id> --agent name --lease <lease> --to name [--ttl-seconds 3600] [--json]',
  'phm fleet board [--json]',
  'phm fleet post --from name --to name --message "text" [--id id] [--ttl-seconds 3600] [--json]',
  'phm fleet inbox --agent name [--json]',
  'phm fleet assign --repo owner/repo --task "work" --to name [--ttl-seconds 3600] [--json]',
  'Claims coordinate only. Assign proposes work and never spawns an agent.',
  'Keep the lease from claim/handoff private; it fences release and later handoffs.',
].join('\n');
const VALUES: Record<string, string[]> = {
  claim: ['--repo', '--task', '--agent', '--ttl-seconds'], release: ['--agent', '--lease'],
  handoff: ['--agent', '--lease', '--to', '--ttl-seconds'], board: [],
  post: ['--from', '--to', '--message', '--id', '--ttl-seconds'], inbox: ['--agent'],
  assign: ['--repo', '--task', '--to', '--ttl-seconds'],
};
export async function cmdFleetCoordination(sub: string, args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(FLEET_COORDINATION_HELP); return 0; }
  const allowed = VALUES[sub];
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const json = args.includes('--json');
  const invalid = (): number => { console.error('Invalid fleet coordination arguments.\n' + FLEET_COORDINATION_HELP); return 2; };
  if (!allowed) return invalid();
  let jsonSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { if (jsonSeen) return invalid(); jsonSeen = true; continue; }
    if (allowed.includes(arg)) {
      const value = args[++i];
      if (values[arg] !== undefined || !value || value.startsWith('--')) return invalid();
      values[arg] = value;
    } else if (arg.startsWith('-')) return invalid();
    else positional.push(arg);
  }
  if (positional.length !== ((sub === 'release' || sub === 'handoff') ? 1 : 0)) return invalid();
  const ttl = values['--ttl-seconds'];
  if (ttl !== undefined && !/^[1-9]\d{0,5}$/.test(ttl)) return invalid();
  const ttlMs = ttl === undefined ? undefined : Number(ttl) * 1000;
  const value = (name: string): string => values[`--${name}`] ?? '';
  const output = (result: unknown): void => {
    // Structured local output makes explicit unknown/error states visible in both modes.
    console.log(JSON.stringify(result, null, json ? undefined : 2));
  };
  if (sub === 'board' || sub === 'inbox') {
    if (sub === 'inbox' && !value('agent')) return invalid();
    const board = readFleetBoard();
    output(sub === 'board' ? board : { schema: board.schema, state: board.state, messages: board.messages.filter(m => m.to === value('agent') || m.to === 'all'), proposals: board.proposals.filter(p => p.to === value('agent')) });
    return board.state === 'known' ? 0 : 1;
  }
  const result = sub === 'claim' ? claimFleetWork({ repo: value('repo'), task: value('task'), agent: value('agent'), ttlMs })
    : sub === 'release' ? releaseFleetClaim({ id: positional[0]!, agent: value('agent'), lease: value('lease') })
      : sub === 'handoff' ? handoffFleetClaim({ id: positional[0]!, agent: value('agent'), lease: value('lease'), to: value('to'), ttlMs })
        : sub === 'post' ? postFleetMessage({ from: value('from'), to: value('to'), body: value('message'), id: values['--id'], ttlMs })
          : proposeFleetAssignment({ repo: value('repo'), task: value('task'), to: value('to'), ttlMs });
  output(result);
  return result.ok ? 0 : result.error === 'invalid-input' ? 2 : 1;
}
