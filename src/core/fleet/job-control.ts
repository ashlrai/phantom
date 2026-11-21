/**
 * job-control.ts — steer ONE fleet job: pause, resume, stop, or move it to
 * another lane. The single entry point behind `phm job <action>`, POST
 * /api/verse/fleet/runs/control and the desktop job detail buttons.
 *
 * It reuses the control code that already exists rather than adding a path:
 *   - stop of a live job   → job-stop.ts `stopJob` (signals now: applied)
 *   - move of a queued job → runs-reassign.ts `reassignQueuedJobs` (applied)
 *   - everything else (pause, resume, move of a live job, stop of a queued
 *     job) cannot be done from here: it is recorded as `requested` and the
 *     dispatcher applies it.
 *
 * THE DISPATCHER CONTRACT is one append-only file, <runsDir>/queue/job-control.jsonl
 * (JOB_CONTROL_FILE). Each accepted request is one JSON line:
 *   {schema, requestId, at, action, job, lane, status, by}
 * The dispatcher acts on lines whose status is "requested", then appends an
 * acknowledgement line with the same requestId:
 *   {schema, requestId, status: "applied" | "refused", reason?, at}
 * Lines sharing a requestId fold together, the last status winning, so a
 * repeated request reads back the dispatcher's answer.
 *
 * IDEMPOTENT: a request equal to the job's latest standing request writes
 * nothing and returns that request (`duplicate: true`). requestId is derived
 * from job, action, lane and the job's request count, so two racing writers
 * mint the same id and still fold to one request. Refusals and unknown jobs
 * are never recorded: there is nothing for the dispatcher to do.
 */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { DROP_JOB_LANES } from './drop-job-writer.js';
import {
  JOB_CONTROL_FILE, JOB_CONTROL_SCHEMA, isJobControlAction,
  type JobControlAction, type JobControlLedgerRow, type JobControlReceiptV1, type JobControlStatus,
} from './job-control-types.js';
import { appendLine, stopJob, type JobStopResult, type StopJobOptions } from './job-stop.js';
import { parseReadyRows, readReadyText } from './ready-row-edit.js';
import { readLaneTargets, LANE_ID_RE, type LaneTargetRow } from './runs-lane-targets.js';
import { listLiveWorkers, type LiveWorker } from './runs-live-workers.js';
import { ReassignError, reassignQueuedJobs } from './runs-reassign.js';
import { STRAY_ID_PATTERN } from './stray-slots.js';

export interface JobControlRequest { action: JobControlAction; job: string; lane?: string; dryRun?: boolean }

export interface JobControlOptions {
  runsDir?: string;
  now?: () => number;
  /** Names the surface on the request row (cli, desktop, mobile); never a person. */
  by?: string;
  /** Live workers (job and lane); injected so tests never read `ps`. */
  workers?: () => Promise<LiveWorker[]>;
  /** The signalling stop; injected so tests never signal a real process. */
  stopJob?: (id: string, opts: StopJobOptions) => Promise<JobStopResult>;
  reassign?: typeof reassignQueuedJobs;
}

type LedgerRow = JobControlLedgerRow;

const defaultRunsDir = (): string => process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');

/**
 * Every request the control file holds, oldest first, each folded with its acknowledgements. Read only: the
 * session thread shows a job's rows. A missing file is no requests; an unreadable one throws.
 */
