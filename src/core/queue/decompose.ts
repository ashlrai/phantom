/**
 * RQ-SWE5-AGENT-SWARM — bounded agent self-decomposition into the fleet queue.
 *
 * A running worker may split its own job into child proposals submitted as a
 * `spawn.v1` document (`phm queue spawn <file>`, or the loopback ingest in
 * ingest.ts). Children land as PROPOSED — a proposal, never dispatch
 * authority: promotion to READY, scheduling and publication stay with the
 * operator and the repo's existing gates.
 *
 * Safety properties, all enforced fail-closed in planSpawn:
 *   - validated schema: strict spawn.v1 keys, bounded counts/lengths, no
 *     control characters, and no secret-shaped text (a string that
 *     scrubSecrets would alter is refused, never echoed);
 *   - owner binding: the parent must be CLAIMED or PR-OPEN under an active
 *     claim held by `owner` — one worker cannot decompose another's job;
 *   - dedup: a proposed id already present in the queue (any status,
 *     including DONE/RETIRED) or in the merged-outcome ledger is skipped as
 *     a duplicate, so replayed proposals never multiply work;
 *   - rate limits: a bounded journal caps proposals per parent per window,
 *     and the parent's total children are capped outright;
 *   - depth cap: decomposition cannot recurse past SPAWN_LIMITS.maxDepth;
 *   - no credential or lane escalation: children inherit the parent's pool
 *     and repo, may only take an equal-or-lower tier and equal-or-lower
 *     urgency priority, and must pass the standing pool-routing policy.
 *
 * PURE: planSpawn performs no I/O and no clock reads; the store supplies
 * journal counts and merged-ledger ids.
 */
import { createHash } from 'node:crypto';
import { isQueueTier, queueTierProblem, type QueueTier } from '../drive/queue-tier.js';
import { drivePoolAllowed } from '../drive/pool-routing.js';
import { scrubSecrets } from '../util/scrub-secrets.js';
import type { QueueDocument, QueueJob } from './schema.js';

export const SPAWN_SCHEMA = 'spawn.v1';

/** Capability order for escalation checks: fast < work < mid < frontier. */
const TIER_RANK: Readonly<Record<QueueTier, number>> = Object.freeze({ fast: 0, work: 1, mid: 2, frontier: 3 });

export const SPAWN_LIMITS = Object.freeze({
  /** Children in one proposal. */
  jobsPerProposal: 8,
  /** Total children one parent may ever accrue. */
  childrenPerParent: 8,
  /** Accepted proposals one parent may consume inside the rate window. */
  proposalsPerWindow: 4,
  /** Rate-limit window: one day. */
  windowMs: 24 * 60 * 60 * 1000,
  /** Children may spawn grandchildren (depth 2) but no further. */
  maxDepth: 2,
  scopeChars: 4_000,
  acceptanceChars: 2_000,
  idChars: 128,
  depsPerJob: 8,
  /** Bounded proposal journal kept beside queue.v1.json. */
  journalEntries: 4_096,
} as const);

export interface SpawnJobInput {
  /** Explicit child id (RQ-*); content-derived when omitted. */
  id?: string;
  scope: string;
  acceptance: string;
  /** Existing queue ids or sibling ids from this proposal. Never a self-dep. */
  deps?: string[];
  /** Equal-or-lower capability tier than the parent's; inherits when omitted. */
  tier?: string;
  /** Equal-or-lower urgency (`P0`–`P9`, digit ≥ the parent's); inherits when omitted. */
  priority?: string;
}

export interface SpawnDocument {
  schema: 'spawn.v1';
  /** Existing queue.v1 job being decomposed. */
  parent: string;
  /** Holder of the parent's active claim. */
  owner: string;
  jobs: SpawnJobInput[];
}

export interface SpawnResult {
  schema: 'spawn-result.v1';
  parent: string;
  applied: string[];
  /** Proposed ids already in the queue or the merged ledger — skipped, never errors. */
  duplicates: string[];
}

export type SpawnRejectCode =
  | 'invalid-document' | 'unknown-parent' | 'parent-not-active' | 'owner-mismatch'
  | 'depth-cap' | 'children-cap' | 'rate-limited'
  | 'tier-escalation' | 'priority-escalation' | 'pool-routing'
  | 'unknown-dep';

/**
 * Rejection whose message names fields and rule codes only — never scope,
 * acceptance or dep values — so it is safe to surface through the ingest API.
 */
