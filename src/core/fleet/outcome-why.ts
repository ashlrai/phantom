/**
 * core/fleet/outcome-why.ts — the single read for "why is this outcome
 * failed" (Mason t1628u items 2 and 4: his main outcome "Continuously
 * improve Phantom" showed Failed and no verb explained why). One call returns
 * the outcome's status, its failed and aborted tasks with run ids and repos,
 * the manager's latest stage state, and each failed run's stream-log path
 * when that file is on disk. Read-only; nothing here dispatches or repairs.
 *
 * The read itself is executeOutcomeOperation({ kind: 'read' }) — the same
 * read behind GET /api/verse/outcomes — so a degraded or missing ledger
 * reports exactly what the console sees, never a second opinion. The CLI
 * calls this once per process; the worker hop in outcomes-io exists to keep
 * protected-folder IO off the desktop HTTP loop and is not needed here.
 * logPath is set only when the run stream file exists, checked through the
 * injected fs dep.
 */
import { existsSync } from 'node:fs';
import { executeOutcomeOperation } from '../verse/outcomes-operations.js';
import type {
  OutcomeOperation, OutcomeOperationResult, OutcomeStatus, OutcomeTaskView, OutcomeView, OutcomesRead,
} from '../verse/outcomes-api-types.js';

export type { OutcomeView, OutcomesRead, OutcomeTaskView } from '../verse/outcomes-api-types.js';

/** A failed or aborted outcome task, with its run's log path when the file exists. */
export interface OutcomeWhyTask {
  key: string;
  title: string;
  repo: string | null;
  state: OutcomeTaskView['state'];
  runId: string | null;
  logPath: string | null;
}

export interface OutcomeWhy {
  v: 1;
  id: string;
  status: OutcomeStatus;
  headline: string;
  failedTasks: OutcomeWhyTask[];
  manager: { latestState: string | null };
  /** One plain sentence telling the reader where to look next. */
  nextStep: string;
}

export interface OutcomeWhyError {
  v: 1;
  /** The asked-for id, or null when every failed outcome was requested. */
  id: string | null;
  error: 'not-found' | 'source-unavailable';
}

/** No-id mode: every outcome whose status is 'failed'. */
export interface OutcomeWhyList {
  v: 1;
  outcomes: OutcomeWhy[];
}

export type OutcomeWhyResult = OutcomeWhy | OutcomeWhyError | OutcomeWhyList;

export interface ExplainOutcomeDeps {
  /** The outcome metadata read; defaults to the same read the outcomes API serves. */
  run?: (operation: OutcomeOperation) => OutcomeOperationResult | Promise<OutcomeOperationResult>;
  /** Where a run's stream log would live; default ~/.ashlr/run-streams/<runId>.log. */
  logPathFor?: (runId: string) => string | undefined | Promise<string | undefined>;
  /** Whether a path is an existing file on disk; default fs.existsSync. */
  fileExists?: (path: string) => boolean;
}

/** streaming.js also carries the CLI sink machinery; the lazy import mirrors fleet-control. */
async function defaultLogPathFor(runId: string): Promise<string | undefined> {
  const streaming = await import('../run/streaming.js');
  return streaming.runStreamFilePath(runId);
}

/** Manager stage states the projection itself treats as a failed latest stage. */
const FAILED_STAGE_STATES = new Set(['failed', 'aborted', 'stale']);

function isOutcomesRead(result: OutcomeOperationResult): result is OutcomesRead {
  return !!result && typeof result === 'object' && !('ok' in result);
}

async function explainOne(view: OutcomeView, deps: Required<Pick<ExplainOutcomeDeps, 'logPathFor' | 'fileExists'>>): Promise<OutcomeWhy> {
  const latest = view.manager?.latest ?? null;
  const latestState = latest?.state ?? null;
  const failedTasks: OutcomeWhyTask[] = [];
  for (const task of view.tasks) {
    if (task.state !== 'failed' && task.state !== 'aborted') continue;
    let logPath: string | null = null;
    if (task.runId !== null) {
      const candidate = await deps.logPathFor(task.runId);
      if (candidate !== undefined && deps.fileExists(candidate)) logPath = candidate;
    }
    failedTasks.push({ key: task.key, title: task.title, repo: task.repo, state: task.state, runId: task.runId, logPath });
  }
  let headline: string;
  let nextStep: string;
  if (failedTasks.length > 0) {
    headline = `${failedTasks.length} of ${view.tasks.length} tasks failed`;
    const first = failedTasks[0]!;
    nextStep = first.logPath !== null
      ? `Read the log of run ${first.runId} at ${first.logPath} to see why task ${first.key} failed.`
      : first.runId !== null
        ? `Inspect run ${first.runId} for task ${first.key}; no stream log exists on disk.`
        : `Inspect task ${first.key} in the outcome ledger; no run id was recorded.`;
  } else if (latestState !== null && FAILED_STAGE_STATES.has(latestState)) {
    headline = 'Manager stage failed';
    const runId = latest?.terminalRunId ?? latest?.runId ?? null;
    nextStep = runId !== null
      ? `Inspect manager stage run ${runId}; the latest stage ended ${latestState}.`
      : `Inspect the outcome ledger; the latest manager stage ended ${latestState} with no run recorded.`;
  } else if (view.status === 'failed') {
    headline = 'Failed, no failed task recorded';
    nextStep = 'Re-read the outcome; it reports failed but records no failed task or failed manager stage.';
  } else {
    headline = 'No failure recorded';
    nextStep = `Nothing to fix; the outcome is ${view.status}.`;
  }
  return { v: 1, id: view.id, status: view.status, headline, failedTasks, manager: { latestState }, nextStep };
}

/**
 * With an id, explain that one outcome. With no id, explain every outcome
 * whose status is 'failed'. Errors: 'not-found' only names a missing id;
 * 'source-unavailable' covers a degraded ledger or a thrown read.
 */
export async function explainOutcome(id: string | null | undefined, deps: ExplainOutcomeDeps = {}): Promise<OutcomeWhyResult> {
  const run = deps.run ?? executeOutcomeOperation;
  const io = { logPathFor: deps.logPathFor ?? defaultLogPathFor, fileExists: deps.fileExists ?? existsSync };
  let read: OutcomeOperationResult;
  try {
    read = await run({ kind: 'read' });
  } catch {
    return { v: 1, id: id ?? null, error: 'source-unavailable' };
  }
  if (!isOutcomesRead(read) || read.outcomes === null) return { v: 1, id: id ?? null, error: 'source-unavailable' };
  if (id !== undefined && id !== null) {
    const view = read.outcomes.find(outcome => outcome.id === id);
    return view ? explainOne(view, io) : { v: 1, id, error: 'not-found' };
  }
  const outcomes: OutcomeWhy[] = [];
  for (const view of read.outcomes) if (view.status === 'failed') outcomes.push(await explainOne(view, io));
  return { v: 1, outcomes };
}
