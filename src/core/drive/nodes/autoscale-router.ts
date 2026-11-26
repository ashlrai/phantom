/**
 * (node, provider, model) router (RQ-NODE-AUTOSCALE-1, unit 1C).
 *
 * Pure and deterministic. For each job it scores every feasible placement by
 * expected merged PRs per token and per minute:
 *
 *   p           = (merged + 1) / (attempts + 2)         learned lane merge rate, Laplace prior
 *   perMTok     = p / tokensPerJob * 1e6                outcome per million tokens
 *   perHour     = p / (minutesPerJob + overhead) * 60   outcome per wall hour
 *   score       = (perMTok / best perMTok)^w * (perHour / best perHour)^(1 - w)
 *
 * Feasibility comes only from measured node capacity: a placement must fit the
 * node's remaining memory headroom (and CPU headroom when known) using the
 * measured footprint of that harness. Cloud harnesses therefore cost a node
 * only their local CLI plus MCP footprint, never a whole-host memory backoff.
 * Node-wide integrity gates (kernel pressure, swap growth) still block a node.
 */
import { isDeepStrictEqual } from 'node:util';
import { HARNESS_ADAPTERS } from './harness-adapters.js';
import { CAPACITY_POLICY, type HarnessFootprint, type NodeCapacityDoc } from './capacity-model.js';

export interface HarnessModelCost {
  provider: string;
  model: string;
  /** Harness adapter id whose local footprint a session costs. */
  harness: string;
  /** Measured median tokens per job for this (provider, model). */
  tokensPerJob: number;
  /** Measured median wall minutes per job. */
  minutesPerJob: number;
  /** Runs on a local model: the node must serve it already, or have room for `modelBytes` to load it. */
  local?: boolean;
  /** Resident bytes of the local model weights (file size of the served quantisation). */
  modelBytes?: number;
}

export interface LaneOutcomes { attempts: number; merged: number }

export interface RouteNode {
  doc: NodeCapacityDoc;
  /** Providers whose CLI is installed and signed in on this node; absent means any. */
  providers?: string[];
  /** Local models currently served on the node. */
  localModels?: string[];
  /** Extra wall minutes to start work there (sync, network); 0 for this host. */
  overheadMinutes?: number;
}

export interface RouteJob {
  id: string;
  /** Restrict providers or models; absent means any. */
  providers?: string[];
  models?: string[];
  /** 0 = only minutes matter, 1 = only tokens matter. Default 0.5. */
  tokenWeight?: number;
}

export interface RouterInput {
  nodes: RouteNode[];
  costs: HarnessModelCost[];
  /** Keyed by provider (lane). */
  outcomes: Record<string, LaneOutcomes>;
  jobs: RouteJob[];
  nowMs: number;
  /** Providers out of included usage; never routed (no spend). */
  exhausted?: string[];
  /** Capacity documents older than this are stale. Default 120 s. */
  maxAgeMs?: number;
}

export interface Placement {
  jobId: string;
  nodeId: string | null;
  provider: string | null;
  model: string | null;
  score: number | null;
  mergeRate: number | null;
  mergesPerMTok: number | null;
  mergesPerHour: number | null;
  footprint: 'node' | 'fleet' | null;
  /** When unplaced: why each node or candidate was rejected (counts).
   * `provider-not-in-job`/`model-not-in-job` count cost rows the job's own
   * provider/model lists excluded before any node was tried (per cost row,
   * like `provider-exhausted`); `no-costs`/`no-nodes` appear with count 1
   * when the inputs held no usable cost rows or node documents at all, so an
   * unplaced job never reports an empty map. */
  rejected?: Record<string, number>;
}

export const ROUTER_DEFAULTS = Object.freeze({ maxAgeMs: 120_000, tokenWeight: 0.5 });

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const MAX_CLOCK_SKEW_MS = 60_000;

/** Select one observation per node, retaining conflicts at the newest plausible timestamp. */
function latestByNode<T>(items: readonly T[], docOf: (item: T) => NodeCapacityDoc, nowMs: number) {
  const latest = new Map<string, { item: T; at: number; conflict: boolean }>();
  for (const item of items) {
    const doc = docOf(item);
    const parsed = Date.parse(doc.measured_at);
    // Keep a placeholder for stale diagnostics, but never let an unusable
    // timestamp displace a plausible observation of the same node.
    const at = finite(parsed) && parsed <= nowMs + MAX_CLOCK_SKEW_MS ? parsed : -Infinity;
    const previous = latest.get(doc.node);
    if (!previous || at > previous.at) {
      latest.set(doc.node, { item, at, conflict: false });
    } else if (finite(at) && at === previous.at && !isDeepStrictEqual(item, previous.item)) {
      previous.conflict = true;
    }
  }
  return [...latest.values()];
}

export function mergeRate(o: LaneOutcomes | undefined): number {
  const attempts = o && Number.isSafeInteger(o.attempts) && o.attempts >= 0 ? o.attempts : 0;
  const merged = o && Number.isSafeInteger(o.merged) && o.merged >= 0 ? Math.min(o.merged, attempts) : 0;
  return (merged + 1) / (attempts + 2);
}

