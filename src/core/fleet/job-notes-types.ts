/**
 * job-notes-types.ts — the wire contract for sending a note to one running
 * fleet job ("also update the docs"), shared by `phm job say|notes <id>`,
 * POST/GET /api/verse/fleet/runs/notes and the job window's note box.
 *
 * BROWSER-SAFE: types, plain constants and pure sentence builders.
 */
export const VERSE_FLEET_RUNS_NOTES_PATH = '/api/verse/fleet/runs/notes';
/** The job's steering record, relative to the runs directory. One JSON line per note. */
export const JOB_NOTES_FILE = 'queue/job-notes.jsonl';
export const JOB_SAY_SCHEMA = 'fleet.job.say.v1';
export const JOB_NOTES_SCHEMA = 'fleet.job.notes.v1';
/** Longest note, in characters. Longer text is refused, never cut. */
export const JOB_NOTE_MAX = 500;
/** Most notes one read returns (newest kept). */
export const JOB_NOTES_READ_MAX = 50;

/**
 * - `sent`    — appended to the job's notes; the worker reads it at its next step
 *               where its runner supports that, and it is shown on the job either way.
 * - `refused` — not recorded; `reason` says why in plain words (finished job, bad text).
 * - `unknown` — no such job; nothing was recorded.
 */
export const JOB_SAY_STATUSES = ['sent', 'refused', 'unknown'] as const;
export type JobSayStatus = (typeof JOB_SAY_STATUSES)[number];

export interface JobNoteV1 {
  /** Stable per job: n-1, n-2, … in the order sent. */
  id: string;
  at: string;
  text: string;
  /** The surface that sent it (cli, desktop, mobile); never a person. */
  by: string;
}

/** Key order is fixed: this is the stable `--json` shape of `phm job say`. */
export interface JobSayReceiptV1 {
  schema: typeof JOB_SAY_SCHEMA;
  job: string;
  status: JobSayStatus;
  reason: string | null;
  /** The note as recorded (trimmed, secrets scrubbed); null when nothing was recorded. */
  note: JobNoteV1 | null;
  /** True when nothing was written: `status` is what the real call would answer. */
  dryRun: boolean;
  /** True when the same text was already the job's latest note, which is returned unchanged. */
  duplicate: boolean;
}

/** `phm job notes` and GET runs/notes: every note on one job, oldest first. */
export interface JobNotesV1 {
  schema: typeof JOB_NOTES_SCHEMA;
  job: string;
  /** Total notes on the job; `notes` holds the newest JOB_NOTES_READ_MAX of them. */
  count: number;
  notes: JobNoteV1[];
}

export function isJobSayStatus(value: unknown): value is JobSayStatus {
  return (JOB_SAY_STATUSES as readonly unknown[]).includes(value);
}

/** One plain sentence for a receipt: the CLI's text output and the inline note-box line. */
export function jobSayText(receipt: JobSayReceiptV1): string {
  const sentence =
    receipt.status === 'unknown' ? `No job ${receipt.job} found.`
      : receipt.status === 'refused' ? receipt.reason ?? 'Refused.'
        : receipt.duplicate ? `Already sent to ${receipt.job}.`
          : `Note sent to ${receipt.job}.`;
  return receipt.dryRun ? `Dry run, nothing changed. ${sentence}` : sentence;
}

/** The plain lines of "Notes sent": the job window, the phone screen, the PR body. */
export function jobNotesLines(notes: readonly JobNoteV1[]): string[] {
  return notes.map((note) => `${note.at.slice(0, 16).replace('T', ' ')} · ${note.text}`);
}
