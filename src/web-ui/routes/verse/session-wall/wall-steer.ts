/**
 * What was asked of each session's job, on the Conversations wall: the pause
 * in force or the request the dispatcher has not applied yet, as the wall's
 * own read carries it (`control` on each entry of fleet.session-threads.v1,
 * the job control file's answer). Pure: the mark a card and a row show, the
 * sessions the "Paused or asked" button keeps, what P asks for, the lanes M
 * offers, and how a request that just landed from this wall is shown on its
 * card until the read says it too.
 */
import { jobControlRecordLabel, type JobControlAction, type JobControlReceiptV1 } from '../../../../core/fleet/job-control-types.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import type { SessionWallRead, WallEntry } from './session-wall-model.js';

/** `paused`: a pause stands (asked or applied). `asked`: another request is waiting for the dispatcher. */
export interface SteerMark { tone: 'paused' | 'asked'; text: string }
export interface SteerAsk { job: string; action: JobControlAction; /** The lane a move goes to. */ lane?: string }
/** The keys a card answers: P pauses or resumes, S stops, M moves. */
export type SteerKey = 'p' | 's' | 'm';
export const isSteerKey = (key: string): key is SteerKey => key === 'p' || key === 's' || key === 'm';

/** The job Pause, Stop and Move can reach from a card: the rule the opened conversation applies (session-thread-model.ts `steerable`). */
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
  return entries.some(entry => entry.session.jobId === ask.job && entry.control?.action === ask.action && (ask.lane === undefined || entry.control.lane === ask.lane));
}

/** What the line above the cards says while a request is on its way. */
export function steerBusyText(ask: SteerAsk): string {
  const doing = { pause: 'Pausing', resume: 'Resuming', stop: 'Stopping', move: 'Moving' }[ask.action];
  return `${doing} ${ask.job}${ask.lane === undefined ? '' : ` to ${ask.lane}`}…`;
}

/** Said when a key is pressed on a card whose session has no job to steer. */
export function steerNothingText(id: string, key: SteerKey): string {
  return `${id} has no running job to ${key === 'p' ? 'pause or resume' : key === 's' ? 'stop' : 'move'}.`;
}

/** A request this wall made and the server recorded, with the server's own time for it. */
export interface Landed { ask: SteerAsk; status: 'requested' | 'applied'; at: string }

/**
 * How long a card says a landed request on the receipt's word alone. The wall's read trails a request by about
 * 15 seconds; a read made this long after the receipt that still does not show it is believed over the receipt.
 */
export const LANDED_HOLD_MS = 45_000;

/** The receipt as something a card can show; null when nothing was recorded (refused, unknown job, dry run). */
export function landedOf(ask: SteerAsk, receipt: Pick<JobControlReceiptV1, 'status' | 'at' | 'dryRun'>): Landed | null {
  return (receipt.status === 'requested' || receipt.status === 'applied') && !receipt.dryRun ? { ask, status: receipt.status, at: receipt.at } : null;
}

/** Whether a landed request is still the card's to say: its session is on the wall, the read does not show it yet, and the read is not much newer than the receipt. */
export function landedHolds(landed: Landed, read: Pick<SessionWallRead, 'entries' | 'generatedAt'>): boolean {
  if (!read.entries.some(entry => entry.session.jobId === landed.ask.job) || steerShown(read.entries, landed.ask)) return false;
  // Both times are the server's. One that cannot be read is no reason to keep saying something the read does not.
  return Date.parse(read.generatedAt) - Date.parse(landed.at) < LANDED_HOLD_MS;
}

/** The entries with each landed request written where the read will write it, so the card, the row and P all go by it at once. */
export function withLanded(entries: readonly WallEntry[], landed: readonly Landed[]): WallEntry[] {
  return entries.map(entry => {
    const mine = landed.find(one => one.ask.job === entry.session.jobId);
    return mine ? { ...entry, control: { action: mine.ask.action, lane: mine.ask.lane ?? null, status: mine.status } } : entry;
  });
}

/** One lane M can move a job to. `blocked` is why the server would refuse it; such a lane is listed and cannot be chosen. */
export interface MoveLane { lane: string; blocked: 'held' | 'full' | null; text: string }

/** Every lane but the one the job is on, in the fleet read's order, with what each is running. Held and full are the rule the conversation's Move applies. */
export function moveLanes(lanes: FleetRuns['lanes'], from: string): MoveLane[] {
  return lanes.filter(row => row.lane !== from).map(row => {
    const blocked = row.held ? 'held' : row.running >= row.target ? 'full' : null;
    const waiting = row.queued > 0 ? `, ${row.queued} waiting` : '';
    return { lane: row.lane, blocked, text: `${blocked === 'held' ? 'held, ' : ''}${row.running} of ${row.target} running${waiting}${blocked === 'full' ? ', no free slot' : ''}` };
  });
}
