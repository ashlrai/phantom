/** Deterministic advice only. The snapshot supplies all evidence and the clock. */
import { z } from 'zod';

export const CHIEF_OF_STAFF_SCHEMA = 'fleet.chief-of-staff.v1';
export const CHIEF_OF_STAFF_LIMITS = Object.freeze({ lanes: 64, jobs: 200, outcomes: 1000, brief: 12_000 });
const id = z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const time = z.string().max(40).pipe(z.string().datetime({ offset: true }));
const count = z.number().int().min(0).max(1_000_000);
const rate = z.number().min(0).max(1).nullable();
const snapshotSchema = z.object({
  at: time,
  lanes: z.array(z.object({
    lane: id.max(40), held: z.boolean().nullable(), target: count.nullable(), ceiling: count.nullable(),
    queueDepth: count.nullable(), running: count.nullable(), errorRate: rate, emptyRate: rate,
    openPrConflicts: count.nullable(),
    quota: z.object({ remainingFraction: z.number().min(0).max(1), resetAt: time }).nullable(),
  })),
  jobs: z.array(z.object({
    id, lane: id, status: z.enum(['ready', 'running', 'parked']), priority: z.number().int().min(0).max(100),
    queuedAt: time.nullable(), startedAt: time.nullable(),
  })),
  outcomes: z.array(z.object({ job: id, lane: id, at: time,
    phase: z.enum(['finish', 'publish']), result: z.enum(['success', 'failed', 'empty']), empty: z.boolean().optional() })),
});
export type FleetSnapshot = z.infer<typeof snapshotSchema>;
type Reason = 'lane-held' | 'hold-unknown' | 'lane-disabled' | 'quota-unknown' | 'quota-exhausted'
  | 'evidence-incomplete' | 'repair-lane' | 'resolve-conflicts' | 'replenish-queue' | 'use-reset-window' | 'balanced';
export interface ChiefOfStaffPlan {
  schema: typeof CHIEF_OF_STAFF_SCHEMA;
  at: string;
  authority: { mode: 'recommend-only'; allowed: readonly ['reorder', 'inject', 'retire', 'brief'];
    merge: false; credentials: false; bypassLaneHolds: false };
  ordering: Array<{ job: string; lane: string; score: number; rationale: string }>;
  laneTargets: Array<{ lane: string; current: number | null; recommended: number | null; reason: Reason }>;
  inject: Array<{ job: string; lane: string; purpose: 'repair-lane' | 'resolve-conflicts' | 'replenish-queue' }>;
  retire: Array<{ job: string; lane: string; reason: 'already-published' }>;
  stuck: Array<{ job: string; lane: string; reason: 'queue-wait' | 'run-overdue' | 'proof-missing'; ageMinutes: number }>;
  evidence: { recentFinishes: number; recentPublishes: number; unknownLanes: number };
  brief: { format: 'markdown'; text: string };
}

/** Reject oversize arrays before schema traversal; errors never contain input values. */
export function parseFleetSnapshot(value: unknown): FleetSnapshot {
  const raw = value as Record<string, unknown> | null;
  for (const key of ['lanes', 'jobs', 'outcomes'] as const) {
    if (!raw || !Array.isArray(raw[key]) || raw[key].length > CHIEF_OF_STAFF_LIMITS[key]) throw new Error('Invalid fleet snapshot');
  }
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid fleet snapshot');
  const s = parsed.data;
  const lanes = new Set(s.lanes.map(l => l.lane));
  if (lanes.size !== s.lanes.length || new Set(s.jobs.map(j => j.id)).size !== s.jobs.length
    || s.jobs.some(j => !lanes.has(j.lane))) throw new Error('Invalid fleet snapshot');
  return s;
}

