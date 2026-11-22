/**
 * The Ideas loop engine: rank what the fleet should fix next from signals
 * Phantom already keeps locally. Six signals, each read through its existing
 * parser; a signal that cannot be read is reported as `unknown` with a reason
 * and contributes no ideas, so nothing is ever invented from a missing file.
 *
 *   empty launches per job family  metrics/jobs.jsonl (launch + empty outcome rows)
 *   repeated main-guardian fixups  supervisor/status-main-guardian.md (+ ledger)
 *   disk free trend                queue/disk-growth-history.json (diskForecast)
 *   lanes with queued work idle    queue/status.json (parseIdleLanes)
 *   unspent subscription usage     queue/usage-readings.log, then $ASHLR_HOME's copy
 *   self-awareness loop diagnosis  metrics/selection-hints.json (phm metrics loop)
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
import { minutesText, STAGE_NAMES, stageWords } from '../metrics/loop-stages.js';

export const IDEA_LIST_SCHEMA = 'fleet.idea-list.v1';
export const SIGNAL_NAMES = ['empty-launches', 'guardian-fixups', 'disk-trend', 'idle-lanes', 'unspent-usage', 'loop-hints', 'vision', 'queue', 'mason-inbox', 'job-events'] as const;
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
/** The slice of metrics/selection-hints.json the Ideas list ranks; every field stays null when the report did not carry it. */
export interface LoopHints {
  /** Report stamp (ISO) and its age in hours at read time. */
  at: string;
  ageHours: number;
  /** The window the stage times cover, when the report carried one. */
  since: string | null;
  /** The loop's named binding constraint and its evidence sentence, when the report carried one. */
  constraint: { name: string; evidence: string } | null;
  /** The slowest measured loop stage and its p50 minutes, when the report carried one. */
  slowest: { stage: string; p50Minutes: number } | null;
  /** True when the jobs-ledger tail behind the report was cut at the read cap. */
  jobsTruncated: boolean | null;
}
export interface BottleneckSignals {
  emptyLaunches: Signal<FamilyLaunches[]>;
  guardianFixups: Signal<GuardianFixups[]>;
  disk: Signal<DiskForecast>;
  idleLanes: Signal<IdleLane[]>;
  unspentUsage: Signal<UsageLeft[]>;
  loopHints: Signal<LoopHints>;
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

/** selection-hints.json is small advisory loop output; a larger file is not the contract. */
const LOOP_HINTS_MAX_BYTES = 256 * 1024;
/** The hints report is `phm metrics loop` output; older than this it no longer describes the fleet. */
export const LOOP_HINTS_MAX_AGE_HOURS = 72;
/** A loop stage only becomes an idea when its median wait reaches this many minutes. */
export const LOOP_HINTS_MIN_STAGE_P50_MINUTES = 60;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Pure: validate one metrics/selection-hints.json document into the slice the
 * Ideas list ranks. The file is advisory loop output (`phm metrics loop`); a
 * non-JSON body, a missing schema tag or advisory flag, an unreadable or
 * future report stamp, or a report older than LOOP_HINTS_MAX_AGE_HOURS is
 * unknown, never guessed. Fields the report did not carry stay null.
 */
export function parseSelectionHints(text: string, now: number): Signal<LoopHints> {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { ok: false, reason: 'metrics/selection-hints.json is not valid JSON' }; }
  if (!isRecord(doc) || doc.schema !== 'metrics.selection-hints.v1' || doc.advisory !== true) {
    return { ok: false, reason: 'metrics/selection-hints.json is not a metrics.selection-hints.v1 advisory report' };
  }
  const atMs = typeof doc.at === 'string' ? Date.parse(doc.at) : NaN;
  if (!Number.isFinite(atMs)) return { ok: false, reason: 'metrics/selection-hints.json has no readable report time' };
  const ageHours = (now - atMs) / HOUR;
  if (ageHours < -1) return { ok: false, reason: 'metrics/selection-hints.json is stamped in the future' };
  if (ageHours > LOOP_HINTS_MAX_AGE_HOURS) return { ok: false, reason: `metrics/selection-hints.json is older than ${LOOP_HINTS_MAX_AGE_HOURS} hours` };
  const rawConstraint = isRecord(doc.top_constraint) ? doc.top_constraint : null;
  const constraint = rawConstraint !== null && typeof rawConstraint.name === 'string' && rawConstraint.name !== ''
    ? { name: rawConstraint.name, evidence: typeof rawConstraint.evidence === 'string' ? rawConstraint.evidence : '' }
    : null;
  const wait = isRecord(doc.loop_wait) && typeof doc.loop_wait.missing !== 'string' ? doc.loop_wait : null;
  const slowestRaw = wait !== null && isRecord(wait.slowest) ? wait.slowest : null;
  const slowest = slowestRaw !== null && typeof slowestRaw.stage === 'string' && slowestRaw.stage !== ''
    && typeof slowestRaw.p50_minutes === 'number' && Number.isFinite(slowestRaw.p50_minutes) && slowestRaw.p50_minutes >= 0
    ? { stage: slowestRaw.stage, p50Minutes: slowestRaw.p50_minutes }
    : null;
  return {
    ok: true,
    data: {
      at: doc.at as string, ageHours: round(Math.max(0, ageHours)),
      since: wait !== null && typeof wait.since === 'string' ? wait.since : null,
      constraint, slowest,
      jobsTruncated: wait !== null && typeof wait.jobs_truncated === 'boolean' ? wait.jobs_truncated : null,
    },
  };
}

/**
 * The loop's named binding constraints that are themselves fixable
 * bottlenecks, with a payoff score each. `unknown` stays out: it means no
 * diagnosis was possible, and the unknown-signal path already reports it.
 */
