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
 * byte-identical, and queue/prompts/<id>.md is never touched. A row carrying
 * a requirements cell also has its `preferred_lane` moved with the column:
 * the work market prefers the spec hint over the lane cell, so a
 * column-only rewrite would report the job moved while the market kept it
 * on the old lane. A spec-less row whose router-queue.md envelope names a
 * lane gets the resolved spec written with the new `preferred_lane` for the
 * same reason: the envelope is not editable here, and without the cell the
 * next dispatcher tick would re-pin the old lane and silently undo the move.
 * The row can only move BEFORE launch: rows that launched
 * or were parked keep their state and land in skipped[], or refuse the
 * call outright in single-job mode.
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
import { isPhantomJob, parseParkedState, readSource } from './runs-parked-queue.js';
import { readyEnvelopeSpec, readySpecCell, resolveReadyMarketRow } from './unfed-market.js';
import { readLaneTargets } from './runs-lane-targets.js';
import { parseReadyRows, readReadyText, rewriteReadyRows, type ReadyRow } from './ready-row-edit.js';

export const REASSIGN_LOG = 'reassign.log';
/** router-queue.md is append-mostly Markdown history; same bound the unfed and supply reads use. */
const ROUTER_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
/** dispatchd's JID: only these ids can carry a market row at all. */
const JOB_ID = /^[A-Za-z0-9._-]+$/;
const owned = (stat: Stats): boolean => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const scrub = (value: string, max: number): string =>
  // eslint-disable-next-line no-control-regex -- scrubbing control bytes is the point.
  value.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').slice(0, max).trim();

/**
 * The spec a spec-less (exactly five-column) ready row inherits from its
 * router-queue.md `(attrs)` envelope, resolved like dispatchd's routed pass:
 * the envelope replaces requirements wholesale, so its preferred_lane (or
 * lane/pool attr) is the market hint and the lane column is never consulted.
 * Null when the market would not consult an envelope — parked rows, ids the
 * dispatcher rejects, a malformed envelope, or an absent/over-bound
 * router-queue.md, where the market's own fallback is the lane column.
 */
function envelopeSpec(row: ReadyRow, cells: string[], routerQueue: string | null): Record<string, unknown> | null {
  if (cells.length !== 5 || routerQueue === null) return null;
  if (row.id.startsWith('PARKED-') || (cells[2] ?? '').startsWith('PARKED-') || !JOB_ID.test(row.id)) return null;
  const spec = readyEnvelopeSpec(routerQueue, row.id);
  return spec !== null && spec !== 'invalid' ? spec : null;
}

/**
 * The lane the work market prefers for this ready row: the requirements
 * cell's `preferred_lane` when the row carries a spec — explicit `null` is
 * the open hint — a spec-less row's router-queue.md envelope when one
 * matches, else the lane column, the fallback work_market.requirements
 * applies when the key is absent. Null when the hint is open or the row has
 * no lane at all. A spec the market would reject still reports its declared
 * preference: the reassign rewrites that cell, not the market's verdict.
 */
function marketHint(row: ReadyRow, routerQueue: string | null = null): string | null {
  const cells = row.raw.split('\t');
  if (cells.length > 5) {
    const spec = readySpecCell(cells[5]);
    if (spec !== null && spec !== 'invalid' && Object.hasOwn(spec, 'preferred_lane')) {
      const value = spec.preferred_lane;
      return typeof value === 'string' ? value : null;
    }
  } else {
    const spec = envelopeSpec(row, cells, routerQueue);
    if (spec !== null && Object.hasOwn(spec, 'preferred_lane')) {
      const value = spec.preferred_lane;
      return typeof value === 'string' ? value : null;
    }
  }
  const lane = cells[2] ?? '';
  return lane === '' ? null : lane;
}

/** The lane a queued row is effectively on: its market hint, or the lane
 * column when the hint is open — the column then records the last placement. */
