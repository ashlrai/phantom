/**
 * feedback-queue-record.ts — the feedback scan's own record of what it queued.
 *
 * `runFeedback --apply` turns triaged signals into `RQ-PHX-FB<hash>` drop
 * jobs, but until now the only durable trace of which submission became
 * which job was the job's own prompt file — which moves through
 * leader/drop/claude → queue/prompts → <id>.prompt → leader/drop/done and
 * is never joined back to the request. One JSON line per successful
 * writeDropJob lands in `<runsDir>/feedback/feedback-queued.jsonl`:
 * `{"at":<iso>,"job":"RQ-PHX-FB…","source":"…","ref":"…","kind":"…"}`.
 * `phm fleet feedback digest` folds the same rows into per-submission
 * outcomes, so a reporter can trace issue → job → PR → merged without
 * asking anyone where their submission went.
 *
 * Honesty rules, same as every other fleet journal:
 *  - The row records the admission decision only: job id, signal source,
 *    the request ref (first signal ref — an issue/PR URL or a comms
 *    receipt id; null when the signal carried none) and the triage
 *    kind. The submission text itself is never re-journaled — it already
 *    lives, untrusted, inside the drop job's prompt. `ref` is the first
 *    signal ref exactly as validated (the dedupe anchor), not canonicalized.
 *  - Append-only, one line per queued job. A missing file reads as zero
 *    recorded rows (no scan has applied yet); an unreadable or malformed
 *    file reads as unknown, never as an empty success.
 *  - recordFeedbackQueued refuses a non-regular-file journal (a symlinked
 *    or directory path is never appended through) and throws on failure —
 *    the caller treats that as non-fatal evidence loss, not a queue failure.
 */
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FEEDBACK_QUEUED_JOURNAL = 'feedback-queued.jsonl';
/** Bounded tail read; one row is ~200 bytes, so 1 MiB covers thousands of admissions. */
const JOURNAL_TAIL_BYTES = 1024 * 1024;
/** Queue job id shape: RQ-PHX-FB plus the dedupe hash inside the ingest's [A-Z0-9]{3,40} bound. */
const FB_JOB = /^RQ-PHX-FB[A-Z0-9]{3,40}$/;
const SOURCES = new Set(['github-issue', 'pr-comment', 'comms', 'ci-failure', 'revert', 'self-report']);
const KINDS = new Set(['bug', 'regression', 'feature', 'flake']);
const MAX_REF_CHARS = 240;

export interface FeedbackQueuedEntry {
  /** ISO admission timestamp the scan stamped. */
  at: string;
  /** Queue job id: RQ-PHX-FB<dedupe hash>. */
  job: string;
  /** FeedbackSignal.source that produced the job. */
  source: string;
  /** Request ref (first signal ref), or null when the signal carried none. */
  ref: string | null;
  /** Triage kind that passed the gate (question never queues). */
  kind: string;
}

export type FeedbackQueuedRead =
  | { state: 'ok'; entries: FeedbackQueuedEntry[] }
  | { state: 'missing' }
  | { state: 'unavailable' };

export const feedbackQueuedPath = (runsDir: string): string =>
  join(runsDir, 'feedback', FEEDBACK_QUEUED_JOURNAL);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Append one journal row per entry. Throws on any failure; callers treat a
 * throw as lost evidence for that job, never as a reason to unqueue it.
 */
export async function recordFeedbackQueued(runsDir: string, entries: readonly FeedbackQueuedEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const dir = join(runsDir, 'feedback');
  await mkdir(dir, { recursive: true });
  const path = feedbackQueuedPath(runsDir);
  const stat = await lstat(path).catch(() => null);
  if (stat && !stat.isFile()) throw new Error('feedback queue record is not a file');
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  await appendFile(path, lines, { mode: 0o600 });
}

/** One journal line under the writer's contract; anything else is skipped, never guessed. */
function parseEntry(line: string): FeedbackQueuedEntry | null {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return null; }
  if (!isRecord(row)) return null;
  const { at, job, source, ref, kind } = row;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  if (typeof job !== 'string' || !FB_JOB.test(job)) return null;
  if (typeof source !== 'string' || !SOURCES.has(source)) return null;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  if (ref !== null && ref !== undefined && (typeof ref !== 'string' || ref.length > MAX_REF_CHARS)) return null;
  return { at, job, source, ref: typeof ref === 'string' ? ref : null, kind };
}

/**
 * Read the bounded journal tail. 'missing' is a known-empty state (no scan
 * has applied on this install); 'unavailable' covers unreadable files and
 * read failures — callers report it, never fold it as zero rows.
 */
export async function readFeedbackQueued(runsDir: string): Promise<FeedbackQueuedRead> {
  const path = feedbackQueuedPath(runsDir);
  let text: string;
  let cut = false;
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) return { state: 'unavailable' };
    const raw = await readFile(path, 'utf8');
    cut = raw.length > JOURNAL_TAIL_BYTES;
    text = cut ? raw.slice(-JOURNAL_TAIL_BYTES) : raw;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unavailable' };
  }
  // A tail cut can land mid-line; drop the first partial line.
  const lines = text.split('\n');
  if (cut) lines.shift();
  const entries: FeedbackQueuedEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const entry = parseEntry(line);
    if (entry !== null) entries.push(entry);
  }
  return { state: 'ok', entries };
}
