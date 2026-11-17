/**
 * job-control-types.ts — the wire contract for steering one fleet job
 * (pause, resume, stop, move), shared by `phm job <action>`, POST
 * /api/verse/fleet/runs/control and the desktop job detail.
 *
 * BROWSER-SAFE: types, plain constants and one pure sentence builder.
 */
export const VERSE_FLEET_RUNS_CONTROL_PATH = '/api/verse/fleet/runs/control';
/** The one file the dispatcher reads, relative to the runs directory. */
export const JOB_CONTROL_FILE = 'queue/job-control.jsonl';
export const JOB_CONTROL_SCHEMA = 'fleet.job.control.v1';

export const JOB_CONTROL_ACTIONS = ['pause', 'resume', 'stop', 'move'] as const;
export type JobControlAction = (typeof JOB_CONTROL_ACTIONS)[number];

/**
 * - `requested` — recorded; the dispatcher has not applied it yet.
 * - `applied`   — done (by Phantom directly, or acknowledged by the dispatcher).
 * - `refused`   — not done; `reason` says why in plain words.
 * - `unknown`   — no such job; nothing was recorded.
 */
export const JOB_CONTROL_STATUSES = ['requested', 'applied', 'refused', 'unknown'] as const;
export type JobControlStatus = (typeof JOB_CONTROL_STATUSES)[number];

/** Key order is fixed: this is the stable `--json` shape. */
export interface JobControlReceiptV1 {
  schema: typeof JOB_CONTROL_SCHEMA;
  action: JobControlAction;
  job: string;
  /** Target lane for move, else null. */
  lane: string | null;
  status: JobControlStatus;
  /** Why it was refused, else null. */
  reason: string | null;
  /** The request row's id; null when nothing was recorded. */
  requestId: string | null;
  at: string;
  /** True when nothing was written: `status` is what the real call would answer. */
  dryRun: boolean;
  /** True when this repeats an earlier request, which is returned unchanged. */
  duplicate: boolean;
}

export function isJobControlAction(value: unknown): value is JobControlAction {
  return (JOB_CONTROL_ACTIONS as readonly unknown[]).includes(value);
}

const DONE: Record<JobControlAction, string> = { pause: 'Paused', resume: 'Resumed', stop: 'Stopped', move: 'Moved' };
const ASKED: Record<JobControlAction, string> = { pause: 'Pause', resume: 'Resume', stop: 'Stop', move: 'Move' };

/** One plain sentence for a receipt: the CLI's text output and the inline desktop line. */
export function jobControlText(receipt: JobControlReceiptV1): string {
  const to = receipt.lane === null ? '' : ` to ${receipt.lane}`;
  const sentence =
    receipt.status === 'unknown' ? `No job ${receipt.job} found.`
      : receipt.status === 'refused' ? receipt.reason ?? 'Refused.'
        : receipt.status === 'applied' ? `${DONE[receipt.action]} ${receipt.job}${to}.`
          : `${ASKED[receipt.action]}${to} requested for ${receipt.job}.`;
  return receipt.dryRun ? `Dry run, nothing changed. ${sentence}` : sentence;
}