export class SpawnRejection extends Error {
  constructor(readonly code: SpawnRejectCode, message: string) {
    super(message);
    this.name = 'SpawnRejection';
  }
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHILD_ID = /^RQ-[A-Za-z0-9][A-Za-z0-9._-]{0,124}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRIORITY = /^P([0-9])$/;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(field: string, why: string): never {
  throw new SpawnRejection('invalid-document', `${field}: ${why}`);
}

/** Prompt-data text: bounded, printable, and free of secret-shaped material. */
function promptText(field: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(field, 'required');
  if (value.length > max) invalid(field, `exceeds ${max} characters`);
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 127 || (code < 32 && ![9, 10, 13].includes(code))) invalid(field, 'control characters');
  }
  if (scrubSecrets(value) !== value) invalid(field, 'secret-shaped material');
  return value;
}

/** Strict-key, bounded parse of a spawn.v1 document; throws SpawnRejection. */
export function parseSpawn(value: unknown): SpawnDocument {
  if (!record(value)) invalid('document', 'expected an object');
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'jobs,owner,parent,schema') invalid('document', 'unexpected or missing fields');
  if (value['schema'] !== SPAWN_SCHEMA) invalid('schema', 'must be spawn.v1');
  const parent = value['parent'];
  if (typeof parent !== 'string' || !JOB_ID.test(parent)) invalid('parent', 'must be a queue job id');
  const owner = value['owner'];
  if (typeof owner !== 'string' || !LABEL.test(owner)) invalid('owner', 'must be a printable label');
  const list = value['jobs'];
  if (!Array.isArray(list) || list.length === 0 || list.length > SPAWN_LIMITS.jobsPerProposal) {
    invalid('jobs', `must be 1-${SPAWN_LIMITS.jobsPerProposal} entries`);
  }
  const jobs: SpawnJobInput[] = [];
  for (const [index, row] of list.entries()) {
    const field = (name: string): string => `jobs[${index}].${name}`;
    if (!record(row)) invalid(`jobs[${index}]`, 'expected an object');
    const allowed = new Set(['acceptance', 'deps', 'id', 'priority', 'scope', 'tier']);
    for (const key of Object.keys(row)) if (!allowed.has(key)) invalid(`jobs[${index}]`, `unexpected field ${key.slice(0, 32)}`);
    const input: SpawnJobInput = {
      scope: promptText(field('scope'), row['scope'], SPAWN_LIMITS.scopeChars),
      acceptance: promptText(field('acceptance'), row['acceptance'], SPAWN_LIMITS.acceptanceChars),
    };
    if (row['id'] !== undefined) {
      if (typeof row['id'] !== 'string' || !CHILD_ID.test(row['id'])) invalid(field('id'), 'must be an RQ- job id');
      input.id = row['id'];
    }
    if (row['deps'] !== undefined) {
      const deps = row['deps'];
      if (!Array.isArray(deps) || deps.length > SPAWN_LIMITS.depsPerJob ||
          deps.some(d => typeof d !== 'string' || !JOB_ID.test(d)) || new Set(deps).size !== deps.length ||
          (typeof input.id === 'string' && (deps as string[]).includes(input.id))) {
        invalid(field('deps'), `must be ${SPAWN_LIMITS.depsPerJob} or fewer unique job ids, never self`);
      }
      input.deps = deps as string[];
    }
    if (row['tier'] !== undefined) {
      if (typeof row['tier'] !== 'string' || queueTierProblem(row['tier']) !== null) {
        invalid(field('tier'), 'must be a queue tier (frontier, work, mid, fast)');
      }
      input.tier = row['tier'];
    }
    if (row['priority'] !== undefined) {
      if (typeof row['priority'] !== 'string' || !PRIORITY.test(row['priority'])) invalid(field('priority'), 'must be P0-P9');
      input.priority = row['priority'];
    }
    jobs.push(input);
  }
  return { schema: SPAWN_SCHEMA, parent, owner, jobs };
}

/** Deterministic child id: replays of identical scope dedup at the store. */
function derivedId(parent: string, input: SpawnJobInput): string {
  return `RQ-SUB-${createHash('sha256').update(`${parent} ${input.scope} ${input.acceptance}`).digest('hex').slice(0, 24)}`;
}

/**
 * Ancestor chain length, floored at the recorded depth. A cycle or a missing
 * ancestor stops the walk; the chain length still bounds the emitted depth.
 */
function effectiveDepth(job: QueueJob, byId: ReadonlyMap<string, QueueJob>): number {
  let hops = 0;
  let node: QueueJob | undefined = job;
  const seen = new Set([job.id]);
  while (node?.parent !== undefined && hops <= SPAWN_LIMITS.maxDepth) {
    node = byId.get(node.parent);
    if (node === undefined || seen.has(node.id)) break;
    seen.add(node.id);
    hops++;
  }
  return Math.max(job.depth ?? 0, hops);
}

export interface SpawnEvidence {
  /** Proposals this parent already consumed inside the rate window. */
  proposalsInWindow?: number;
  /** MERGED-outcome job ids from the metrics ledger — dedup vs landed work. */
  mergedIds?: ReadonlySet<string>;
}

