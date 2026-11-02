import { formatAge } from '../core/nodes/age.js';
import { buildNodesSnapshot } from '../core/nodes/view.js';

const USAGE = 'Usage: phm nodes [--json] [--now <ISO-8601>]';

/** Thin handler: parse argv, delegate to src/core/nodes/view.ts. Read-only. */
export function cmdNodes(args: string[]): number {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${USAGE}\nShow every node that joined this fleet: role, caps, heartbeat age, live jobs, leader. Read-only; credentials are never read or shown. See docs/NODES-VIEW.md.`);
    return 0;
  }
  const json = args.includes('--json');
  let nowMs: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--now') {
      nowMs = Date.parse(args[++i] ?? '');
      if (!Number.isFinite(nowMs)) return fail(json, '--now needs an ISO-8601 time, for example --now 2026-01-01T00:00:00Z.');
      continue;
    }
    return fail(json, `Unknown argument "${arg}". ${USAGE}`);
  }
  const snap = buildNodesSnapshot({ nowMs });
  if (json) {
    console.log(JSON.stringify(snap));
    return 0;
  }
  console.log(`Nodes (${snap.nodes.length}) · leader: ${snap.leaderId ?? 'none (no live lease)'}`);
  for (const n of snap.nodes) {
    console.log(`${n.leader ? '★' : ' '} ${n.id}  ${n.role}  ${n.status}  heartbeat ${formatAge(n.heartbeatAgeMs)}  jobs ${n.liveJobs.length}  gh-auth ${n.ghAuth}  caps ${n.caps.join(',') || '-'}`);
  }
  for (const p of snap.problems) console.log(`! ${p.file}: ${p.problem}. Fix: ${p.fix}`);
  if (snap.nodes.every((n) => n.source === 'local')) console.log('No other nodes registered. A node joins by writing its own record to ~/.ashlr/nodes/<id>.json (docs/NODES-VIEW.md).');
  return 0;
}

function fail(json: boolean, error: string): number {
  if (json) console.log(JSON.stringify({ error }));
  else console.error(error);
  return 2;
}
