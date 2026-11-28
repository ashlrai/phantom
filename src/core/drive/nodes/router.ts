import { scrubSecrets } from '../../util/scrub.js';
import { isVersionCap } from './phm-version.js';
import { isNodeCapacity, NODE_HEARTBEAT_MS, type NodeRecord, type NodesState } from './state.js';
import type { QueueJobV1 } from './queue-v1.js';

/** Load added per claim a node already holds or is planned to receive (permille). */
export const CLAIM_LOAD = 100;
export const NODE_OFFLINE_MS = 300_000;

/** Missing or old heartbeat evidence never admits new work. */
export function nodeCanAcceptWork(node: NodeRecord, now: number): boolean {
  return node.expiresAt > now && node.heartbeatAt > 0 && node.heartbeatAt <= now && now - node.heartbeatAt < NODE_OFFLINE_MS;
}

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
  return state.nodes.filter(n => nodeCanAcceptWork(n, now));
}

/** True while a running job's claim can still be acted on: the claim is
 * unexpired and an unexpired node record carries the same id and session.
 * A lapsed claim is re-routable, and a claim fenced by a rejoin or departure
 * frees the node's capacity at once even though the job stays fenced until
 * the claim expires. */
export function actionableClaim(state: NodesState, job: QueueJobV1, now: number): boolean {
  const claim = job.claim;
  return job.state === 'running' && claim !== undefined && claim.expiresAt > now &&
    state.nodes.some(n => n.expiresAt > now && n.nodeId === claim.nodeId && n.session === claim.session);
}

function activeClaims(state: NodesState, node: NodeRecord, now: number): number {
  return state.jobs.filter(j => j.state === 'running' && j.claim && j.claim.expiresAt > now &&
    j.claim.nodeId === node.nodeId && j.claim.session === node.session).length;
}

/** Capability fences every assignment path honors: a session that released the
 * job unrun is never offered it again, advertised caps must cover `requires`,
 * and `gh` work needs a live local auth heartbeat. Owner scope is routing's
 * concern; a leader's direct claim still honors these. */
export function jobBlockers(node: NodeRecord, job: QueueJobV1): string[] {
  const reasons: string[] = [];
  if (job.declined?.includes(node.session)) reasons.push('declined');
  const missing = (job.requires ?? []).filter(c => !(node.caps ?? []).includes(c));
  if (missing.length) reasons.push(`caps:${missing.join(',')}`);
  if ((job.requires ?? []).includes('gh') && node.auth !== 'ok') reasons.push('auth');
  return reasons;
}

function shortfall(node: NodeRecord, job: QueueJobV1): string | null {
  if (!node.owners?.includes(job.owner!)) return 'owner';
  return jobBlockers(node, job)[0] ?? null;
}

/** The caps fix names one concrete rejoin instead of "a node": the in-scope
 * candidate missing the fewest required caps (candidates arrive in router
 * order — lowest node id first — and ties keep it), rejoining with its whole
 * advertised profile plus the job's caps, the same rule joinHintCommand
 * applies to expired-session fixes. "Every required cap" is the honest claim:
 * this branch runs only when no in-scope node advertises all of them, though
 * one may already cover a subset. Version-report caps stay out of the hint —
 * join re-derives the build marker itself — and a required `phm-<version>`
 * cap is called out separately, because no `--caps` list can advertise a build
 * the node does not run. Every inlined value comes from a parseState-validated
 * record, so the command is paste-safe. The fix ends in the join command, so
 * the standalone path's routesWithJoinWatch adds --watch exactly as it does
 * for the owner fix. */
function capsRejoinFix(job: QueueJobV1, candidates: NodeRecord[]): string {
  const requires = job.requires ?? [];
  const missing = (n: NodeRecord) => requires.filter(c => !(n.caps ?? []).includes(c)).length;
  const best = candidates.reduce((a, b) => (missing(b) < missing(a) ? b : a));
  const versioned = requires.filter(isVersionCap);
  const caps = [...new Set([...(best.caps ?? []).filter(c => !isVersionCap(c)),
    ...requires.filter(c => !isVersionCap(c))])];
  const owners = best.owners?.join(',') ?? job.owner!;
  const capsArg = caps.length ? ` --caps ${caps.join(',')}` : '';
  const slots = best.slots === undefined ? '' : ` --slots ${best.slots}`;
  const rejoin = `phm node join --node ${best.nodeId} --owner ${owners}${capsArg}${slots}`;
  // The caveat precedes the command so the fix still ends in the join — the
  // shape routesWithJoinWatch rewrites with --watch on the standalone path.
  const note = versioned.length === 0 ? '' :
    ` ${versioned.join(',')} names a phm build, not a --caps choice — join cannot advertise it; the node must run that version (phm node self-update).`;
  return `No node owned by '${job.owner}' advertises every required cap (${requires.join(',')}).${note} On ${best.nodeId}, rejoin with: ${rejoin}`;
}