type FootprintCost = Pick<HarnessFootprint, 'mem_bytes_max' | 'cpu_cores_per_session'>;

function footprintExpired(fp: HarnessFootprint | undefined, nowMs: number): boolean {
  if (fp?.source !== 'learned') return false;
  const learnedAt = typeof fp.learned_at === 'string' ? Date.parse(fp.learned_at) : NaN;
  return !finite(learnedAt) || nowMs - learnedAt > CAPACITY_POLICY.learnedFootprintTtlMs;
}

/** Per-resource maxima for each harness, used on nodes that have not run it yet. */
export function fleetFootprints(docs: NodeCapacityDoc[]): Record<string, FootprintCost> {
  const out: Record<string, FootprintCost> = {};
  for (const doc of docs) {
    for (const [id, fp] of Object.entries(doc.per_harness_footprint)) {
      const cur = out[id];
      const previousCpu = cur?.cpu_cores_per_session ?? null;
      const cpu = fp.cpu_cores_per_session;
      out[id] = {
        mem_bytes_max: Math.max(cur?.mem_bytes_max ?? fp.mem_bytes_max, fp.mem_bytes_max),
        cpu_cores_per_session: previousCpu === null ? cpu : cpu === null ? previousCpu : Math.max(previousCpu, cpu),
      };
    }
  }
  return out;
}

interface NodeState {
  node: RouteNode;
  /** Provider/model/harness combinations loaded by earlier placements in this plan. */
  loaded: Set<string>;
  bytes: number;
  cores: number | null;
  /** Allow for binary roundoff relative to the original CPU budget. */
  cpuRoundoff: number;
  blocked: string | null;
}

function capacityHold(doc: NodeCapacityDoc): 'pressure' | 'swap-growth' | null {
  const limits = Object.values(doc.basis?.limiting ?? {});
  const pressure = doc.mem_free.pressure_level;
  if ((finite(pressure) && pressure !== 1) || limits.includes('pressure')) return 'pressure';
  if (doc.swap.growing === true || limits.includes('swap-growth')) return 'swap-growth';
  return null;
}

function hasMeasuredMemory(doc: NodeCapacityDoc): boolean {
  return doc.mem_free.pressure_level === 1 && doc.mem_free.headroom_bytes !== null;
}

function nodeStates(input: RouterInput): NodeState[] {
  const maxAge = input.maxAgeMs ?? ROUTER_DEFAULTS.maxAgeMs;
  return latestByNode(input.nodes, node => node.doc, input.nowMs)
    .sort((a, b) => a.item.doc.node.localeCompare(b.item.doc.node)).map(({ item: node, at, conflict }) => {
      const age = input.nowMs - at;
      const blocked = conflict ? 'capacity-conflict'
        : !finite(age) || age > maxAge ? 'stale'
        : capacityHold(node.doc) ?? (hasMeasuredMemory(node.doc) ? null : 'unmeasured');
      const cores = node.doc.cpu.headroom_cores;
      const footprints = Object.entries(node.doc.per_harness_footprint)
        .filter(([, fp]) => !footprintExpired(fp, input.nowMs));
      const currentNode = { ...node, doc: { ...node.doc, per_harness_footprint: Object.fromEntries(footprints) } };
      return { node: currentNode, loaded: new Set(), bytes: node.doc.mem_free.headroom_bytes ?? 0,
        cores, cpuRoundoff: (cores ?? 0) * Number.EPSILON, blocked };
    });
}