export async function readJobControlLedger(opts: { runsDir?: string } = {}): Promise<JobControlLedgerRow[]> {
  const runsDir = opts.runsDir ?? defaultRunsDir();
  if (!isAbsolute(runsDir)) throw new TypeError('runs directory must be absolute');
  return readLedger(runsDir);
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Fold the ledger: one row per requestId, the last status (the dispatcher's acknowledgement) winning. */
async function readLedger(runsDir: string): Promise<LedgerRow[]> {
  let text: string;
  try { text = await readReadyText(join(runsDir, JOB_CONTROL_FILE)); } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const rows = new Map<string, LedgerRow>();
  for (const line of text.split('\n')) {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (raw === null || typeof raw !== 'object' || typeof raw.requestId !== 'string') continue;
    const seen = rows.get(raw.requestId);
    const status = raw.status === 'applied' || raw.status === 'refused' || raw.status === 'requested' ? raw.status : null;
    if (seen) {
      if (status) { seen.status = status; seen.reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : null; }
    } else if (status && isJobControlAction(raw.action) && typeof raw.job === 'string' && typeof raw.at === 'string') {
      rows.set(raw.requestId, {
        requestId: raw.requestId, action: raw.action, job: raw.job, status, reason: null, at: raw.at,
        lane: typeof raw.lane === 'string' ? raw.lane : null,
        by: typeof raw.by === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(raw.by) ? raw.by : null,
      });
    }
  }
  return [...rows.values()];
}

/** An unreadable process table must not read as "no job is running". */
async function liveWorkers(): Promise<LiveWorker[]> {
  const snapshot = await listLiveWorkers();
  if (snapshot.sourceState !== 'healthy') throw new Error('live workers unavailable');
  return snapshot.workers;
}

/** Why `lane` cannot take a moved job right now, or null. */
function laneProblem(lane: string, targets: LaneTargetRow[], workers: LiveWorker[], from: string | null): string | null {
  const row = targets.find((target) => target.lane === lane);
  if (!row && !(DROP_JOB_LANES as readonly string[]).includes(lane)) return `Lane ${lane} does not exist.`;
  if (from === lane) return `Job is already on lane ${lane}.`;
  if (row?.held) return `Lane ${lane} is held.`;
  const running = workers.filter((worker) => worker.lane === lane).length;
  return row && running >= row.target ? `Lane ${lane} is full (${running} of ${row.target} running).` : null;
}

/**
 * Record or apply one control request and answer with a typed receipt. Throws
 * TypeError for a malformed request (bad id, bad or missing lane) and a plain
 * Error when the fleet state cannot be read or written; every other answer,
 * including refusals, is a receipt.
 */
export async function requestJobControl(request: JobControlRequest, opts: JobControlOptions = {}): Promise<JobControlReceiptV1> {
  const { action, job } = request;
  const lane = action === 'move' ? request.lane ?? '' : null;
  if (!isJobControlAction(action) || !STRAY_ID_PATTERN.test(job)) throw new TypeError('invalid job control request');
  if (lane !== null && !LANE_ID_RE.test(lane)) throw new TypeError('move needs a lane');
  const runsDir = opts.runsDir ?? defaultRunsDir();
  if (!isAbsolute(runsDir)) throw new TypeError('runs directory must be absolute');
  const dryRun = request.dryRun === true;
  const at = new Date((opts.now ?? Date.now)()).toISOString();
  const receipt = (status: JobControlStatus, reason: string | null = null, requestId: string | null = null): JobControlReceiptV1 =>
    ({ schema: JOB_CONTROL_SCHEMA, action, job, lane, status, reason, requestId, at, dryRun, duplicate: false });

  const [ledger, workers, ready] = await Promise.all([
    readLedger(runsDir),
    (opts.workers ?? liveWorkers)(),
    readReadyText(join(runsDir, 'queue', 'ready.tsv')).then(parseReadyRows, () => []),
  ]);
  const history = ledger.filter((row) => row.job === job);
  // The job's latest request the dispatcher did not turn down is what stands.
  const last = history.filter((row) => row.status !== 'refused').at(-1);
  const worker = workers.find((candidate) => candidate.job === job);
  const queued = !worker && ready.some((row) => row.id === job);

  // A repeat returns the standing request untouched. The one exception: a
  // stop that was applied, on a job that is running again (a retry under the
  // same id), is a new stop.
  if (last && last.action === action && last.lane === lane && !(action === 'stop' && last.status === 'applied' && worker)) {
    return { ...receipt(last.status, last.reason, last.requestId), at: last.at, duplicate: true };
  }
  if (!worker && !queued && history.length === 0) return receipt('unknown');
  if (action === 'resume' && last?.action !== 'pause') return receipt('refused', 'Job is not paused.');
  if (action !== 'resume' && !worker && !queued) return receipt('refused', 'Job is not running.');
  if (action === 'pause' && !worker) return receipt('refused', 'Job has not started yet.');

  let status: JobControlStatus = 'requested';
  if (lane !== null) {
    const targets = await readLaneTargets({ runsDir }).then((read) => read.lanes, () => []);
    const problem = laneProblem(lane, targets, workers, worker?.lane ?? null);
    if (problem) return receipt('refused', problem);
    if (queued) {
      // A job that has not launched moves now, through the existing reassign.
      try {
        await (opts.reassign ?? reassignQueuedJobs)({ job, lane, apply: !dryRun, reason: 'job control' }, { runsDir, changedBy: opts.by });
        status = 'applied';
      } catch (error) {
        if (error instanceof ReassignError) return receipt('refused', `${error.message}.`);
        throw error;
      }
    }
  } else if (action === 'stop' && worker) {
    status = 'applied';
  }
  if (dryRun) return receipt(status);

  const requestId = `jc-${createHash('sha256').update([job, action, lane ?? '', history.length].join('\0')).digest('hex').slice(0, 12)}`;
  const line = `${JSON.stringify({ schema: JOB_CONTROL_SCHEMA, requestId, at, action, job, lane, status, by: opts.by ?? 'phantom' })}\n`;
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  const file = join(runsDir, JOB_CONTROL_FILE);
  // Record first, then signal: a stop that cannot be recorded must not fire.
  await appendLine(file, line);
  if (action === 'stop' && worker) {
    try { await (opts.stopJob ?? stopJob)(job, { runsDir, by: opts.by }); } catch (error) {
      // The signal failed (not our process): take the "applied" back, in the
      // same acknowledgement shape the dispatcher writes.
      const reason = 'Phantom could not signal the job.';
      await appendLine(file, `${JSON.stringify({ schema: JOB_CONTROL_SCHEMA, requestId, status: 'refused', reason, at })}\n`);
      throw error;
    }
  }
  return receipt(status, null, requestId);
}
