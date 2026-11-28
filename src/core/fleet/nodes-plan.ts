/**
 * core/fleet/nodes-plan.ts: a read-only plan for spreading queued jobs over
 * the computers in the pool. Backs `phm nodes plan [--json]` and the badge on
 * the desktop fleet map.
 *
 * It only reads: the node view (nodes-view.ts: tailnet, registry, this
 * computer's sample) and the launch-order queue (queue/order.ts). It never
 * launches, moves, kills or reserves anything. A fact that cannot be read
 * stays "unknown"; an offline computer is suggested 0 slots, and one whose
 * state is unconfirmed (for example a live heartbeat with reachability the
 * tailnet cannot vouch for) is suggested "unknown" — never slots the plan's
 * own assignment rule would refuse. Queued jobs no computer can take are
 * counted in `unassigned` and grouped by lane in `unassigned_reasons` with
 * the plain reason, so a starving lane is visible instead of a bare count.
 */
import { remoteLaneCap } from './unfed-market.js';
import { capServesLane, chooseNodeForLane, readNodesView, type NodeRow, type NodesView, type NodesViewDeps } from './nodes-view.js';
import { UNKNOWN } from './runtime-identity.js';
import type { QueueOrderJob, QueueOrderV1 } from '../queue/order-types.js';

type Unknown = typeof UNKNOWN;
export const NODES_PLAN_SCHEMA = 'phantom.nodes-plan.v1';
export const TAILSCALE_MISSING_WORDS = 'Tailscale is not installed here.';
/** Only the first jobs in launch order are planned; the rest wait for a later look. */
export const PLAN_JOB_LIMIT = 50;

export interface PlanNode {
  name: string;
  online: boolean | Unknown;
  free_mem_pct: number | Unknown;
  load: number | Unknown;
  lanes: string[] | Unknown;
  /** How many more jobs this computer could take now; 0 when offline or held; "unknown" when not measured or its state is unconfirmed. */
  suggested_slots: number | Unknown;
  /** Plain words. */
  why: string;
}
export interface PlanAssignment { job: string; node: string; lane?: string; why: string }
/** Queued jobs that waited because no computer could take their lane, grouped by lane. */
export interface PlanUnassigned { lane: string; jobs: number; why: string }
export interface NodesPlan {
  schema: typeof NODES_PLAN_SCHEMA;
  as_of: string;
  nodes: PlanNode[];
  assignable: PlanAssignment[];
  /** Queued jobs looked at that no computer can take now. */
  unassigned: number | Unknown;
  /** The same waiting jobs grouped by lane, each with the plain reason none fit. */
  unassigned_reasons: PlanUnassigned[];
  /** Gaps in the evidence, in plain words. */
  reasons: string[];
}

/** The clause nodes-view appends when a live node's slot count is unmeasured
 * ("Phantom running; free slots unknown"). `why` must not repeat it: the plan
 * row read "…; free slots unknown; free slots unknown" on every joined computer
 * that had not reported slots yet. */
const FREE_SLOTS_UNKNOWN = 'free slots unknown';
function unknownSlotsWhy(state: string): string {
  return state.endsWith(FREE_SLOTS_UNKNOWN) ? state : `${state}; ${FREE_SLOTS_UNKNOWN}`;
}

export function planNode(node: NodeRow): PlanNode {
  const down = node.reachable === false || node.stateCode === 'offline';
  // An unconfirmed state (stateCode 'unknown': e.g. a live registry heartbeat
  // whose reachability the tailnet cannot vouch for) cannot promise slots —
  // chooseNodeForLane would refuse the node, so the plan must not advertise
  // capacity it can never assign.
  const slots: number | Unknown = down || node.phantom === 'not-running' || node.stateCode === 'held' ? 0
    : node.stateCode === 'unknown' ? UNKNOWN : node.freeSlots;
  const why = down ? `${node.state}; no jobs suggested`
    : slots === UNKNOWN ? unknownSlotsWhy(node.state)
      : slots === 0 ? node.state
        : `${node.state}; room for ${slots} more ${slots === 1 ? 'job' : 'jobs'}`;
  return { name: node.name, online: node.reachable, free_mem_pct: node.freeMemoryPercent, load: node.load, lanes: node.lanes, suggested_slots: slots, why };
}

/** Plain words for why no computer could take a job for `lane` at this point in the plan.
 * `match` is the name the placement matched on — a node cap for a lane the
 * bridge can send remote, the lane itself for a host-bound one — and `selfOnly`
 * marks lanes no remote computer can ever take. */