/** Plan every job in order; each placement consumes the node's measured headroom. */
export function planAutoscaleRoutes(input: RouterInput): Placement[] {
  const states = nodeStates(input);
  const fleet = fleetFootprints(states
    .filter(s => s.blocked !== 'stale' && s.blocked !== 'capacity-conflict')
    .map(s => s.node.doc));
  const exhausted = new Set(input.exhausted ?? []);
  const known = new Set(HARNESS_ADAPTERS.map(a => a.id));
  const costs = input.costs.filter(c => known.has(c.harness) && finite(c.tokensPerJob) && c.tokensPerJob > 0 &&
    finite(c.minutesPerJob) && c.minutesPerJob > 0)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const plan: Placement[] = [];
  for (const job of input.jobs) {
    const rejected: Record<string, number> = {};
    const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };
    type Cand = { state: NodeState; cost: HarnessModelCost; fp: FootprintCost; fpSource: 'node' | 'fleet'; load: number; localModelKey: string | null; p: number; perMTok: number; perHour: number };
    const cands: Cand[] = [];
    for (const cost of costs) {
      if (job.providers && !job.providers.includes(cost.provider)) { reject('provider-not-in-job'); continue; }
      if (job.models && !job.models.includes(cost.model)) { reject('model-not-in-job'); continue; }
      if (exhausted.has(cost.provider)) { reject('provider-exhausted'); continue; }
      const localModelKey = cost.local ? JSON.stringify([cost.provider, cost.model, cost.harness]) : null;
      for (const state of states) {
        if (state.blocked) { reject(`node-${state.blocked}`); continue; }
        if (state.node.providers && !state.node.providers.includes(cost.provider)) { reject('provider-not-on-node'); continue; }
        // An unserved local model needs room for its weights; without a size it cannot be placed.
        const load = localModelKey !== null && !state.node.localModels?.includes(cost.model) &&
          !state.loaded.has(localModelKey) ? cost.modelBytes : 0;
        if (!finite(load) || load < 0) { reject('model-not-served'); continue; }
        const own = state.node.doc.per_harness_footprint[cost.harness];
        const borrowed = fleet[cost.harness];
        const memory = own ?? borrowed;
        if (!memory) { reject('footprint-unmeasured'); continue; }
        const fp = {
          mem_bytes_max: memory.mem_bytes_max,
          cpu_cores_per_session: own?.cpu_cores_per_session ?? borrowed?.cpu_cores_per_session ?? null,
        };
        if (fp.mem_bytes_max + load > state.bytes) { reject('memory'); continue; }
        if (state.cores === 0 || (state.cores !== null && fp.cpu_cores_per_session !== null &&
          fp.cpu_cores_per_session - state.cores > state.cpuRoundoff)) { reject('cpu'); continue; }
        const p = mergeRate(input.outcomes[cost.provider]);
        cands.push({ state, cost, fp, fpSource: own ? 'node' : 'fleet', load, localModelKey, p,
          perMTok: p / cost.tokensPerJob * 1e6, perHour: p / (cost.minutesPerJob + Math.max(0, state.node.overheadMinutes ?? 0)) * 60 });
      }
    }
    if (!cands.length) {
      // A job can be unplaceable before any (cost, node) pair is scored: the
      // inputs may hold no usable cost rows or node documents at all. Name
      // that rather than reporting an empty rejection map.
      if (costs.length === 0) reject('no-costs');
      if (states.length === 0) reject('no-nodes');
      plan.push({ jobId: job.id, nodeId: null, provider: null, model: null, score: null, mergeRate: null,
        mergesPerMTok: null, mergesPerHour: null, footprint: null, rejected });
      continue;
    }
    const w = finite(job.tokenWeight) ? Math.max(0, Math.min(1, job.tokenWeight)) : ROUTER_DEFAULTS.tokenWeight;
    const bestTok = Math.max(...cands.map(c => c.perMTok)), bestHour = Math.max(...cands.map(c => c.perHour));
    let best: Cand | null = null, bestScore = -1;
    for (const c of cands) {
      const score = (c.perMTok / bestTok) ** w * (c.perHour / bestHour) ** (1 - w);
      // For equal scores, preserve headroom by avoiding redundant model loads.
      // Equal loads keep the first candidate in (provider, model, node) order.
      if (best === null || score > bestScore + 1e-12 || (score === bestScore && c.load < best.load)) {
        best = c;
        bestScore = score;
      }
    }
    best!.state.bytes -= best!.fp.mem_bytes_max + best!.load;
    if (best!.localModelKey !== null) best!.state.loaded.add(best!.localModelKey);
    if (best!.state.cores !== null && best!.fp.cpu_cores_per_session !== null) {
      const remaining = best!.state.cores - best!.fp.cpu_cores_per_session;
      best!.state.cores = remaining <= best!.state.cpuRoundoff ? 0 : remaining;
    }
    const r = (n: number) => Math.round(n * 1e4) / 1e4;
    plan.push({ jobId: job.id, nodeId: best!.state.node.doc.node, provider: best!.cost.provider, model: best!.cost.model,
      score: r(bestScore), mergeRate: r(best!.p), mergesPerMTok: r(best!.perMTok), mergesPerHour: r(best!.perHour), footprint: best!.fpSource });
  }
  return plan;
}

/**
 * Fleet-wide additional sessions per harness right now: the number a lane
 * controller should use instead of a whole-host memory backoff. Null when no
 * fresh node has a measured answer for that harness.
 */
export function fleetRunnable(docs: NodeCapacityDoc[], nowMs: number, maxAgeMs = ROUTER_DEFAULTS.maxAgeMs): Record<string, number | null> {
  const current = latestByNode(docs, doc => doc, nowMs).filter(({ at, conflict }) => {
    const age = nowMs - at;
    return !conflict && finite(age) && age <= maxAgeMs;
  }).map(({ item: doc }) => ({ doc, stopped: capacityHold(doc) !== null || doc.cpu.headroom_cores === 0 }));
  const out: Record<string, number | null> = {};
  for (const adapter of HARNESS_ADAPTERS) {
    let sum: number | null = null;
    for (const { doc, stopped } of current) {
      if (!stopped && (!hasMeasuredMemory(doc) || footprintExpired(doc.per_harness_footprint[adapter.id], nowMs))) continue;
      const n = doc.agents_runnable_now[adapter.id];
      if (Number.isSafeInteger(n)) sum = (sum ?? 0) + (stopped ? 0 : (n as number));
    }
    out[adapter.id] = sum;
  }
  return out;
}
