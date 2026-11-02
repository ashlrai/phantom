/**
 * core/fleet/runs-reassign.ts — RQ-PHX-RUNSREASSIGNVERB01: move queued jobs
 * between dispatcher lanes by editing queue/ready.tsv rows in place, so a
 * stranded lane can be drained in seconds instead of re-issuing jobs by hand
 * under new ids (the Oct 31 codex-personal hold: 20 queued Phantom jobs sat
 * for hours while other lanes idled).
 *
 * WHAT A REASSIGN IS: a queued job is a ready.tsv row with no
 * <runsDir>/<id>.launch marker yet. Reassigning rewrites that row's lane (3rd)
 * and tier (4th) column — id, repo, prompt path and any extra columns stay
 * byte-identical, and queue/prompts/<id>.md is never touched. The row can
 * only move BEFORE launch: rows that launched or were parked keep their
 * state and land in skipped[], or refuse the call outright in single-job
 * mode.
 *
 * SAFETY ORDER, before any row is planned:
 *   - the target lane must exist in slots.json (readLaneTargets) or
 *     DROP_JOB_LANES — never invent a lane the dispatcher cannot read;
 *   - a held target lane refuses (lane-held) unless force: holds are the
 *     very mechanism that stranded the Oct 31 queue, so moving work INTO a
 *     hold is opt-in only;
 *   - target lane `claude` while queue/claude-lane.state begins with the
 *     word "down" refuses (lane-down) unless force — ingest already reroutes
 *     claude-bound work to codex-personal in that state, so assigning there
 *     would park it again;
 *   - a tier outside DROP_JOB_TIERS refuses (tier-unknown).
 *
 * WRITE PATH goes through rewriteReadyRows (ready-row-edit.ts): temp +
 * rename, then wait-verify-retry against the dispatcher's whole-file
 * rewrite. applied moves are reported only after the verified re-read — a
 * row the dispatcher's rewrite reverted is 'unverified', never 'moved'.
 * Every confirmed move appends one audit row to queue/reassign.log
 * (iso \t id \t fromLane \t toLane \t by \t reason) through
 * the same O_APPEND|O_NOFOLLOW guarded-open pattern runs-lane-hold.ts uses
 * for lane-target-changes.log; the log is preflighted before the rewrite so
 * a bad audit sink refuses the mutation instead of losing the record.
 */
import { constants, type Stats } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DROP_JOB_LANES, DROP_JOB_TIERS } from './drop-job-writer.js';
import { isPhantomJob, parseParkedState } from './runs-parked-queue.js';
import { readLaneTargets } from './runs-lane-targets.js';
import { parseReadyRows, readReadyText, rewriteReadyRows, type ReadyRow } from './ready-row-edit.js';

export const REASSIGN_LOG = 'reassign.log';
const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const scrub = (value: string, max: number): string =>
  // eslint-disable-next-line no-control-regex -- scrubbing control bytes is the point.
  value.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').slice(0, max).trim();

export type ReassignCode =
  'job-not-found' | 'job-launched' | 'job-parked' | 'lane-unknown' | 'lane-same' |
  'lane-down' | 'lane-held' | 'tier-unknown' | 'queue-missing';

export class ReassignError extends Error {
  readonly status: 404 | 422 | 503;
  constructor(readonly code: ReassignCode) {
    super({
      'job-not-found': 'Queued job not found',
      'job-launched': 'Job already launched',
      'job-parked': 'Job is parked',
      'lane-unknown': 'Unknown lane',
      'lane-same': 'Job already has that lane and tier',
      'lane-down': 'Lane is down',
      'lane-held': 'Lane is held',
      'tier-unknown': 'Unknown tier',
      'queue-missing': 'Queue is unavailable',
    }[code]);
    this.name = 'ReassignError';
    this.status = code === 'job-not-found' ? 404 : code === 'queue-missing' ? 503 : 422;
  }
}

