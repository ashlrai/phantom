import { attributeMergeWait, recutRequest, type MergeRecutRequest, type MergeWaitCause } from '../merge-eta.js';

export const QUEUE_LATENCY_SCHEMA = 'fleet.queue-latency.v1';
/** After this many recut requests for one PR, a person should look at it. */
export const MAX_QUEUE_RECUTS = 3;

/** Where a PR entered a step on its way to merging. Each step lasts until the next one starts. */
export type QueueStage = 'opened' | 'approved' | 'queued' | 'checks_started';
export const QUEUE_STAGES: readonly QueueStage[] = ['opened', 'approved', 'queued', 'checks_started'];
export const QUEUE_STAGE_LABELS: Record<QueueStage, string> = {
  opened: 'waiting for approval', approved: 'waiting to join the queue',
  queued: 'waiting in the queue', checks_started: 'running required checks',
};

export interface QueueLatencyPr {
  repo: string;
  number: number;
  /** When the PR entered each step; order in the file does not matter. */
  stages: { stage: QueueStage; at: string }[];
  headSha?: string;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /** 1 is the front of the merge queue. */
  queuePosition?: number;
  recutRequests?: number;
  lastRecutHead?: string;
}
export interface QueueLatencyInput { prs: QueueLatencyPr[] }

export interface StageDelay { stage: QueueStage; label: string; count: number; median_s: number | null; max_s: number | null }
export interface QueueLatencyRow {
  repo: string; number: number; stage: QueueStage; waiting_s: number; wait_cause: MergeWaitCause | null;
  /** The step this PR has spent the longest in, finished or ongoing. */
  slowest_stage: QueueStage;
}
export type QueueLatencyAdvice =
  | { action: 'recut'; repo: string; number: number; waiting_s: number; recut: MergeRecutRequest; say: string }
  | { action: 'needs_person'; repo: string; number: number; waiting_s: number; reason: 'no-head' | 'already-requested' | 'too-many-recuts'; say: string };

export interface QueueLatencyReport {
  schema: typeof QUEUE_LATENCY_SCHEMA;
  readOnly: true;
  requiredChecksPreserved: true;
  observedAt: string;
  stages: StageDelay[];
  slowest_stage: QueueStage | null;
  prs: QueueLatencyRow[];
  advice: QueueLatencyAdvice[];
}

const isCount = (n: unknown) => Number.isSafeInteger(n) && (n as number) > 0;
const isTime = (s: unknown) => typeof s === 'string' && Number.isFinite(Date.parse(s));