export interface SpawnPlan {
  parent: string;
  /** PROPOSED jobs to append, in proposal order. */
  jobs: QueueJob[];
  duplicates: string[];
}

/**
 * Validate a parsed spawn.v1 proposal against the queue document. Throws
 * SpawnRejection on any policy violation; id collisions with in-flight or
 * merged work are collected as duplicates instead. Child policy violations
 * fail the whole proposal — intake is atomic.
 */
export function planSpawn(doc: QueueDocument, proposal: SpawnDocument, evidence: SpawnEvidence = {}): SpawnPlan {
  const byId = new Map(doc.jobs.map(job => [job.id, job]));
  const parent = byId.get(proposal.parent);
  if (parent === undefined) throw new SpawnRejection('unknown-parent', 'parent is not a queue job');
  const claim = parent.claims.at(-1);
  if ((parent.status !== 'CLAIMED' && parent.status !== 'PR-OPEN') || claim === undefined || claim.finishedAt !== undefined) {
    throw new SpawnRejection('parent-not-active', 'parent must be CLAIMED or PR-OPEN under an active claim');
  }
  if (claim.owner !== proposal.owner) throw new SpawnRejection('owner-mismatch', 'owner must hold the parent active claim');
  const depth = effectiveDepth(parent, byId);
  if (depth >= SPAWN_LIMITS.maxDepth) throw new SpawnRejection('depth-cap', `parent is at the decomposition depth cap (${SPAWN_LIMITS.maxDepth})`);
  const existingChildren = doc.jobs.filter(job => job.parent === parent.id).length;
  if (existingChildren >= SPAWN_LIMITS.childrenPerParent) {
    throw new SpawnRejection('children-cap', `parent already has ${SPAWN_LIMITS.childrenPerParent} children`);
  }
  if ((evidence.proposalsInWindow ?? 0) >= SPAWN_LIMITS.proposalsPerWindow) {
    throw new SpawnRejection('rate-limited', 'parent proposal rate limit reached; retry outside the window');
  }

  // First pass: resolve ids and drop work already known to the fleet.
  const taken = new Set<string>(byId.keys());
  for (const id of evidence.mergedIds ?? []) taken.add(id);
  const resolved: { input: SpawnJobInput; id: string }[] = [];
  const duplicates: string[] = [];
  const siblings = new Set<string>();
  for (const input of proposal.jobs) {
    const id = input.id ?? derivedId(parent.id, input);
    if (taken.has(id) || siblings.has(id)) { duplicates.push(id); continue; }
    siblings.add(id);
    resolved.push({ input, id });
  }
  if (existingChildren + resolved.length > SPAWN_LIMITS.childrenPerParent) {
    throw new SpawnRejection('children-cap', `proposal exceeds the per-parent children cap (${SPAWN_LIMITS.childrenPerParent})`);
  }

  // Second pass: routing and dependency policy for every surviving child.
  const parentPriority = PRIORITY.exec(parent.priority);
  const jobs: QueueJob[] = [];
  for (const { input, id } of resolved) {
    for (const dep of input.deps ?? []) {
      if (dep === id || (!byId.has(dep) && !siblings.has(dep))) {
        throw new SpawnRejection('unknown-dep', `jobs dependency is not in the queue or this proposal: ${id}`);
      }
    }
    const pool = parent.pool;   // inherited — a child may never hop lanes
    const repo = parent.repo;   // inherited — a child may never hop repos
    const tier = input.tier ?? parent.tier;
    if (isQueueTier(parent.tier)) {
      if (!isQueueTier(tier)) throw new SpawnRejection('tier-escalation', `child tier must be a queue tier: ${id}`);
      if (TIER_RANK[tier] > TIER_RANK[parent.tier]) {
        throw new SpawnRejection('tier-escalation', `child tier exceeds the parent tier ${parent.tier}: ${id}`);
      }
    } else if (tier !== parent.tier) {
      throw new SpawnRejection('tier-escalation', `child tier must stay ${parent.tier} like its parent: ${id}`);
    }
    const priority = input.priority ?? parent.priority;
    if (parentPriority !== null) {
      if (Number(priority[1]) < Number(parentPriority[1])) {
        throw new SpawnRejection('priority-escalation', `child priority must not exceed the parent's: ${id}`);
      }
    } else if (priority !== parent.priority) {
      throw new SpawnRejection('priority-escalation', `child priority must stay ${parent.priority} like its parent: ${id}`);
    }
    if (!drivePoolAllowed(id, pool)) throw new SpawnRejection('pool-routing', `job id kind may not run in the parent pool: ${id}`);
    jobs.push({ id, status: 'PROPOSED', priority, pool, tier, repo, deps: input.deps ?? [],
      scope: input.scope, acceptance: input.acceptance, claims: [], parent: parent.id, depth: depth + 1 });
  }
  return { parent: parent.id, jobs, duplicates };
}
