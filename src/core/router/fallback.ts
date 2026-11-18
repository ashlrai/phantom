import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { enumerateRouteCandidates, rankRouteCandidates, routeCandidateRejections, type RouteSources } from '../routing/decision-candidates.js';
import { routeFailureKindSchema, routeIdSchema, type RouteCandidate, type RouteRequest } from '../routing/decision-schema.js';

type Failure = (typeof routeFailureKindSchema.options)[number];
type Entry = Pick<RouteCandidate, 'lane' | 'model' | 'effort' | 'mode_tier' | 'speed_tier'> & { on: Failure[]; source: 'pinned' | 'ranked' };
export interface FallbackPlan {
  schema: 'route.fallback.v1'; advisory: true; live: false; primary: string;
  lanes: Entry[]; rejected: { lane: string; reason_codes: string[] }[]; reason_codes: string[];
}

export function planFallbackChain(request: RouteRequest, sources: RouteSources, primaryLane: string, nowMs: number): FallbackPlan {
  const pins = request.fallback;
  const input = { ...request, lane_candidates: [...new Set([...request.lane_candidates, ...(pins?.map(p => p.lane) ?? [])])] };
  const rejected = routeCandidateRejections(input, sources, nowMs, { failover: true, pinned: pins?.map(p => p.lane) });
  const eligible = new Set(rejected.filter(r => !r.reason_codes.length).map(r => r.lane));
  const candidates = enumerateRouteCandidates(input, sources).filter(c => eligible.has(c.lane) && c.lane !== primaryLane);
  const order = pins ? pins.flatMap(p => candidates.filter(c => c.lane === p.lane)) : rankRouteCandidates(input, candidates, nowMs, sources.familyYield);
  const lanes: Entry[] = order.slice(0, 3).map(c => ({ lane: c.lane, model: c.model, effort: c.effort,
    mode_tier: c.mode_tier, speed_tier: c.speed_tier, on: pins?.find(p => p.lane === c.lane)?.on ?? [...routeFailureKindSchema.options], source: pins ? 'pinned' : 'ranked' }));
  return { schema: 'route.fallback.v1', advisory: true, live: false, primary: primaryLane, lanes,
    rejected: rejected.filter(r => r.reason_codes.length > 0),
    reason_codes: [pins ? 'fallback_pinned' : 'fallback_ranked', ...(!lanes.length ? ['fallback_chain_empty'] : []), 'failover_dispatcher_unwired'] };
}

export function nextFailover(plan: FallbackPlan, row: { failed_lane: string; failure: string; attempted: readonly string[] },
  recheck?: { request: RouteRequest; sources: RouteSources; nowMs: number }) {
  const failure = routeFailureKindSchema.safeParse(row.failure);
  if (failure.success) {
    const rejected = recheck ? routeCandidateRejections({ ...recheck.request, lane_candidates: plan.lanes.map(e => e.lane) },
      recheck.sources, recheck.nowMs, { failover: true, pinned: plan.lanes.filter(e => e.source === 'pinned').map(e => e.lane) }) : [];
    const entry = plan.lanes.find(e => e.lane !== plan.primary && e.lane !== row.failed_lane && !row.attempted.includes(e.lane) &&
      e.on.includes(failure.data) && !rejected.some(r => r.lane === e.lane && r.reason_codes.length));
    if (entry) return { lane: entry.lane, entry, reason_code: `failover_${failure.data}` as const };
  }
  return { lane: null, reason_codes: ['fallback_chain_exhausted', ...(!failure.success ? ['failure_unknown'] : [])] };
}

export async function recordFailover(root: string, row: { job: string; failed_lane: string; failure: string; lane: string | null }, nowMs: number) {
  routeIdSchema.parse(row.job); routeIdSchema.parse(row.failed_lane);
  routeFailureKindSchema.parse(row.failure);
  if (row.lane !== null) routeIdSchema.parse(row.lane);
  const event = { event: row.lane === null ? 'failover_refused' : 'failover', ts: nowMs / 1000, job: row.job,
    lane: row.lane, lane_hint: row.failed_lane, failure: row.failure,
    ...(row.lane === null ? { reason_code: 'fallback_chain_exhausted' } : { lane_override: `failover_${row.failure}` }) };
  await mkdir(join(root, 'metrics'), { recursive: true });
  const fd = await open(join(root, 'metrics/jobs.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!(await fd.stat()).isFile()) throw new Error('Invalid job ledger');
    await fd.writeFile(JSON.stringify(event, Object.keys(event).sort()) + '\n');
  } finally { await fd.close(); }
}

export async function readFallbackUsed(root: string, job: string): Promise<Record<string, unknown>[] | null> {
  if (!routeIdSchema.safeParse(job).success) return null;
  try {
    const fd = await open(join(root, 'metrics/jobs.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let tail: string;
    try {
      const stat = await fd.stat();
      if (!stat.isFile()) return null;
      const start = Math.max(0, stat.size - 256 * 1024), bytes = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      const { bytesRead } = await fd.read(bytes, 0, bytes.length, start);
      tail = bytes.subarray(0, bytesRead).toString('utf8');
      if (start) tail = tail.slice(tail.indexOf('\n') + 1);
    } finally { await fd.close(); }
    const rows: Record<string, unknown>[] = [];
    for (const line of tail.split('\n')) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row && row.job === job && ['failover', 'failover_refused'].includes(String(row.event))) {
          rows.push(row); if (rows.length > 3) rows.shift();
        }
      } catch { /* Partial rows are not evidence. */ }
    }
    return rows.length ? rows : null;
  } catch { return null; }
}

export async function runFailover(request: RouteRequest, sources: RouteSources,
  row: { failed_lane: string; failure: string; attempted: readonly string[] }, options: { root: string; record: boolean; nowMs: number }) {
  if (options.record && !request.job) throw new Error('Recording requires job');
  const plan = planFallbackChain(request, sources, row.failed_lane, options.nowMs);
  const result = nextFailover(plan, row, { request, sources, nowMs: options.nowMs });
  if (options.record) await recordFailover(options.root, { job: request.job!, ...row, lane: result.lane }, options.nowMs);
  return { ...result, plan };
}
