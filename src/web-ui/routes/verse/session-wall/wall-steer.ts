/**
 * What was asked of each session's job, on the Conversations wall: the pause
 * in force or the request the dispatcher has not applied yet, as the wall's
 * own read carries it (`control` on each entry of fleet.session-threads.v1,
 * the job control file's answer). Pure: the mark a card and a row show, the
 * sessions the "Paused or asked" button keeps, and what P asks for.
 */
import { jobControlRecordLabel } from '../../../../core/fleet/job-control-types.js';
import type { WallEntry } from './session-wall-model.js';

/** `paused`: a pause stands (asked or applied). `asked`: another request is waiting for the dispatcher. */
export interface SteerMark { tone: 'paused' | 'asked'; text: string }
export interface SteerAsk { job: string; action: 'pause' | 'resume' }

/** The job Pause and Resume can reach from a card: the rule the opened conversation applies (session-thread-model.ts `steerable`). */
export function steerJob({ session }: WallEntry): string | null {
  const { kind, jobId, state } = session;
  return kind === 'worker' && jobId !== null && (state === 'running' || state === 'quiet' || state === 'unknown') ? jobId : null;
}

/**
 * The words beside a session's state, or null. A finished resume, stop or move is history the conversation holds;
 * the mark is for what is pending or still in force, and only on a session whose job can still be steered.
 */
export function steerMark(entry: WallEntry): SteerMark | null {
  const stands = entry.control;
  if (stands === null || steerJob(entry) === null) return null;
  if (stands.action === 'pause') return { tone: 'paused', text: jobControlRecordLabel(stands) };
  return stands.status === 'requested' ? { tone: 'asked', text: jobControlRecordLabel(stands) } : null;
}

export const steeredEntries = (entries: readonly WallEntry[]): readonly WallEntry[] => entries.filter(entry => steerMark(entry) !== null);

/** What P asks of a card's job: resume while a pause stands, pause otherwise; null when the session has no job to steer. */
export function steerAsk(entry: WallEntry): SteerAsk | null {
  const job = steerJob(entry);
  return job === null ? null : { job, action: entry.control?.action === 'pause' ? 'resume' : 'pause' };
}

/** Whether the read now shows what a landed request asked for, so the line that announced it can go. */
export function steerShown(entries: readonly WallEntry[], ask: SteerAsk): boolean {
  return entries.some(entry => entry.session.jobId === ask.job && entry.control?.action === ask.action);
}
