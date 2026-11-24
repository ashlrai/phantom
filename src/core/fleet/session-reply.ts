/**
 * Where words written to one agent session go: the `reply` field of
 * `fleet.session-thread.v1` (session-thread.ts). No route reaches a worker
 * directly. A message is written to the Leader inbox, aimed with `@<job>` so
 * the Leader knows which session is meant, and only a session that is still
 * running can be steered. Pure and import-free, so the desktop applies the
 * same rule to a body from a server that predates the field.
 */

export interface SessionThreadReply {
  /** `leader`: the Leader inbox as it is. `job`: the Leader inbox with `mention` in front. `none`: nothing can be sent. */
  to: 'leader' | 'job' | 'none';
  /** `@<job id>` when `to` is `job`, otherwise null. */
  mention: string | null;
  /** One sentence: where a message goes, or why none can be sent. */
  hint: string;
}

/** What the rule reads of a session. `state` is the thread's own (`quiet` is a running session with no recent output). */
export interface SessionReplySubject { kind: string; jobId: string | null; state: string }

/** The job ids the inbox mention syntax can name (`@RQ-...`, the one the steer box parses). */
export const AIMABLE_JOB_RE = /^RQ-[A-Z0-9-]+$/;
const LEADER_CHAT = 'Write to the Leader in the Leader chat.';

/** The Leader inbox for the leader, the inbox aimed `@<job>` for a running or quiet worker, nowhere otherwise. */
export function sessionReply(session: SessionReplySubject | null): SessionThreadReply {
  if (!session) return { to: 'none', mention: null, hint: `There is no session to write to. ${LEADER_CHAT}` };
  if (session.kind === 'leader') return { to: 'leader', mention: null, hint: 'Goes to the Leader\'s inbox, the same as the Leader chat.' };
  if (session.state !== 'running' && session.state !== 'quiet') return { to: 'none', mention: null, hint: `This session is not running, so there is nothing to steer. ${LEADER_CHAT}` };
  if (session.jobId === null || !AIMABLE_JOB_RE.test(session.jobId)) return { to: 'none', mention: null, hint: `This session has no job id a message can be aimed at. ${LEADER_CHAT}` };
  return { to: 'job', mention: `@${session.jobId}`, hint: `Goes to the Leader's inbox with @${session.jobId} in front, so the Leader knows which session you mean.` };
}