function noReadyNodeWhy(pool: NodesView, lane: string, match: string, selfOnly: boolean): string {
  const advertisers = pool.nodes.filter(node => (!selfOnly || node.isSelf) && node.lanes !== UNKNOWN
    && node.lanes.some(cap => capServesLane(cap, match)));
  if (advertisers.length === 0) return selfOnly ? `the ${lane} lane cannot run on another computer` : `no computer can run ${lane} jobs`;
  const states = new Map<string, number>();
  for (const node of advertisers) {
    // A node the live view calls ready can still be full in this plan: earlier
    // assignments spent its suggested slots.
    const state = node.stateCode === 'ready' && node.freeSlots === 0 ? 'no free slots left in this plan' : node.state;
    states.set(state, (states.get(state) ?? 0) + 1);
  }
  return `${selfOnly ? `only this computer can run ${lane}` : `computers that can run ${lane}`}: ${[...states].map(([state, count]) => (count === 1 ? state : `${count} × ${state}`)).join('; ')}`;
}

/** Pure: greedy launch-order assignment over the slots the plan suggests. */
export function buildNodesPlan(view: NodesView, queue: QueueOrderV1 | null, extraReasons: string[] = []): NodesPlan {
  const nodes = view.nodes.map(planNode);
  const reasons = [...extraReasons];
  const remaining = new Map(nodes.map(n => [n.name, n.suggested_slots] as const));
  const assignable: PlanAssignment[] = [];
  const starved = new Map<string, PlanUnassigned>();
  let unassigned: number | Unknown = UNKNOWN;
  if (!queue) reasons.push('queue unreadable; job assignments unknown');
  else {
    unassigned = 0;
    const jobs: QueueOrderJob[] = queue.jobs.slice(0, PLAN_JOB_LIMIT);
    if (queue.jobs.length > PLAN_JOB_LIMIT) reasons.push(`only the first ${PLAN_JOB_LIMIT} of ${queue.jobs.length} queued jobs were planned`);
    for (const job of jobs) {
      // job.lane is a market lane; a computer advertises provider caps. The
      // claim bridge resolves the lane to the cap a remote node needs
      // (remoteLaneCap): codex-* lanes need `codex`, claude-* need `claude`,
      // and lanes that only run on this host or on an API key never leave it —
      // those match this computer's own caps only.
      const remoteCap = remoteLaneCap(job.lane);
      const selfOnly = remoteCap === null;
      const match = remoteCap ?? job.lane;
      // Same rule as `phm nodes --can-take`, but over the slots this plan still has left.
      const pool: NodesView = { ...view, nodes: view.nodes.map(n => ({ ...n, freeSlots: remaining.get(n.name) ?? UNKNOWN })) };
      const placement = chooseNodeForLane(pool, match, { localOnly: selfOnly });
      if (!placement.node) {
        unassigned += 1;
        const entry = starved.get(job.lane) ?? { lane: job.lane, jobs: 0, why: '' };
        entry.jobs += 1;
        entry.why = noReadyNodeWhy(pool, job.lane, match, selfOnly);
        starved.set(job.lane, entry);
        continue;
      }
      const left = remaining.get(placement.node);
      if (typeof left === 'number') remaining.set(placement.node, left - 1);
      assignable.push({ job: job.id, node: placement.node, lane: job.lane, why: `${job.lane} lane: ${placement.explanation}` });
    }
  }
  return { schema: NODES_PLAN_SCHEMA, as_of: view.asOf, nodes, assignable, unassigned, unassigned_reasons: [...starved.values()], reasons };
}

export interface NodesPlanDeps { view: NodesViewDeps; readQueue(): Promise<QueueOrderV1> }

/** Read every source through its seam and plan; never throws. */
export async function readNodesPlan(deps: NodesPlanDeps): Promise<NodesPlan> {
  let missing = false;
  const exec = deps.view.peers.exec;
  const view = readNodesView({ ...deps.view, peers: { ...deps.view.peers, exec: (cmd, args) => {
    try { return exec(cmd, args); } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT' || /ENOENT/.test(String((error as Error | null)?.message))) missing = true;
      throw error;
    }
  } } });
  const reasons = missing ? [TAILSCALE_MISSING_WORDS, ...view.reasons.filter(r => !r.startsWith('tailscale unavailable'))] : view.reasons;
  const queue = await deps.readQueue().catch(() => null);
  return buildNodesPlan(view, queue, reasons);
}
