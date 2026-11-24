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

/** One request from the control file, folded with the acknowledgement lines that share its requestId (the last status wins). */
export interface JobControlLedgerRow {
  requestId: string;
  action: JobControlAction;
  job: string;
  lane: string | null;
  status: JobControlStatus;
  reason: string | null;
  /** When the request was recorded. */
  at: string;
  /** The surface that asked (cli, desktop, mobile), or null when the row names none. */
  by: string | null;
}

export function isJobControlAction(value: unknown): value is JobControlAction {
  return (JOB_CONTROL_ACTIONS as readonly unknown[]).includes(value);
}

export interface JobControlAvailability { available: boolean; reason: string | null }

/**
 * Whether Pause, Stop and Move can reach a session, with a plain reason when
 * they cannot. One rule for the tail snapshot (`controls`) and the map's side
 * panel. `undefined` is a server that does not say: no control API.
 */
export function jobControlAvailability(status: 'unknown' | 'finished' | 'no-log' | 'live' | 'remote' | undefined): JobControlAvailability {
  const reason = status === undefined ? 'This Phantom server has no job control for this session.'
    : status === 'unknown' ? 'No job control: this session is not recorded on this computer.'
      : status === 'remote' ? 'No job control: this session runs on another computer.'
        : status === 'finished' ? 'This session has finished, so there is nothing to pause, stop or move.' : null;
  return { available: reason === null, reason };
}

const DONE: Record<JobControlAction, string> = { pause: 'Paused', resume: 'Resumed', stop: 'Stopped', move: 'Moved' };
const ASKED: Record<JobControlAction, string> = { pause: 'Pause', resume: 'Resume', stop: 'Stop', move: 'Move' };

/** A recorded request in a few words: "Pause requested", "Moved to codex", "Stop refused". */
export function jobControlRecordLabel(row: Pick<JobControlLedgerRow, 'action' | 'lane' | 'status'>): string {
  const to = row.lane === null ? '' : ` to ${row.lane}`;
  return row.status === 'applied' ? `${DONE[row.action]}${to}` : `${ASKED[row.action]}${to} ${row.status === 'refused' ? 'refused' : 'requested'}`;
}

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
