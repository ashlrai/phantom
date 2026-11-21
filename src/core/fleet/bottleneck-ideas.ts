/**
 * The Ideas loop engine: rank what the fleet should fix next from signals
 * Phantom already keeps locally. Five signals, each read through its existing
 * parser; a signal that cannot be read is reported as `unknown` with a reason
 * and contributes no ideas, so nothing is ever invented from a missing file.
 *
 *   empty launches per job family  metrics/jobs.jsonl (launch + empty outcome rows)
 *   repeated main-guardian fixups  supervisor/status-main-guardian.md (+ ledger)
 *   disk free trend                queue/disk-growth-history.json (diskForecast)
 *   lanes with queued work idle    queue/status.json (parseIdleLanes)
 *   unspent subscription usage     queue/usage-readings.log, then $ASHLR_HOME's copy
 *
 * Output is stable: ideas are sorted by payoff score, then id; ids are derived
 * from the bottleneck itself (never from time), and numbers are rounded.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { diskForecast, type DiskForecast } from './disk-forecast.js';
import {
  DROP_JOB_QUEUE_LIMIT, dropJobExists, DropJobExistsError, DropJobValidationError,
  resolveDropJobRoot, validateDropJob, writeDropJob, type DropJobInput,
} from './drop-job-writer.js';
import { parseIdleLanes, type IdleLane } from './idle-lanes.js';
import { defaultUsageLogPaths, parseUsageJournals, type UsageJournalRow } from './lane-console.js';
import { readFleetMainHealth, type FleetMainHealthRepo } from './main-health.js';
import { readFleetQueue, readSource } from './runs-parked-queue.js';
import { fleetYield } from './slot-yield.js';
import { enrichIdeas, validJobEvents } from './idea-context.js';

export const IDEA_LIST_SCHEMA = 'fleet.idea-list.v1';
export const SIGNAL_NAMES = ['empty-launches', 'guardian-fixups', 'disk-trend', 'idle-lanes', 'unspent-usage', 'vision', 'queue', 'mason-inbox', 'job-events'] as const;
export type SignalName = typeof SIGNAL_NAMES[number];
/** Window for the launch ledger: long enough to see a pattern, short enough to be current. */
export const EMPTY_WINDOW_HOURS = 72;
const HOUR = 3_600_000;
const LEDGER_BYTES = 4 * 1024 * 1024;
/** A usage reading older than this says nothing about what is left now. */
export const USAGE_READING_MAX_AGE_HOURS = 6;

export type Evidence = Record<string, number | string | null>;
export interface BottleneckIdea {
  id: string;
  signal: SignalName;
  title: string;
  evidence: Evidence;
  payoff: { score: number; text: string };
  task: string;
  why: string;
  lane: string | null;
  status: 'proposed' | 'queued' | 'running' | 'shipped';
}
export interface SignalStatus { name: SignalName; status: 'ok' | 'unknown'; reason: string | null }
export interface IdeaListReport {
  schema: typeof IDEA_LIST_SCHEMA;
  generatedAt: string;
  ideas: BottleneckIdea[];
  signals: SignalStatus[];
}

/** One signal's parsed input, or why it is unknown. */
export type Signal<T> = { ok: true; data: T } | { ok: false; reason: string };
export interface FamilyLaunches { family: string; launched: number; empty: number }
export interface GuardianFixups { repo: string; check: string | null; fixAttempts: number; emptyAttempts: number }
export interface UsageLeft { pool: string; usedPct: number; hoursToReset: number; readingAgeHours: number; projectedLeftPct: number | null }
export interface BottleneckSignals {
  emptyLaunches: Signal<FamilyLaunches[]>;
  guardianFixups: Signal<GuardianFixups[]>;
  disk: Signal<DiskForecast>;
  idleLanes: Signal<IdleLane[]>;
  unspentUsage: Signal<UsageLeft[]>;
}

const round = (n: number, places = 1): number => Math.round(n * 10 ** places) / 10 ** places;
const clampScore = (n: number): number => Math.max(1, Math.min(100, Math.round(n)));
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const hoursText = (h: number): string => h < 1 ? 'under an hour' : `about ${plural(Math.round(h), 'hour')}`;