/** Shared capacity slice of fleet.awareness.v1. Pool dispatch recomputes it inside the
 * witness transaction; file mirrors can never grant claims. No IO or state mutation. */
export function nodeCapacityView(state: NodesState | null, now: number) {
  const fresh = (at: number, now: number, interval: number) => at > 0 && at <= now && now - at <= 2 * interval;
  const safe = (s: string) => scrubSecrets(s) === s;
  const groups = new Map<string, NonNullable<NodesState>['nodes']>();
  for (const node of state?.nodes ?? []) {
    const id = isNodeCapacity(node.capacity) ? node.capacity.hostId : node.nodeId;
    const members = groups.get(id) ?? []; members.push(node); groups.set(id, members);
  }
  const unplacedClaims = state !== null && state.jobs.some(j => actionableClaim(state, j, now) &&
    !j.executionHostId && !state.nodes.some(n => n.nodeId === j.claim!.nodeId && isNodeCapacity(n.capacity)));
  const hosts = [...groups].filter(([id, nodes]) => safe(id) && nodes.every(n => safe(n.nodeId))).map(([hostId, nodes]) => {
    const nodeIds = nodes.map(n => n.nodeId).sort();
    const onHost = (j: NodesState['jobs'][number]) => j.executionHostId ? j.executionHostId === hostId : !!j.claim && nodeIds.includes(j.claim.nodeId);
    const live = nodes.filter(n => n.expiresAt > now && fresh(n.heartbeatAt, now, NODE_HEARTBEAT_MS));
    const measured = live.filter(n => isNodeCapacity(n.capacity) && fresh(n.capacity.sampledAtMs, now, NODE_HEARTBEAT_MS));
    const held = measured.map(n => n.capacity!.held).find(Boolean) ?? null;
    // Stale workers' old grants are not capacity. Live claims still occupy the physical host.
    const known = !unplacedClaims && measured.length > 0 && measured.length === live.length;
    const slots = held ? 0 : known ? Math.min(...measured.map(n => n.capacity!.slots)) : null;
    const running = state === null ? 0 : state.jobs.filter(j => actionableClaim(state, j, now) && onHost(j)).length;
    // A producer withdrawal completes without executing: its startedAt→completedAt
    // span is claim-hold plus detection lag, not runner time, so it is no latency evidence.
    // A worker ID can move between machines, so historical samples need a recorded execution host.
    const durations = (state?.jobs ?? []).filter(j => j.state === 'completed' && j.claim && j.producerWithdrawn !== true && j.executionHostId === hostId &&
      j.startedAt !== undefined && j.completedAt !== undefined && j.startedAt <= j.completedAt &&
      j.completedAt <= now && now - j.completedAt <= 86_400_000).map(j => j.completedAt! - j.startedAt!).sort((a, b) => a - b);
    const median = durations.length ? (durations[Math.floor((durations.length - 1) / 2)]! + durations[Math.floor(durations.length / 2)]!) / 2 : null;
    return { hostId, nodeIds, state: held ? 'held' as const : slots === null ? 'unknown' as const : 'ready' as const, held,
      ramBytes: known ? Math.min(...measured.map(n => n.capacity!.ramBytes)) : null, slots, running,
      freeSlots: slots === null ? null : Math.max(0, slots - running),
      eligibleNodeIds: measured.filter(n => !n.capacity!.held).map(n => n.nodeId),
      latency: { samples: durations.length, medianMs: median, windowMs: 86_400_000 } };
  }).sort((a, b) => a.hostId.localeCompare(b.hostId));
  return hosts;
}

/** The gh-auth fix must be runnable: `phm node beat --probe-auth` alone is a
 * missing-flag error without --node/--session. On the standalone registry —
 * a single host — the first node whose only blocker is auth supplies the full
 * command, and one --probe-auth beat sticks (later beats only overwrite auth
 * when they carry it). A pool worker's auth is self-reported on its own beats,
 * and --probe-auth run from any other machine would read that machine's gh
 * login, not the node's, so the pool fix stays guidance without a command. */
function authFix(job: QueueJobV1, nodes: NodeRecord[], state: NodesState): string {
  const blocked = state.pool === undefined ? nodes.find(n =>
    n.owners?.includes(job.owner!) === true &&
    jobBlockers(n, job).length === 1 && jobBlockers(n, job)[0] === 'auth') : undefined;
  return blocked === undefined
    ? `Nodes owned by '${job.owner}' lack local gh auth. Run 'gh auth login' on a machine running a node in that scope; its own beats report the login.`
    : `Nodes owned by '${job.owner}' lack local gh auth. Run 'gh auth login' on this computer, then: phm node beat --node ${blocked.nodeId} --session ${blocked.session} --probe-auth`;
}

