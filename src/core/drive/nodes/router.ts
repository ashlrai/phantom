import type { NodeRecord, NodesState } from './state.js';
import type { QueueJobV1 } from './queue-v1.js';

/** Load added per claim a node already holds or is planned to receive (permille). */
export const CLAIM_LOAD = 100;

export interface RouteAssignment {
  jobId: string;
  owner: string;
  /** Best node, or null when no live node can take the job (see `fix`). */
  nodeId: string | null;
  /** Why nobody can take it, with the command or step that fixes it. */
  fix?: string;
}

/** A job is routable while pending or when its lease lapsed (a later token fences the old holder). */
export function routable(job: QueueJobV1, now: number): boolean {
  if (job.state === 'pending') return true;
  return job.state === 'running' && !!job.claim && job.claim.expiresAt <= now;
}

export function liveNodes(state: NodesState, now: number): NodeRecord[] {
  return state.nodes.filter(n => n.expiresAt > now);
}

function activeClaims(state: NodesState, nodeId: string, now: number): number {
  return state.jobs.filter(j => j.state === 'running' && j.claim && j.claim.expiresAt > now &&
    j.claim.nodeId === nodeId).length;
}

function shortfall(node: NodeRecord, job: QueueJobV1): string | null {
  if (!node.owners?.includes(job.owner!)) return 'owner';
  const missing = (job.requires ?? []).filter(c => !(node.caps ?? []).includes(c));
  if (missing.length) return `caps:${missing.join(',')}`;
  if ((job.requires ?? []).includes('gh') && node.auth !== 'ok') return 'auth';
  return null;
}

/** Deterministic plan: jobs in queue order, each to the least-loaded eligible live node
 * (self-reported usage plus held and planned claims), ties broken by node ID.
 * Pure: the same state and clock always produce the same plan. Jobs without an
 * owner scope are never routed, so a legacy job cannot leak across scopes.
 */
export function planRoutes(state: NodesState, now: number, owner?: string): RouteAssignment[] {
  const nodes = liveNodes(state, now).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
  const load = new Map(nodes.map(n => [n.nodeId, (n.usage ?? 0) + CLAIM_LOAD * activeClaims(state, n.nodeId, now)]));
  const plan: RouteAssignment[] = [];
  for (const job of state.jobs) {
    if (!job.owner || (owner !== undefined && job.owner !== owner) || !routable(job, now)) continue;
    const reasons = new Map<string, number>();
    let best: NodeRecord | null = null;
    for (const node of nodes) {
      const why = shortfall(node, job);
      if (why) { reasons.set(why.split(':')[0]!, 1); continue; }
      if (!best || load.get(node.nodeId)! < load.get(best.nodeId)!) best = node;
    }
    if (best) {
      load.set(best.nodeId, load.get(best.nodeId)! + CLAIM_LOAD);
      plan.push({ jobId: job.id, owner: job.owner, nodeId: best.nodeId });
      continue;
    }
    const fix = !nodes.some(n => n.owners?.includes(job.owner!))
      ? `No live node belongs to owner '${job.owner}'. Run: phm node join --node <id> --owner ${job.owner} --caps <caps>`
      : reasons.has('caps')
        ? `No node owned by '${job.owner}' advertises ${(job.requires ?? []).join(',')}. Rejoin a node with --caps including them.`
        : `Nodes owned by '${job.owner}' lack local gh auth. Run 'gh auth login' on one, then: phm node beat --probe-auth`;
    plan.push({ jobId: job.id, owner: job.owner, nodeId: null, fix });
  }
  return plan;
}