export interface ReassignMoveV1 { id: string; fromLane: string; toLane: string; fromTier: string; toTier: string }
export interface ReassignSkipV1 { id: string; reason: string }
export interface ReassignReportV1 {
  v: 1;
  generatedAt: string;
  applied: boolean;
  lane: string;
  moved: ReassignMoveV1[];
  skipped: ReassignSkipV1[];
  verified: boolean | null;
}

export interface ReassignInput {
  /** Single-job mode: the ready.tsv id to move. Exactly one of job/fromLane. */
  job?: string;
  /** Lane mode: move every queued Phantom (RQ-PHX-) job whose lane equals this. */
  fromLane?: string;
  /** Target lane — must exist in slots.json or DROP_JOB_LANES. */
  lane: string;
  /** Optional target tier — must be in DROP_JOB_TIERS. Omitted keeps each row's tier. */
  tier?: string;
  /** false = plan only; the queue and the log are never touched. */
  apply: boolean;
  /** Override lane-held / lane-down refusals. */
  force?: boolean;
  reason?: string;
}

export interface ReassignOptions {
  runsDir?: string;
  now?: () => Date;
  changedBy?: string;
  /** Passed through to rewriteReadyRows — injected by tests. */
  verifyMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** True when queue/claude-lane.state's first line begins with the word "down". */
async function claudeLaneDown(queueDir: string): Promise<boolean> {
  try {
    const first = (await readFile(join(queueDir, 'claude-lane.state'), 'utf8')).split('\n')[0] ?? '';
    return /^\s*down\b/i.test(first);
  } catch {
    return false; // no state file: the lane is not marked down
  }
}

async function launchMarkerExists(runsDir: string, id: string): Promise<boolean> {
  try {
    return (await lstat(join(runsDir, `${id}.launch`))).isFile();
  } catch {
    return false;
  }
}

/** Guarded audit-sink open — the checks copied from runs-lane-hold.ts, unchanged. */
async function openReassignLog(queueDir: string) {
  const log = await open(join(queueDir, REASSIGN_LOG),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await log.stat();
    if (!stat.isFile() || !owned(stat) || stat.nlink !== 1) throw new ReassignError('queue-missing');
    return log;
  } catch (error) {
    await log.close().catch(() => {});
    throw error;
  }
}

/**
 * Plan and optionally apply a queued-job reassignment. With apply:false the
 * report is the plan (verified null); with apply:true moved[] holds only the
 * rows the verified re-read confirmed — the dispatcher's own rewrite can
 * still revert a row, which reports 'unverified' instead of lying 'moved'.
 */
export async function reassignQueuedJobs(input: ReassignInput, opts: ReassignOptions = {}): Promise<ReassignReportV1> {
  if ((input.job === undefined) === (input.fromLane === undefined)) {
    throw new TypeError('reassignQueuedJobs: exactly one of job or fromLane is required');
  }
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(root)) throw new ReassignError('queue-missing');
  const queueDir = join(root, 'queue');
  const now = (opts.now ?? (() => new Date()))();

  let rows: ReadyRow[];
  try {
    rows = parseReadyRows(await readReadyText(join(queueDir, 'ready.tsv')));
  } catch {
    throw new ReassignError('queue-missing');
  }

  const targets = await readLaneTargets({ runsDir: root, now: () => now });
  const knownLanes = new Set<string>([...DROP_JOB_LANES, ...targets.lanes.map((lane) => lane.lane)]);
  if (!knownLanes.has(input.lane)) throw new ReassignError('lane-unknown');
  if (!input.force) {
    if (targets.lanes.some((lane) => lane.lane === input.lane && lane.held)) throw new ReassignError('lane-held');
    if (input.lane === 'claude' && await claudeLaneDown(queueDir)) throw new ReassignError('lane-down');
  }
  if (input.tier !== undefined && !(DROP_JOB_TIERS as readonly string[]).includes(input.tier)) {
    throw new ReassignError('tier-unknown');
  }
  if (input.fromLane !== undefined && input.fromLane === input.lane && input.tier === undefined) {
    throw new ReassignError('lane-same');
  }