function queuedLane(row: ReadyRow, routerQueue: string | null = null): string {
  return marketHint(row, routerQueue) ?? row.lane;
}

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
  /** Lane mode: move every queued Phantom (RQ-PHX-) job whose market-resolved lane equals this. */
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
  // Spec-less rows resolve their market hint from router-queue.md envelopes;
  // an absent or over-bound queue leaves the lane column standing, exactly
  // like the market's own fallback when no envelope matches.
  const routerQueueRead = await readSource(join(queueDir, 'router-queue.md'), ROUTER_QUEUE_MAX_BYTES, false);
  const routerQueue = routerQueueRead.state === 'healthy' ? routerQueueRead.text : null;

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

  // Lane mode drains the lane the market resolves each row to — a spec
  // preferred_lane or router-queue envelope wins over the lane column, so
  // matching the raw column would strand exactly the rows this verb exists
  // to move.
  const candidates = input.job !== undefined
    ? rows.filter((row) => row.id === input.job)
    : rows.filter((row) => queuedLane(row, routerQueue) === input.fromLane);
  if (input.job !== undefined && candidates.length === 0) throw new ReassignError('job-not-found');

  // columnLane is the lane cell the plan was made on: the rewrite matches a
  // fresh row by the state it will still carry, while fromLane reports the
  // lane the market resolved (they differ when a spec pin disagrees).
  const planned: { move: ReassignMoveV1; columnLane: string }[] = [];
  const skipped: ReassignSkipV1[] = [];
  for (const row of candidates) {
    let reason: ReassignCode | 'not-phantom' | null = null;
    if (input.fromLane !== undefined && !isPhantomJob({ lane: row.lane, id: row.id, repo: row.repo })) reason = 'not-phantom';
    else if (parseParkedState(row.lane).parked) reason = 'job-parked';
    else if (await launchMarkerExists(root, row.id)) reason = 'job-launched';
    // "Already on the lane" needs the column AND the market's resolved hint
    // to agree — a column that already says the target does not mask a spec
    // or envelope still pinning the job elsewhere.
    else if (row.lane === input.lane && marketHint(row, routerQueue) === input.lane && (input.tier === undefined || row.tier === input.tier)) reason = 'lane-same';
    if (reason === null) {
      planned.push({ move: { id: row.id, fromLane: queuedLane(row, routerQueue), toLane: input.lane, fromTier: row.tier, toTier: input.tier ?? row.tier }, columnLane: row.lane });
    } else {
      skipped.push({ id: row.id, reason });
    }
  }
  // Single-job mode refuses with the row's own code rather than reporting an
  // empty move; lane mode reports per-row skips so the plan stays visible.
  if (input.job !== undefined && planned.length === 0) throw new ReassignError(skipped[0]!.reason as ReassignCode);

  if (!input.apply) {
    return { v: 1, generatedAt: now.toISOString(), applied: false, lane: input.lane, moved: planned.map((plan) => plan.move), skipped, verified: null };
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
    const planByKey = new Map(planned.map((plan) => [planKey(plan.move.id, plan.columnLane, plan.move.fromTier), plan]));
    result = await rewriteReadyRows(queueDir, (fresh) => fresh.map((row) => {
      // Only a row still carrying the state we planned on is rewritten — a
      // row changed under us (retiered, parked, claimed) is left for the
      // verifier to report, never blindly overwritten. Keying on
      // id+lane+tier also keeps duplicate ids on different lanes distinct.
      const plan = planByKey.get(planKey(row.id, row.lane, row.tier));
      if (!plan) return row;
      const cells = row.raw.split('\t');
      cells[2] = plan.move.toLane;
      cells[3] = plan.move.toTier;
      // Sync the requirements cell's preferred_lane so the market's resolved
      // hint moves with the column; a cell it cannot parse stays untouched —
      // the row is already dead to the market either way.
      if (cells.length > 5) {
        const spec = readySpecCell(cells[5]);
        if (spec !== null && spec !== 'invalid' && spec.preferred_lane !== plan.move.toLane) {
          spec.preferred_lane = plan.move.toLane;
          cells[5] = JSON.stringify(spec) + (cells[5]!.endsWith('\r') ? '\r' : '');
        }
      } else if (cells.length === 5) {
        // A spec-less row's envelope keeps pinning preferred_lane when the
        // dispatcher materializes the spec cell next tick, which would
        // silently undo a column-only move. Write the resolved spec with the
        // new lane instead — but only one the market's own requirements
        // check accepts; anything else stays spec-less and column-only,
        // exactly like an unparseable requirements cell.
        const env = envelopeSpec(row, cells, routerQueue);
        if (env !== null && env.preferred_lane !== plan.move.toLane) {
          const spec = { ...env, preferred_lane: plan.move.toLane };
          if (resolveReadyMarketRow(cells, spec) !== null) {
            const prompt = cells[4]!;
            const cr = prompt.endsWith('\r') ? '\r' : '';
            if (cr) cells[4] = prompt.slice(0, -1);
            cells.push(JSON.stringify(spec) + cr);
          }
        }
      }
      return { ...row, lane: plan.move.toLane, tier: plan.move.toTier, raw: cells.join('\t') };
    }), { verifyMs: opts.verifyMs, attempts: opts.attempts, now: opts.now, sleep: opts.sleep });

    let confirmed = planned;
    if (!result.verified) {
      let fresh: ReadyRow[] = [];
      try {
        fresh = parseReadyRows(await readReadyText(join(queueDir, 'ready.tsv')));
      } catch { fresh = []; }
      confirmed = planned.filter((plan) =>
        fresh.some((row) => row.id === plan.move.id && row.lane === plan.move.toLane && row.tier === plan.move.toTier && marketHint(row, routerQueue) === plan.move.toLane));
    }
    const kept = new Set(confirmed);
    for (const plan of planned) if (!kept.has(plan)) skipped.push({ id: plan.move.id, reason: 'unverified' });

    for (const plan of confirmed) {
      await log.writeFile(`${now.toISOString()}\t${plan.move.id}\t${plan.move.fromLane}\t${plan.move.toLane}\t${by}\t${reason}\n`);
    }
    return { v: 1, generatedAt: now.toISOString(), applied: true, lane: input.lane, moved: confirmed.map((plan) => plan.move), skipped, verified: result.verified };
  } finally { await log.close(); }
}