const LOOP_CONSTRAINT_IDEAS: Record<string, { score: number; title: string; payoff: string; task: (evidence: string) => string }> = {
  merge: {
    score: 75, title: 'The self-improvement loop is not merging', payoff: 'Open PRs start landing again',
    task: evidence => `PRs opened in the last 6h but none merged (${evidence}). Find where they stall — merge queue, required checks or review — and unblock the merge path; see phm metrics loop and phm fleet merge-latency.`,
  },
  supply: {
    score: 70, title: 'The self-improvement loop has no supply', payoff: 'Work starts flowing into the loop again',
    task: evidence => `Nothing opened or merged in 6h (${evidence}). Find why no work is being produced — queue supply, admission or upstream planning; see phm metrics loop.`,
  },
  capacity: {
    score: 65, title: 'The fleet has no spare capacity', payoff: 'Queued work gets slots again',
    task: evidence => `Every measured node reports zero spare slots (${evidence}). Find what holds them — running jobs, lane holds or caps — and free or add capacity; see phm metrics loop and phm fleet unfed.`,
  },
  measurement: {
    score: 55, title: 'The self-improvement loop cannot measure itself', payoff: 'Loop metrics read again',
    task: evidence => `The jobs ledger could not be read, so every loop metric is unknown (${evidence}). Restore the metrics/jobs.jsonl read path the loop folds; see phm metrics loop.`,
  },
  install: {
    score: 60, title: 'Merges wait too long to install', payoff: 'Shipped work reaches the installed bundle sooner',
    task: evidence => `Merges reach the installed bundle slower than they reach master (${evidence}). Shorten the release path or find what delays installs; see phm metrics loop.`,
  },
  'idea-to-merge': {
    score: 50, title: "Idea-to-merge latency is the loop's binding constraint", payoff: 'Ideas reach master faster',
    task: evidence => `The loop's binding constraint is idea-to-merge latency (${evidence}). Profile the stage boundaries in phm metrics loop and remove the largest wait.`,
  },
};

/** Plain-words label for a loop stage id; unknown stage spellings pass through as recorded. */
function loopStageLabel(stage: string): string {
  return (STAGE_NAMES as readonly string[]).includes(stage) ? stageWords(stage as (typeof STAGE_NAMES)[number]) : stage;
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

  if (signals.loopHints.ok) {
    const hints = signals.loopHints.data;
    const stamp = { hintsAt: hints.at, hintsAgeHours: hints.ageHours };
    const named = hints.constraint === null ? undefined : LOOP_CONSTRAINT_IDEAS[hints.constraint.name];
    if (hints.constraint !== null && named !== undefined) {
      const evidenceText = scrubSecrets(hints.constraint.evidence).replace(/\s+/g, ' ').trim().slice(0, 200);
      ideas.push({
        id: `loop-constraint:${slug(hints.constraint.name)}`, signal: 'loop-hints',
        title: named.title,
        evidence: { constraint: hints.constraint.name, constraintEvidence: evidenceText === '' ? null : evidenceText, ...stamp },
        payoff: { score: named.score, text: named.payoff },
        task: named.task(evidenceText === '' ? 'the loop report carried no evidence sentence' : evidenceText),
      });
    }
    if (hints.slowest !== null && hints.slowest.p50Minutes >= LOOP_HINTS_MIN_STAGE_P50_MINUTES) {
      const label = loopStageLabel(hints.slowest.stage);
      ideas.push({
        id: `loop-wait:${slug(hints.slowest.stage)}`, signal: 'loop-hints',
        title: `The self-improvement loop's slowest stage is ${label} (p50 ${minutesText(hints.slowest.p50Minutes)})`,
        evidence: {
          stage: hints.slowest.stage, p50Minutes: round(hints.slowest.p50Minutes), since: hints.since,
          jobsTruncated: hints.jobsTruncated === null ? null : String(hints.jobsTruncated), ...stamp,
        },
        payoff: { score: clampScore(hints.slowest.p50Minutes / 2), text: `The loop's longest wait shrinks by up to ${minutesText(hints.slowest.p50Minutes)} per job` },
        task: `The self-awareness loop measures ${label} as its slowest stage at p50 ${minutesText(hints.slowest.p50Minutes)}${hints.since === null ? '' : ` over jobs finished since ${hints.since}`}. Profile that stage's ledger boundaries (phm metrics loop --json) and remove the largest wait.`,
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
      status('loop-hints', signals.loopHints),
    ],
  };
}

export interface ReadBottleneckOptions { runsDir?: string; usageLogPaths?: readonly string[]; now?: number }

const sourceReason = (path: string, state: string): string => state === 'missing' ? `${path} not found` : `${path} unreadable`;

/** Read all six signals from disk; each failure becomes an unknown signal, never an exception. */
export async function readBottleneckSignals(opts: ReadBottleneckOptions = {}): Promise<BottleneckSignals> {
  const now = opts.now ?? Date.now();
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR?.trim() ?? join(homedir(), '.ashlr-runs');
  const [ledger, history, status, hints] = await Promise.all([
    readSource(join(root, 'metrics', 'jobs.jsonl'), LEDGER_BYTES, true),
    readSource(join(root, 'queue', 'disk-growth-history.json'), LEDGER_BYTES, false),
    readSource(join(root, 'queue', 'status.json'), 1024 * 1024, false),
    readSource(join(root, 'metrics', 'selection-hints.json'), LOOP_HINTS_MAX_BYTES, false),
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

  const loopHints: Signal<LoopHints> = hints.state === 'healthy'
    ? parseSelectionHints(hints.text, now)
    : { ok: false, reason: sourceReason('metrics/selection-hints.json', hints.state) };

  return { emptyLaunches, guardianFixups: guardian, disk, idleLanes, unspentUsage, loopHints };
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
