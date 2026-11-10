/**
 * core/workbench/steer.ts — the three agent-steer verbs, shared by
 * POST /api/wb/v1/action (wb-action-api.ts) and the `phm wb` CLI twins
 * (cli/wb.ts):
 *
 *   steer.note          {text}            → append a steer note to the
 *                                           leaders' inbox (mason-inbox.ts —
 *                                           the same file the Steering pane
 *                                           and every interject path write)
 *   queue.reprioritize  {job, priority}   → re-priority one unclaimed
 *                                           queue.v1 line (READY or HOLD;
 *                                           an active attempt is never
 *                                           retiered mid-flight)
 *   job.stop            {job}             → signal every process carrying the
 *                                           job id on token boundaries
 *                                           (fleet/job-stop.ts — the same
 *                                           stop the Worker log pane uses)
 *
 * Both front doors run the same field validators here BEFORE calling
 * runSteerAction, so a refusal is identical from either surface — that is
 * what the parity test pins. dryRun plans only: no inbox bytes, no queue
 * mutation, no signal. SteerRefusedError marks a bad-input refusal
 * (CLI usage exit, HTTP 400 territory); every other failure is operational.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { QueueStore } from '../queue/store.js';
import { appendInboxEntry, INBOX_MAX_CHARS } from '../fleet/mason-inbox.js';
import { findJobProcesses, stopJob, type JobStopResult, type StopJobOptions } from '../fleet/job-stop.js';
import { STRAY_ID_PATTERN } from '../fleet/stray-slots.js';

export const STEER_ACTIONS = ['steer.note', 'queue.reprioritize', 'job.stop'] as const;
export type SteerActionName = (typeof STEER_ACTIONS)[number];

export type SteerRequest =
  | { action: 'steer.note'; text: string }
  | { action: 'queue.reprioritize'; job: string; priority: string }
  | { action: 'job.stop'; job: string };

export type SteerResult =
  | { action: 'steer.note'; outcome: 'accepted'; at: string; id: string; bytes: number }
  | { action: 'queue.reprioritize'; outcome: 'reprioritized'; job: string; from: string; to: string }
  | { action: 'job.stop'; outcome: 'stopped' | 'not-running' | 'planned'; job: string; pids: number[] };

/** The source stamp on steer notes: distinct, channel-slug-clean, fixed. */
export const STEER_NOTE_SOURCE = 'Phantom workbench';
/** `by` on the job-stops ledger: names the surface, never a person. */
const STEER_STOP_BY = 'phantom-workbench';

export const STEER_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type SteerPriority = (typeof STEER_PRIORITIES)[number];

/** Queue job ids: the queue schema's own shape, bounded like the other wb actions. */
const QUEUE_JOB_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class SteerRefusedError extends Error {}

/** Why a steer note cannot run, or null. Mirrors appendInboxEntry's own checks. */
export function steerNoteProblem(value: unknown): 'invalid' | 'empty' | 'too-long' | 'secret-shaped' | null {
  if (typeof value !== 'string') return 'invalid';
  const clean = value.replace(/\r\n/g, '\n').trim();
  if (!clean) return 'empty';
  if (clean.length > INBOX_MAX_CHARS) return 'too-long';
  return scrubSecrets(clean) === clean ? null : 'secret-shaped';
}

/** A queue line id fit for queue.hold/reprioritize, or 'invalid'. */
export function queueJobProblem(value: unknown): 'invalid' | null {
  return typeof value === 'string' && QUEUE_JOB_RE.test(value) && scrubSecrets(value) === value ? null : 'invalid';
}

/** A job id fit for process discovery (the stricter stray-worker shape), or 'invalid'. */
export function stopJobProblem(value: unknown): 'invalid' | null {
  return typeof value === 'string' && STRAY_ID_PATTERN.test(value) && scrubSecrets(value) === value ? null : 'invalid';
}

export function steerPriorityProblem(value: unknown): 'invalid' | null {
  return typeof value === 'string' && (STEER_PRIORITIES as readonly string[]).includes(value) ? null : 'invalid';
}

export interface SteerDeps {
  /** Process-table probe for job.stop dry runs; tests inject so they never read `ps`. */
  findJobProcesses?: (id: string) => Promise<number[]>;
  /** The signalling stop; tests inject so they never kill a real process. */
  stopJob?: (id: string, opts: StopJobOptions) => Promise<JobStopResult>;
}

export interface SteerOptions {
  /** Plan only (default true — callers opt IN to side effects). */
  dryRun?: boolean;
  runsDir?: string;
  deps?: SteerDeps;
}

const runsDirOf = (options: SteerOptions): string =>
  options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');

/**
 * Run one steer verb after its fields validated. Throws SteerRefusedError for
 * bad input, plain Error for operational failures.
 */
export async function runSteerAction(request: SteerRequest, options: SteerOptions = {}): Promise<SteerResult> {
  const dryRun = options.dryRun !== false;
  const runsDir = runsDirOf(options);
  switch (request.action) {
    case 'steer.note': {
      const problem = steerNoteProblem(request.text);
      if (problem) throw new SteerRefusedError(problem);
      const result = await appendInboxEntry(request.text, { runsDir, dryRun, source: STEER_NOTE_SOURCE });
      if (!result.ok) throw result.reason === 'write-failed' ? new Error(result.reason) : new SteerRefusedError(result.reason);
      return { action: 'steer.note', outcome: 'accepted', at: result.at, id: result.id, bytes: result.bytes };
    }
    case 'queue.reprioritize': {
      if (queueJobProblem(request.job) || steerPriorityProblem(request.priority)) throw new SteerRefusedError('invalid');
      const store = new QueueStore(join(runsDir, 'queue'));
      const from = await store.reprioritize(request.job, request.priority, dryRun);
      return { action: 'queue.reprioritize', outcome: 'reprioritized', job: request.job, from, to: request.priority };
    }
    case 'job.stop': {
      if (stopJobProblem(request.job)) throw new SteerRefusedError('invalid');
      if (dryRun) {
        const find = options.deps?.findJobProcesses ?? ((id: string) => findJobProcesses(id));
        const pids = await find(request.job);
        return { action: 'job.stop', outcome: pids.length > 0 ? 'planned' : 'not-running', job: request.job, pids };
      }
      const stop = options.deps?.stopJob ?? ((id: string, opts: StopJobOptions) => stopJob(id, opts));
      const result = await stop(request.job, { runsDir, by: STEER_STOP_BY });
      if (result.outcome === 'refused') throw new SteerRefusedError('invalid');
      return { action: 'job.stop', outcome: result.outcome, job: request.job, pids: result.pids };
    }
  }
}