  const candidates = input.job !== undefined
    ? rows.filter((row) => row.id === input.job)
    : rows.filter((row) => row.lane === input.fromLane);
  if (input.job !== undefined && candidates.length === 0) throw new ReassignError('job-not-found');

  const planned: ReassignMoveV1[] = [];
  const skipped: ReassignSkipV1[] = [];
  for (const row of candidates) {
    let reason: ReassignCode | 'not-phantom' | null = null;
    if (input.fromLane !== undefined && !isPhantomJob({ lane: row.lane, id: row.id, repo: row.repo })) reason = 'not-phantom';
    else if (parseParkedState(row.lane).parked) reason = 'job-parked';
    else if (await launchMarkerExists(root, row.id)) reason = 'job-launched';
    else if (row.lane === input.lane && (input.tier === undefined || row.tier === input.tier)) reason = 'lane-same';
    if (reason === null) {
      planned.push({ id: row.id, fromLane: row.lane, toLane: input.lane, fromTier: row.tier, toTier: input.tier ?? row.tier });
    } else {
      skipped.push({ id: row.id, reason });
    }
  }
  // Single-job mode refuses with the row's own code rather than reporting an
  // empty move; lane mode reports per-row skips so the plan stays visible.
  if (input.job !== undefined && planned.length === 0) throw new ReassignError(skipped[0]!.reason as ReassignCode);

  if (!input.apply) {
    return { v: 1, generatedAt: now.toISOString(), applied: false, lane: input.lane, moved: planned, skipped, verified: null };
  }
  if (planned.length === 0) {
    return { v: 1, generatedAt: now.toISOString(), applied: true, lane: input.lane, moved: [], skipped, verified: null };
  }

  const by = scrub(opts.changedBy ?? 'Phantom fleet reassign', 200) || 'Phantom fleet reassign';
  const reason = scrub(input.reason ?? '', 200);
  // Preflight the audit sink before any mutation: a log that cannot be
  // appended refuses the whole reassign instead of recording it nowhere.
  const log = await openReassignLog(queueDir);
  let result: Awaited<ReturnType<typeof rewriteReadyRows>>;
  try {
    const planKey = (id: string, lane: string, tier: string) => `${id}\0${lane}\0${tier}`;
    const planByKey = new Map(planned.map((move) => [planKey(move.id, move.fromLane, move.fromTier), move]));
    result = await rewriteReadyRows(queueDir, (fresh) => fresh.map((row) => {
      // Only a row still carrying the state we planned on is rewritten — a
      // row changed under us (retiered, parked, claimed) is left for the
      // verifier to report, never blindly overwritten. Keying on
      // id+lane+tier also keeps duplicate ids on different lanes distinct.
      const plan = planByKey.get(planKey(row.id, row.lane, row.tier));
      if (!plan) return row;
      const cells = row.raw.split('\t');
      cells[2] = plan.toLane;
      cells[3] = plan.toTier;
      return { ...row, lane: plan.toLane, tier: plan.toTier, raw: cells.join('\t') };
    }), { verifyMs: opts.verifyMs, attempts: opts.attempts, now: opts.now, sleep: opts.sleep });

    let confirmed = planned;
    if (!result.verified) {
      let fresh: ReadyRow[] = [];
      try {
        fresh = parseReadyRows(await readReadyText(join(queueDir, 'ready.tsv')));
      } catch { fresh = []; }
      confirmed = planned.filter((plan) =>
        fresh.some((row) => row.id === plan.id && row.lane === plan.toLane && row.tier === plan.toTier));
    }
    const kept = new Set(confirmed);
    for (const move of planned) if (!kept.has(move)) skipped.push({ id: move.id, reason: 'unverified' });

    for (const move of confirmed) {
      await log.writeFile(`${now.toISOString()}\t${move.id}\t${move.fromLane}\t${move.toLane}\t${by}\t${reason}\n`);
    }
    return { v: 1, generatedAt: now.toISOString(), applied: true, lane: input.lane, moved: confirmed, skipped, verified: result.verified };
  } finally { await log.close(); }
}