export function validQueueLatencyInput(value: unknown): value is QueueLatencyInput {
  if (!value || typeof value !== 'object' || !Array.isArray((value as QueueLatencyInput).prs)) return false;
  const seen = new Set<string>();
  return (value as QueueLatencyInput).prs.every(pr => {
    if (!pr || typeof pr !== 'object' || typeof pr.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(pr.repo) || !isCount(pr.number)) return false;
    const id = `${pr.repo.toLowerCase()}#${pr.number}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return Array.isArray(pr.stages) && pr.stages.length > 0
      && pr.stages.every(s => s && QUEUE_STAGES.includes(s.stage) && isTime(s.at))
      && (pr.headSha === undefined || typeof pr.headSha === 'string')
      && (pr.mergeable === undefined || ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'].includes(pr.mergeable))
      && (pr.queuePosition === undefined || isCount(pr.queuePosition))
      && (pr.recutRequests === undefined || (Number.isSafeInteger(pr.recutRequests) && pr.recutRequests >= 0))
      && (pr.lastRecutHead === undefined || typeof pr.lastRecutHead === 'string');
  });
}

/** Nearest-rank median of an ascending list. */
const median = (sorted: number[]) => sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)]!;

/**
 * Read-only: where queued PRs spend their time, and which conflicts the recut
 * loop can retry. Nothing here merges, requeues or skips a required check.
 */
export function queueLatency(input: QueueLatencyInput, now = Date.now()): QueueLatencyReport {
  if (!Number.isFinite(now)) throw new Error('Invalid observation time');
  const spent = new Map<QueueStage, number[]>(QUEUE_STAGES.map(stage => [stage, []]));
  const prs: QueueLatencyRow[] = [];
  const advice: QueueLatencyAdvice[] = [];
  for (const pr of input.prs) {
    // Steps that start after the observation time have not happened yet.
    const steps = pr.stages.map(s => ({ stage: s.stage, at: Date.parse(s.at) }))
      .filter(s => s.at <= now).sort((a, b) => a.at - b.at);
    if (!steps.length) continue;
    const durations = steps.map((s, i) => ({ stage: s.stage, seconds: Math.round(((steps[i + 1]?.at ?? now) - s.at) / 1000) }));
    for (const d of durations.slice(0, -1)) spent.get(d.stage)!.push(d.seconds);
    const current = durations[durations.length - 1]!;
    const conflicting = pr.mergeable === 'CONFLICTING';
    const slowest = durations.reduce((a, b) => b.seconds > a.seconds ? b : a);
    prs.push({ repo: pr.repo, number: pr.number, stage: current.stage, waiting_s: current.seconds,
      wait_cause: current.stage === 'opened' || current.stage === 'approved' ? (conflicting ? 'conflict' : null)
        : attributeMergeWait(conflicting, pr.queuePosition ?? null),
      slowest_stage: slowest.stage });
    if (!conflicting) continue;
    const base = { repo: pr.repo, number: pr.number, waiting_s: current.seconds };
    const request = recutRequest(pr.repo, pr.number, pr.headSha ?? null);
    if (!request) advice.push({ ...base, action: 'needs_person', reason: 'no-head', say: `#${pr.number} conflicts but its head commit is unknown; a person should look.` });
    else if ((pr.recutRequests ?? 0) >= MAX_QUEUE_RECUTS) advice.push({ ...base, action: 'needs_person', reason: 'too-many-recuts', say: `#${pr.number} still conflicts after ${pr.recutRequests} recuts; a person should look.` });
    else if (pr.lastRecutHead && pr.lastRecutHead.length >= 7 && request.headSha.startsWith(pr.lastRecutHead.toLowerCase().slice(0, 40))) {
      advice.push({ ...base, action: 'needs_person', reason: 'already-requested', say: `#${pr.number} already has a recut for this commit; wait for it.` });
    } else advice.push({ ...base, action: 'recut', recut: request, say: `Recut #${pr.number} automatically (${request.key}); required checks run again on the new head.` });
  }
  const stages = QUEUE_STAGES.map<StageDelay>(stage => {
    const values = spent.get(stage)!.sort((a, b) => a - b);
    return { stage, label: QUEUE_STAGE_LABELS[stage], count: values.length,
      median_s: values.length ? median(values) : null, max_s: values.length ? values[values.length - 1]! : null };
  });
  const measured = stages.filter(s => s.median_s !== null);
  const slowest = measured.reduce<StageDelay | null>((a, b) => !a || b.median_s! > a.median_s! ? b : a, null);
  const byWait = (a: { waiting_s: number; repo: string; number: number }, b: typeof a) =>
    b.waiting_s - a.waiting_s || a.repo.localeCompare(b.repo) || a.number - b.number;
  return { schema: QUEUE_LATENCY_SCHEMA, readOnly: true, requiredChecksPreserved: true,
    observedAt: new Date(now).toISOString(), stages, slowest_stage: slowest?.stage ?? null,
    prs: prs.sort(byWait), advice: advice.sort(byWait) };
}

/** Plain-words report for people. */
export function formatQueueLatency(r: QueueLatencyReport): string {
  if (!r.prs.length) return 'No PRs in the merge path.';
  const secs = (v: number | null) => v === null ? 'unknown' : `${v}s`;
  return [
    ...r.stages.map(s => `${s.label}: median ${secs(s.median_s)}, slowest ${secs(s.max_s)} (${s.count} finished)`),
    r.slowest_stage ? `Slowest step: ${QUEUE_STAGE_LABELS[r.slowest_stage]}.` : 'Slowest step: unknown (no finished steps yet).',
    ...r.prs.map(p => `${p.repo}#${p.number}: ${QUEUE_STAGE_LABELS[p.stage]} for ${p.waiting_s}s${p.wait_cause ? ` (${p.wait_cause})` : ''}`),
    ...(r.advice.length ? r.advice.map(a => a.say) : ['No conflicts to recut.']),
  ].join('\n');
}