/**
 * Pure: launches and empty runs per job family inside the window, from the same
 * tally `phm fleet yield` uses (family rules live in slot-yield's jobFamily).
 */
export function familyLaunches(ledger: string, now: number, hours = EMPTY_WINDOW_HOURS): FamilyLaunches[] {
  return fleetYield(ledger.split('\n'), now, hours).families
    .map(row => ({ family: row.name, launched: row.launches, empty: row.empty }))
    .sort((a, b) => a.family.localeCompare(b.family));
}

/** Pure: red repos whose guardian has tried to fix the same failure at least twice. */
export function guardianFixups(repos: readonly FleetMainHealthRepo[]): GuardianFixups[] {
  return repos.filter(repo => repo.state === 'red')
    .map(repo => ({ repo: repo.repo, check: repo.failingCheck, fixAttempts: repo.fixJobs.length + repo.emptyAttempts, emptyAttempts: repo.emptyAttempts }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

/**
 * Pure: what each pool has left now and, when the journal carries a burn rate,
 * at reset. Rows without a percentage or reset time, stale rows and windows
 * already reset are skipped rather than guessed.
 */
export function usageLeft(rows: Iterable<UsageJournalRow>, now: number): UsageLeft[] {
  const out: UsageLeft[] = [];
  for (const row of rows) {
    const observed = Date.parse(row.observedAt);
    const reset = row.resetAt === null ? NaN : Date.parse(row.resetAt);
    if (row.pctUsed === null || !Number.isFinite(observed) || !Number.isFinite(reset) || observed > now || reset <= now) continue;
    const readingAgeHours = (now - observed) / HOUR;
    if (readingAgeHours > USAGE_READING_MAX_AGE_HOURS) continue;
    // Project from the reading's own time, so an older reading is not credited with burn it already did.
    const hoursFromReading = (reset - observed) / HOUR;
    const projectedLeftPct = row.burnPerHour === null ? null : Math.max(0, 100 - row.pctUsed - row.burnPerHour * hoursFromReading);
    out.push({ pool: row.pool, usedPct: row.pctUsed, hoursToReset: (reset - now) / HOUR, readingAgeHours, projectedLeftPct });
  }
  return out.sort((a, b) => a.pool.localeCompare(b.pool));
}

/** Stable short id for the drop job a queued idea becomes (the drop id shape is A-Z0-9 only). */
export function ideaJobId(ideaId: string): string {
  return `IDEA${createHash('sha256').update(ideaId).digest('hex').slice(0, 12).toUpperCase()}`;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unknown';

/** Pure: turn signals into ranked ideas. Thresholds keep noise out; unknown signals add nothing. */
export function rankBottlenecks(signals: BottleneckSignals, now: number): IdeaListReport {
  const ideas: Omit<BottleneckIdea, 'why' | 'lane' | 'status'>[] = [];
  const status = (name: SignalName, signal: Signal<unknown>): SignalStatus =>
    ({ name, status: signal.ok ? 'ok' : 'unknown', reason: signal.ok ? null : signal.reason });

  if (signals.emptyLaunches.ok) {
    for (const f of signals.emptyLaunches.data) {
      // fleetYield counts empty runs among the runs launched in the window, so empty <= launched.
      const attempts = f.launched;
      const rate = attempts === 0 ? 0 : f.empty / attempts;
      if (f.empty < 2 || rate < 0.25) continue;
      ideas.push({
        id: `empty-launches:${slug(f.family)}`, signal: 'empty-launches',
        title: `${f.family} jobs came back empty ${f.empty} of ${attempts} times`,
        evidence: { family: f.family, launched: f.launched, empty: f.empty, emptyRate: round(rate, 2), windowHours: EMPTY_WINDOW_HOURS },
        payoff: { score: clampScore(f.empty * rate * 15), text: `Up to ${plural(f.empty, 'launch')} every ${EMPTY_WINDOW_HOURS} hours stop being wasted` },
        task: `Find why ${f.family} jobs finish with no change (${f.empty} of ${attempts} in ${EMPTY_WINDOW_HOURS}h; see phm fleet empty-why) and fix the cause in how they are written or launched.`,
      });
    }
  }

  if (signals.guardianFixups.ok) {
    for (const g of signals.guardianFixups.data) {
      if (g.fixAttempts < 2) continue;
      const check = g.check ?? 'an unnamed check';
      ideas.push({
        id: `guardian-fixups:${slug(g.repo)}:${slug(g.check ?? 'unknown')}`, signal: 'guardian-fixups',
        title: `Main in ${g.repo} is still red on ${check} after ${plural(g.fixAttempts, 'fix attempt')}`,
        evidence: { repo: g.repo, failingCheck: g.check, fixAttempts: g.fixAttempts, emptyFixAttempts: g.emptyAttempts },
        payoff: { score: clampScore(50 + g.fixAttempts * 10), text: `Main turns green in ${g.repo} and the repeat fix jobs stop` },
        task: `Fix the root cause of ${check} failing on main in ${g.repo}; ${plural(g.fixAttempts, 'guardian fix attempt')} have not cleared it, so read their notes before retrying the same fix.`,
      });
    }
  }

  if (signals.disk.ok) {
    const d = signals.disk.data;
    const hours = d.hoursUntilThreshold;
    if (d.status === 'reached' || (d.status === 'projected' && hours !== null && hours <= 72)) {
      const reached = d.status === 'reached';
      ideas.push({
        id: 'disk-trend:runway', signal: 'disk-trend',
        title: reached ? `Disk is down to ${round(d.freeGb ?? 0)} GB free, under the ${d.thresholdGb} GB floor` : `Disk will drop below ${d.thresholdGb} GB free in ${hoursText(hours!)}`,
        evidence: { freeGb: d.freeGb === null ? null : round(d.freeGb), gbPerHour: d.consumptionGbPerHour === null ? null : round(d.consumptionGbPerHour, 2), hoursUntilFloor: hours === null ? null : round(hours), floorGb: d.thresholdGb, samples: d.samples },
        payoff: { score: clampScore(reached ? 95 : 90 - hours!), text: 'Lanes keep launching instead of stalling on a full disk' },
        task: `Free disk space and stop the growth: ${d.consumptionGbPerHour === null ? 'growth rate unknown' : `${round(d.consumptionGbPerHour, 2)} GB/h`}, ${d.freeGb === null ? 'free space unknown' : `${round(d.freeGb)} GB free`}; see phm fleet disk-forecast and phm disk.`,
      });
    }
  }

  if (signals.idleLanes.ok) {
    for (const lane of signals.idleLanes.data) {
      // Held lanes are a deliberate pause; only a lane with room to run is a bottleneck.
      if (lane.status !== 'red') continue;
      const room = Math.min(lane.queued, lane.target - lane.running);
      ideas.push({
        id: `idle-lanes:${slug(lane.lane)}`, signal: 'idle-lanes',
        title: `${lane.lane} has ${plural(lane.queued, 'job')} waiting but runs ${lane.running} of ${lane.target}`,
        evidence: { lane: lane.lane, queued: lane.queued, running: lane.running, target: lane.target },
        payoff: { score: clampScore(30 + room * 12), text: `${plural(room, 'more job')} running at once on ${lane.lane}` },
        task: `Find why lane ${lane.lane} launches nothing while ${plural(lane.queued, 'job')} wait (${lane.running} of ${lane.target} running; see phm fleet idle-lanes) and fix the launch path.`,
      });
    }
  }

  if (signals.unspentUsage.ok) {
    for (const u of signals.unspentUsage.data) {
      const left = u.projectedLeftPct ?? 100 - u.usedPct;
      if (u.hoursToReset > 48 || left < 20) continue;
      const urgency = u.hoursToReset <= 12 ? 1 : u.hoursToReset <= 24 ? 0.75 : 0.5;
      ideas.push({
        id: `unspent-usage:${slug(u.pool)}`, signal: 'unspent-usage',
        title: `${u.pool} has ${Math.round(100 - u.usedPct)}% of its usage left and resets in ${hoursText(u.hoursToReset)}`,
        evidence: { pool: u.pool, usedPct: round(u.usedPct), hoursToReset: round(u.hoursToReset), readingAgeHours: round(u.readingAgeHours), projectedLeftAtResetPct: u.projectedLeftPct === null ? null : round(u.projectedLeftPct) },
        payoff: { score: clampScore(left * 0.8 * urgency), text: `About ${Math.round(left)}% of a paid usage window is used instead of expiring` },
        task: `Raise the ${u.pool} lane target or route queued work to it before its usage resets in ${hoursText(u.hoursToReset)}; ${Math.round(100 - u.usedPct)}% is unused${u.projectedLeftPct === null ? '' : ` and about ${Math.round(u.projectedLeftPct)}% will expire at the current pace`}.`,
      });
    }
  }

  ideas.sort((a, b) => b.payoff.score - a.payoff.score || a.id.localeCompare(b.id));
  return {
    schema: IDEA_LIST_SCHEMA,
    generatedAt: new Date(now).toISOString(),
    ideas: ideas.map(idea => ({ ...idea, why: idea.title, lane: typeof (idea.evidence.lane ?? idea.evidence.pool) === 'string' ? String(idea.evidence.lane ?? idea.evidence.pool) : 'claude', status: 'proposed' })),
    signals: [
      status('empty-launches', signals.emptyLaunches), status('guardian-fixups', signals.guardianFixups),
      status('disk-trend', signals.disk), status('idle-lanes', signals.idleLanes), status('unspent-usage', signals.unspentUsage),
    ],
  };
}

export interface ReadBottleneckOptions { runsDir?: string; usageLogPaths?: readonly string[]; now?: number }

const sourceReason = (path: string, state: string): string => state === 'missing' ? `${path} not found` : `${path} unreadable`;

/** Read all five signals from disk; each failure becomes an unknown signal, never an exception. */
export async function readBottleneckSignals(opts: ReadBottleneckOptions = {}): Promise<BottleneckSignals> {
  const now = opts.now ?? Date.now();
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR?.trim() ?? join(homedir(), '.ashlr-runs');
  const [ledger, history, status] = await Promise.all([
    readSource(join(root, 'metrics', 'jobs.jsonl'), LEDGER_BYTES, true),
    readSource(join(root, 'queue', 'disk-growth-history.json'), LEDGER_BYTES, false),
    readSource(join(root, 'queue', 'status.json'), 1024 * 1024, false),
  ]);

  const emptyLaunches: Signal<FamilyLaunches[]> = ledger.state === 'healthy' && validJobEvents(ledger.text, now)
    ? { ok: true, data: familyLaunches(ledger.text, now) } : { ok: false, reason: ledger.state === 'healthy' ? 'metrics/jobs.jsonl contains malformed event lines' : sourceReason('metrics/jobs.jsonl', ledger.state) };

  let guardian: Signal<GuardianFixups[]>;
  try {
    const health = await readFleetMainHealth({ runsDir: root, now: () => now });
    guardian = health.source === 'ok' ? { ok: true, data: guardianFixups(health.repos) } : { ok: false, reason: 'supervisor/status-main-guardian.md not found or unreadable' };
  } catch { guardian = { ok: false, reason: 'supervisor/status-main-guardian.md unreadable' }; }

  let disk: Signal<DiskForecast>;
  if (history.state !== 'healthy') disk = { ok: false, reason: sourceReason('queue/disk-growth-history.json', history.state) };
  else {
    const forecast = diskForecast(history.text, null, now);
    disk = forecast.status === 'unknown' ? { ok: false, reason: 'not enough disk samples to see a trend' } : { ok: true, data: forecast };
  }

  let idleLanes: Signal<IdleLane[]>;
  if (status.state !== 'healthy') idleLanes = { ok: false, reason: sourceReason('queue/status.json', status.state) };
  else {
    try { idleLanes = { ok: true, data: parseIdleLanes(status.text) }; } catch { idleLanes = { ok: false, reason: 'queue/status.json is not in the expected shape' }; }
  }

  const journals = (await Promise.all((opts.usageLogPaths ?? defaultUsageLogPaths(join(root, 'queue')))
    .map(path => readSource(path, LEDGER_BYTES, true)))).filter(source => source.state === 'healthy').map(source => source.text);
  let unspentUsage: Signal<UsageLeft[]>;
  if (journals.length === 0) unspentUsage = { ok: false, reason: 'usage-readings.log not found or unreadable' };
  else {
    const parsed = parseUsageJournals(journals);
    const rows = parsed.dropped ? [] : usageLeft(parsed.latest.values(), now);
    unspentUsage = rows.length > 0 ? { ok: true, data: rows } : { ok: false, reason: parsed.dropped ? 'usage-readings.log contains malformed lines' : `no usage reading from the last ${USAGE_READING_MAX_AGE_HOURS} hours with a reset time` };
  }

  return { emptyLaunches, guardianFixups: guardian, disk, idleLanes, unspentUsage };
}

/** The Ideas list: read signals, rank, report. Backs `phm ideas` and GET /api/verse/fleet/control/ideas. */
export async function readIdeaList(opts: ReadBottleneckOptions = {}): Promise<IdeaListReport> {
  const now = opts.now ?? Date.now();
  const report = rankBottlenecks(await readBottleneckSignals({ ...opts, now }), now);
  return enrichIdeas(report, resolveDropJobRoot(opts.runsDir), ideaJobId);
}

export interface QueueIdeaResult { ideaId: string; jobId: string; queued: boolean; existing: boolean }
export class QueueIdeaError extends Error {
  constructor(readonly status: 400 | 404 | 422 | 507, message: string) { super(message); this.name = 'QueueIdeaError'; }
}
export interface QueueIdeaDeps extends ReadBottleneckOptions {
  /** Defaults to a fresh read, so only an idea that is still current can be queued. */
  list?: () => Promise<IdeaListReport>;
  write?: (root: string, input: DropJobInput) => Promise<unknown>;
}

/** The drop-job body: the task line, its evidence and where it came from. */
export function ideaJobBody(idea: BottleneckIdea): string {
  const evidence = Object.entries(idea.evidence).map(([key, value]) => `${key}=${value ?? 'unknown'}`).join(', ');
  return `Goal: ${idea.task}\n\nWhy: ${idea.title}. Evidence: ${evidence}.\nPayoff: ${idea.payoff.text}.\nSource: Ideas list, idea ${idea.id}. Re-check the evidence first; if it no longer holds, finish with a short note instead of a change.`;
}

/**
 * "Queue it": write one current idea as a drop job for the dispatcher. The job
 * id is derived from the idea id, so a second click finds the same job.
 */
export async function queueIdea(ideaId: unknown, deps: QueueIdeaDeps = {}): Promise<QueueIdeaResult> {
  if (typeof ideaId !== 'string' || !/^[a-z-]+:[a-z0-9:_-]{1,160}$/.test(ideaId)) throw new QueueIdeaError(400, 'id must be an idea id from the Ideas list');
  const report = await (deps.list ?? (() => readIdeaList(deps)))();
  const idea = report.ideas.find(candidate => candidate.id === ideaId);
  if (!idea) throw new QueueIdeaError(404, 'that idea is not on the current list');
  if (idea.status !== 'proposed' || typeof idea.evidence.existingJobId === 'string') {
    const ref = String(idea.evidence.jobId ?? ideaJobId(idea.id));
    return { ideaId, jobId: ref === `RQ-PHX-${ideaJobId(idea.id)}` ? ideaJobId(idea.id) : ref, queued: false, existing: true };
  }
  const job: DropJobInput = { id: ideaJobId(idea.id), lane: idea.lane ?? 'claude', tier: 'work', body: scrubSecrets(ideaJobBody(idea)) };
  const verdict = validateDropJob(job);
  if (!verdict.ok) throw new QueueIdeaError(422, `job refused: ${verdict.reasons.join(', ')}`);
  const root = resolveDropJobRoot(deps.runsDir);
  const existing = { ideaId, jobId: job.id, queued: false, existing: true };
  if (await dropJobExists(root, job.id)) return existing;
  // Prompt files are retained after launch; only READY rows represent waiting work.
  if (!deps.write && (await readFleetQueue({ runsDir: root })).ready >= DROP_JOB_QUEUE_LIMIT) throw new QueueIdeaError(507, 'the job queue is full');
  try {
    await (deps.write ?? writeDropJob)(root, job);
  } catch (e) {
    if (e instanceof DropJobExistsError) return existing;
    if (e instanceof DropJobValidationError) throw new QueueIdeaError(422, `job refused: ${e.reasons.join(', ')}`);
    throw e;
  }
  return { ideaId, jobId: job.id, queued: true, existing: false };
}
