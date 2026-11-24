/**
 * What a session's job was asked to do, as one line (`task` on
 * `fleet.session-thread.v1` and on each entry of `fleet.session-threads.v1`).
 *
 * Pure, and no source of its own: the line is quoted from the job's brief
 * (the prompt the activity read already carries, scrubbed). Two things the
 * fleet itself writes in front of a task are set aside, because they are the
 * same on every job and say nothing of this one:
 *
 * - the fleet view the dispatcher prepends, `## CONTEXT` to `## END CONTEXT`
 *   (the block lane-capabilities.ts also sets aside);
 * - the router's envelope, `Job <id> (pool …, tier …, repo …). Task from the
 *   Ashlr router queue, verbatim:` followed by the queue row
 *   `<id> (<attrs>): <task>` (the shape rebase-plan.ts `jobPrompt` writes).
 *
 * Nothing is summarised or reworded. A brief that opens with a markdown
 * heading has a title; a queue row gives the task the queue held; any other
 * brief gives only its opening line, and `from` says which, so a reader never
 * takes an opening sentence for a title. A brief that cannot be read past the
 * fleet view gives no task at all rather than a line of the roster.
 */
import type { FleetJobActivityV1 } from './runs-job-activity.js';

/** The longest task line; a longer one is cut and marked `truncated`. */
export const TASK_LINE_CHARS = 160;

/** Where the line was found: the brief's `title` (a markdown heading), the router `queue` row it quotes, or only its `opening` line. */
export type SessionTaskFrom = 'title' | 'queue' | 'opening';
export const SESSION_TASK_FROM: readonly SessionTaskFrom[] = ['title', 'queue', 'opening'];

export interface SessionThreadTask {
  /** The line, heading marks and the queue row's own prefix removed, cut to TASK_LINE_CHARS. Never empty. */
  line: string;
  /** `title` and `queue` are the task as its author stated it; `opening` is only the first line of a brief that states none. */
  from: SessionTaskFrom;
  /** True when the line was cut to fit. */
  truncated: boolean;
}

const CONTEXT_OPENS = /^\s*## CONTEXT\b/;
const CONTEXT_ENDS = /^## END CONTEXT\b.*$/m;
const ROUTER_ENVELOPE = /^Job (\S+) \(.*\)\. Task from the Ashlr router queue, verbatim:$/;
const DEPENDENCY_GATE = /^DEPENDENCY GATE: /;

/**
 * A brief without the fleet view the dispatcher put in front of it. The text itself when it opens with none.
 * Null when the view opens and never closes (the brief was cut inside it), so what follows is not known.
 */
export function briefPastContext(text: string): string | null {
  if (!CONTEXT_OPENS.test(text)) return text;
  const end = CONTEXT_ENDS.exec(text);
  return end ? text.slice(end.index + end[0].length) : null;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The task of the job behind `activity`, or null: no activity read, no readable brief, a brief cut inside its fleet
 * view, or nothing written after it. `jobId` only removes the job's own id from the end of a title ("… (RQ-FIX-1)"),
 * which the session's row already shows.
 */
export function sessionTask(activity: FleetJobActivityV1 | null | undefined, jobId: string | null = null): SessionThreadTask | null {
  const brief = activity?.entries.find(entry => entry.kind === 'report' && entry.name === 'brief');
  if (brief?.kind !== 'report' || brief.state !== 'ok') return null;
  const written = briefPastContext(brief.text)?.split('\n').map(line => line.trim()).filter(line => line !== '') ?? [];
  let first = written[0], from: SessionTaskFrom = 'opening';
  if (first === undefined) return null;
  const envelope = ROUTER_ENVELOPE.exec(first);
  // The row the envelope quotes; a dependency gate may stand between them. Without a row the envelope is all the brief opens with.
  const row = envelope ? written.slice(1).find(line => !DEPENDENCY_GATE.test(line)) : undefined;
  if (envelope && row !== undefined) {
    const asked = new RegExp(`^${escaped(envelope[1]!)} \\(.*?\\): (.+)$`).exec(row);
    first = asked ? asked[1]! : row;
    if (asked) from = 'queue';
  }
  const heading = from === 'opening' ? /^#{1,6}\s+(.*?)(?:\s+#+)?$/.exec(first) : null;
  if (heading) from = 'title';
  let line = (heading ? heading[1]! : first).replace(/\s+/g, ' ').trim();
  if (heading && jobId) line = line.replace(new RegExp(`\\s*\\(${escaped(jobId)}\\)$`), '');
  if (line === '') return null;
  const truncated = line.length > TASK_LINE_CHARS;
  return { line: truncated ? `${line.slice(0, TASK_LINE_CHARS - 1).trimEnd()}…` : line, from, truncated };
}

/** The task as `phm sessions thread` and `phm sessions threads` print it: a title or a queue row is the task, any other line is only how the brief opens. */
export function taskWords(task: SessionThreadTask): string {
  return `${task.from === 'opening' ? 'Brief opens' : 'Task'}: ${task.line}`;
}