export function planChiefOfStaff(snapshot: FleetSnapshot): ChiefOfStaffPlan {
  const s = parseFleetSnapshot(snapshot);
  const now = Date.parse(s.at), hour = 3_600_000;
  const recent = s.outcomes.filter(o => Date.parse(o.at) <= now && Date.parse(o.at) >= now - 24 * hour);
  const unique = [...new Map(recent.map(o => [JSON.stringify(o), o])).values()];
  const plan: ChiefOfStaffPlan = {
    schema: CHIEF_OF_STAFF_SCHEMA, at: new Date(now).toISOString(),
    authority: { mode: 'recommend-only', allowed: ['reorder', 'inject', 'retire', 'brief'], merge: false, credentials: false, bypassLaneHolds: false },
    ordering: [], laneTargets: [], inject: [], retire: [], stuck: [],
    evidence: { recentFinishes: unique.filter(o => o.phase === 'finish').length,
      recentPublishes: unique.filter(o => o.phase === 'publish').length, unknownLanes: 0 },
    brief: { format: 'markdown', text: '' },
  };
  const ids = new Set(s.jobs.map(j => j.id));
  for (const lane of [...s.lanes].sort((a, b) => a.lane < b.lane ? -1 : 1)) {
    const quota = lane.quota && Date.parse(lane.quota.resetAt) > now ? lane.quota : null;
    const blocked: Reason | null = lane.held === true ? 'lane-held' : lane.held === null ? 'hold-unknown'
      : lane.target === 0 ? 'lane-disabled' : !quota ? 'quota-unknown'
      : quota.remainingFraction === 0 ? 'quota-exhausted' : null;
    const incomplete = [lane.target, lane.ceiling, lane.running, lane.queueDepth, lane.errorRate, lane.emptyRate, lane.openPrConflicts].includes(null);
    if (incomplete || lane.held === null || !quota) plan.evidence.unknownLanes++;
    const poor = (lane.errorRate ?? 0) >= 0.25 || (lane.emptyRate ?? 0) >= 0.5;
    const resetSoon = quota !== null && Date.parse(quota.resetAt) - now <= hour;
    let reason: Reason = blocked ?? (poor ? 'repair-lane' : (lane.openPrConflicts ?? 0) > 0 ? 'resolve-conflicts'
      : incomplete ? 'evidence-incomplete' : resetSoon ? 'use-reset-window' : 'balanced');
    let recommended = lane.target;
    if (blocked) recommended = blocked === 'lane-held' || blocked === 'lane-disabled' || blocked === 'quota-exhausted' ? 0 : null;
    else if (incomplete) recommended = poor && lane.target !== null ? Math.ceil(lane.target / 2) : lane.target;
    else {
      const target = lane.target!;
      const demand = lane.running! + lane.queueDepth!;
      recommended = Math.min(lane.ceiling!, demand, poor ? Math.ceil(target / 2)
        : lane.openPrConflicts! > 0 ? target : target + (resetSoon && quota!.remainingFraction > 0.25 && demand > target ? 1 : 0));
      if (lane.queueDepth === 0 && !poor && lane.openPrConflicts === 0) reason = 'replenish-queue';
    }
    if (recommended !== null && lane.ceiling !== null) recommended = Math.min(recommended, lane.ceiling);
    plan.laneTargets.push({ lane: lane.lane, current: lane.target, recommended, reason });
    if (!blocked && ['repair-lane', 'resolve-conflicts', 'replenish-queue'].includes(reason)) {
      const purpose = reason as ChiefOfStaffPlan['inject'][number]['purpose'];
      const job = `COS-${purpose}-${lane.lane}`;
      if (!ids.has(job) && !unique.some(o => o.job === job && o.lane === lane.lane)) plan.inject.push({ job, lane: lane.lane, purpose });
    }
    for (const job of s.jobs.filter(j => j.lane === lane.lane && j.status !== 'parked')) {
      const start = job.status === 'running' ? job.startedAt : job.queuedAt;
      const age = start === null || Date.parse(start) > now ? null : now - Date.parse(start);
      // A reused job id needs time evidence tying publication to this queue entry.
      const since = job.queuedAt === null ? null : Math.max(Date.parse(job.queuedAt), job.startedAt === null ? 0 : Date.parse(job.startedAt));
      const events = since === null ? [] : unique.filter(o => o.job === job.id && o.lane === job.lane && Date.parse(o.at) >= since);
      const publications = events.filter(o => o.phase === 'publish');
      const latest = Math.max(...publications.map(o => Date.parse(o.at)));
      const published = publications.length > 0 && publications.filter(o => Date.parse(o.at) === latest).every(o => o.result === 'success');
      if (blocked) continue;
      if (published && job.status === 'ready') { plan.retire.push({ job: job.id, lane: job.lane, reason: 'already-published' }); continue; }
      if (age !== null && age >= (job.status === 'running' ? 2 : 6) * hour) {
        plan.stuck.push({ job: job.id, lane: job.lane, reason: job.status === 'running' ? 'run-overdue' : 'queue-wait', ageMinutes: Math.floor(age / 60_000) });
      }
      const finish = events.filter(o => o.phase === 'finish').sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      if (!published && finish?.result === 'success' && now - Date.parse(finish.at) >= hour) plan.stuck.push({ job: job.id, lane: job.lane, reason: 'proof-missing', ageMinutes: Math.floor((now - Date.parse(finish.at)) / 60_000) });
      if (job.status === 'ready') {
        const ageBoost = Math.min(24, Math.floor((age ?? 0) / hour));
        const resetBoost = resetSoon ? 20 : 0;
        const penalty = (poor ? 50 : 0) + Math.min(50, (lane.openPrConflicts ?? 0) * 10);
        plan.ordering.push({ job: job.id, lane: job.lane, score: job.priority * 10 + ageBoost + resetBoost - penalty,
          rationale: `Priority ${job.priority}; age +${ageBoost}; reset +${resetBoost}; health/conflict -${penalty}.` });
      }
    }
  }
  // Stable ties preserve the captured queue order, including across lanes.
  const position = new Map(s.jobs.map((j, i) => [j.id, i]));
  plan.ordering.sort((a, b) => b.score - a.score || position.get(a.job)! - position.get(b.job)!);
  const lines = ['# Fleet chief of staff', '', `As of ${plan.at}. Recommendations only; holds remain binding.`,
    `Evidence (24h): ${plan.evidence.recentFinishes} finishes, ${plan.evidence.recentPublishes} publication events; ${plan.evidence.unknownLanes} lanes have incomplete evidence.`,
    '', '## Lane targets', ...plan.laneTargets.map(l => `- ${l.lane}: ${l.current ?? 'unknown'} → ${l.recommended ?? 'unknown'} (${l.reason}).`),
    '', '## Next work', ...plan.ordering.slice(0, 10).map(j => `- ${j.job} (${j.lane}): ${j.rationale}`),
    '', '## Queue recommendations', ...plan.inject.slice(0, 10).map(j => `- Inject ${j.job}: ${j.purpose}.`),
    ...plan.retire.slice(0, 10).map(j => `- Retire ${j.job}: ${j.reason}.`),
    '', '## Needs attention', ...plan.stuck.slice(0, 10).map(j => `- ${j.job}: ${j.reason} (${j.ageMinutes} minutes).`),
    '', 'Lists show at most 10 entries each; JSON contains the complete bounded plan. No work was dispatched or sent.'];
  plan.brief.text = lines.join('\n').slice(0, CHIEF_OF_STAFF_LIMITS.brief);
  return plan;
}
