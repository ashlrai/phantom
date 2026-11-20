/**
 * job-notes.ts — send a note to ONE running fleet job and read its notes back.
 * The single entry point behind `phm job say|notes`, POST/GET
 * /api/verse/fleet/runs/notes and the job window's note box.
 *
 * THE STEERING RECORD is one append-only file, <runsDir>/queue/job-notes.jsonl
 * (JOB_NOTES_FILE). Each accepted note is one JSON line:
 *   {schema, job, id, at, text, by}
 * A runner that supports steering reads the job's new lines between steps;
 * the file is the whole contract. A runner that does not is not told
 * anything: the note stays on the job record and is listed as "Notes sent"
 * in the job window and `phm job notes`. Whether a worker has read a note is
 * not recorded, so it is never claimed.
 *
 * Only a job that is running or queued takes a note. A finished job is
 * refused with a plain sentence; an id nothing knows is `unknown`. Refusals
 * and unknown jobs are never recorded. The same text twice in a row is one
 * note (`duplicate: true`), so a double tap or a retried request changes
 * nothing.
 */
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import {
  JOB_NOTES_FILE, JOB_NOTES_READ_MAX, JOB_NOTES_SCHEMA, JOB_NOTE_MAX, JOB_SAY_SCHEMA,
  type JobNoteV1, type JobNotesV1, type JobSayReceiptV1, type JobSayStatus,
} from './job-notes-types.js';
import { appendLine } from './job-stop.js';
import { parseReadyRows, readReadyText } from './ready-row-edit.js';
import { listLiveWorkers } from './runs-live-workers.js';
import { STRAY_ID_PATTERN } from './stray-slots.js';

/** What this computer knows about a job: still taking notes, over, or not known at all. */
export type JobNoteState = 'open' | 'finished' | 'unknown';

export interface JobNoteOptions {
  runsDir?: string;
  now?: () => number;
  /** Names the surface on the note (cli, desktop, mobile); never a person. */
  by?: string;
  /** Running job ids; injected so tests never read `ps`. */
  running?: () => Promise<string[]>;
  /** The state of a job that is neither running nor queued; injected so tests never read the run files. */
  state?: (job: string) => Promise<JobNoteState>;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

function resolveRunsDir(runsDir: string | undefined): string {
  const dir = runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(dir)) throw new TypeError('runs directory must be absolute');
  return dir;
}

/** Every note on `job` in file order. A damaged line is skipped, never fatal. */
async function readAll(runsDir: string, job: string): Promise<JobNoteV1[]> {
  let text: string;
  try { text = await readReadyText(join(runsDir, JOB_NOTES_FILE)); } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const notes: JobNoteV1[] = [];
  for (const line of text.split('\n')) {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (raw === null || typeof raw !== 'object' || raw.job !== job) continue;
    if (typeof raw.id !== 'string' || typeof raw.at !== 'string' || typeof raw.text !== 'string') continue;
    notes.push({ id: raw.id, at: raw.at, text: raw.text, by: typeof raw.by === 'string' ? raw.by : 'unknown' });
  }
  return notes;
}

/** The job's notes, oldest first (the newest JOB_NOTES_READ_MAX; `count` is the true total). */
export async function readJobNotes(job: string, opts: Pick<JobNoteOptions, 'runsDir'> = {}): Promise<JobNotesV1> {
  if (!STRAY_ID_PATTERN.test(job)) throw new TypeError('invalid job id');
  const all = await readAll(resolveRunsDir(opts.runsDir), job);
  return { schema: JOB_NOTES_SCHEMA, job, count: all.length, notes: all.slice(-JOB_NOTES_READ_MAX) };
}

async function runningJobs(): Promise<string[]> {
  const snapshot = await listLiveWorkers();
  // An unreadable process table must not read as "nothing is running".
  if (snapshot.sourceState !== 'healthy') throw new Error('live workers unavailable');
  return snapshot.workers.map((worker) => worker.job);
}

async function jobState(job: string, runsDir: string): Promise<JobNoteState> {
  const { getFleetJobTail } = await import('./runs-job-tail.js');
  const { status } = await getFleetJobTail(job, { runsDir, lines: 1 });
  return status === 'live' ? 'open' : status === 'unknown' ? 'unknown' : 'finished';
}

/** Trim, join lines into one, drop control characters and scrub secrets. */
function cleanNote(text: string): string {
  // eslint-disable-next-line no-control-regex
  return scrubSecrets(text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim());
}

/**
 * Append one note to a job's steering record and answer with a typed receipt.
 * Throws TypeError for a malformed request (bad id, empty or too long text) and
 * a plain Error when the fleet state cannot be read or written; every other
 * answer, including a finished job, is a receipt.
 */
export async function sayToJob(job: string, text: string, opts: JobNoteOptions & { dryRun?: boolean } = {}): Promise<JobSayReceiptV1> {
  if (!STRAY_ID_PATTERN.test(job)) throw new TypeError('invalid job id');
  if (typeof text !== 'string') throw new TypeError('note must be text');
  const note = cleanNote(text);
  if (note === '') throw new TypeError('note is empty');
  if (note.length > JOB_NOTE_MAX) throw new TypeError(`note is longer than ${JOB_NOTE_MAX} characters`);
  const runsDir = resolveRunsDir(opts.runsDir);
  const dryRun = opts.dryRun === true;
  const at = new Date((opts.now ?? Date.now)()).toISOString();
  const receipt = (status: JobSayStatus, reason: string | null = null, recorded: JobNoteV1 | null = null, duplicate = false): JobSayReceiptV1 =>
    ({ schema: JOB_SAY_SCHEMA, job, status, reason, note: recorded, dryRun, duplicate });

  const [history, running, queued] = await Promise.all([
    readAll(runsDir, job),
    (opts.running ?? runningJobs)(),
    readReadyText(join(runsDir, 'queue', 'ready.tsv')).then(parseReadyRows, () => []),
  ]);
  const open = running.includes(job) || queued.some((row) => row.id === job);
  if (!open) {
    const state = await (opts.state ?? ((id: string) => jobState(id, runsDir)))(job);
    if (state === 'unknown' && history.length === 0) return receipt('unknown');
    if (state !== 'open') return receipt('refused', `Job ${job} has finished, so it cannot read a note.`);
  }

  const last = history.at(-1);
  if (last && last.text === note) return receipt('sent', null, last, true);
  const recorded: JobNoteV1 = { id: `n-${history.length + 1}`, at, text: note, by: opts.by ?? 'phantom' };
  if (dryRun) return receipt('sent', null, recorded);
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await appendLine(join(runsDir, JOB_NOTES_FILE), `${JSON.stringify({ schema: JOB_SAY_SCHEMA, job, ...recorded })}\n`);
  return receipt('sent', null, recorded);
}