/** Deterministic plan: pools rank measured free host slots per observed execution millisecond;
 * workers on the same host prefer fewer active and planned claims. Standalone
 * legacy queues retain their load policy. Remaining ties break by node ID.
 * Pure: the same state and clock always produce the same plan. Jobs without an
 * owner scope are never routed, so a legacy job cannot leak across scopes.
 */
export function planRoutes(state: NodesState, now: number, owner?: string): RouteAssignment[] {
  const capacity = nodeCapacityView(state, now);
  const hosts = new Map(capacity.flatMap(h => h.nodeIds.map(id => [id, h] as const)));
  const measuredLatency = capacity.map(h => h.latency.medianMs).filter((n): n is number => n !== null && n > 0);
  const neutralLatency = measuredLatency.length ? measuredLatency.reduce((a, b) => a + b, 0) / measuredLatency.length : 1;
  const reserved = new Map<string, number>();
  const nodes = liveNodes(state, now).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
  const load = new Map(nodes.map(n => [n.nodeId, (n.usage ?? 0) + CLAIM_LOAD * activeClaims(state, n, now)]));
  const claims = new Map(nodes.map(n => [n.nodeId, activeClaims(state, n, now)]));
  const plan: RouteAssignment[] = [];
  for (const job of state.jobs) {
    if (!job.owner || !routable(job, now)) continue;
    // Scope the preview without changing the reservations used by pull.
    const visible = owner === undefined || job.owner === owner;
    const reasons = new Map<string, number>();
    let best: NodeRecord | null = null;
    for (const node of nodes) {
      const why = shortfall(node, job);
      if (why) { reasons.set(why.split(':')[0]!, 1); continue; }
      if (node.slots !== undefined && claims.get(node.nodeId)! >= node.slots) { reasons.set('capacity', 1); continue; }
      const host = hosts.get(node.nodeId);
      if (state.pool && (!host || !host.eligibleNodeIds.includes(node.nodeId) ||
          (host.freeSlots ?? 0) <= (reserved.get(host.hostId) ?? 0))) { reasons.set('capacity', 1); continue; }
      const score = (n: NodeRecord) => {
        const h = hosts.get(n.nodeId)!;
        return state.pool ? ((h.freeSlots ?? 0) - (reserved.get(h.hostId) ?? 0)) / Math.max(1, h.latency.medianMs ?? neutralLatency) : -load.get(n.nodeId)!;
      };
      if (!best || score(node) > score(best) ||
          (state.pool && host === hosts.get(best.nodeId) &&
            claims.get(node.nodeId)! < claims.get(best.nodeId)!)) best = node;
    }
    if (best) {
      const host = hosts.get(best.nodeId);
      if (host) reserved.set(host.hostId, (reserved.get(host.hostId) ?? 0) + 1);
      load.set(best.nodeId, load.get(best.nodeId)! + CLAIM_LOAD);
      claims.set(best.nodeId, claims.get(best.nodeId)! + 1);
      if (visible) plan.push({ jobId: job.id, owner: job.owner, nodeId: best.nodeId });
      continue;
    }
    if (!visible) continue;
    const requires = job.requires ?? [];
    const inScope = nodes.filter(n => n.owners?.includes(job.owner!));
    // The "no node advertises" claim needs the literal check: a node blocked on
    // declined, auth or capacity still advertises its caps, and `reasons` records
    // only each node's first fence, so blocker reasons alone cannot prove it.
    const capsReady = inScope.filter(n => !jobBlockers(n, job).some(b => b.startsWith('caps:')));
    const fix = inScope.length === 0
      ? `No live node belongs to owner '${job.owner}'. Run: phm node join --owner ${job.owner}${requires.length ? ` --caps ${requires.join(',')}` : ''}`
      : reasons.has('capacity')
        ? `Nodes owned by '${job.owner}' have no free job slots. Wait for work to finish or memory headroom to recover.`
        : capsReady.length === 0
          ? capsRejoinFix(job, inScope)
          : reasons.has('auth')
            ? authFix(job, nodes, state)
            : reasons.has('declined')
              ? `Every eligible node released '${job.id}' unrun (it cannot execute the job). Enqueue a new job id with --requires naming a cap an eligible node advertises.`
              : authFix(job, nodes, state);
    plan.push({ jobId: job.id, owner: job.owner, nodeId: null, fix });
  }
  return plan;
}
