import { formatAge } from '../core/nodes/age.js';
import { buildNodesSnapshot } from '../core/nodes/view.js';

export function cmdFleetNodes(args: string[]): number {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: ashlr fleet nodes [--json] [--now <ISO-8601>]');
    return 0;
  }
  let nowMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--now') {
      nowMs = Date.parse(args[++i] ?? '');
      if (Number.isFinite(nowMs)) continue;
    }
    const error = 'Invalid arguments. Usage: ashlr fleet nodes [--json] [--now <ISO-8601>]';
    if (json) console.log(JSON.stringify({ error })); else console.error(error);
    return 2;
  }
  const snap = buildNodesSnapshot({ nowMs });
  if (json) console.log(JSON.stringify(snap));
  else {
    console.log(`Nodes (${snap.nodes.length}) · leader: ${snap.leaderId ?? 'none (no live lease)'} · source: ${snap.sourcePath} · observed: ${snap.observedAt ?? 'unknown'}`);
    for (const n of snap.nodes) console.log(`${n.leader ? '★' : ' '} ${n.id}  ${n.role}  ${n.status}  heartbeat ${formatAge(n.heartbeatAgeMs)}  jobs ${n.liveJobs.length}  gh-auth ${n.ghAuth}  caps ${n.caps.join(',') || '-'}`);
    if (snap.error) console.log(`! ${snap.error}`);
  }
  return snap.error ? 1 : 0;
}
