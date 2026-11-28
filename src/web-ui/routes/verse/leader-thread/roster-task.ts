/**
 * What each session on the Leader pane's "Working now" strip was asked to do.
 *
 * The strip's own list (fleet.live-sessions.v1) names a session and quotes the
 * last thing it said, but not its task. The task is the `task` key of the
 * read the Conversations pane already makes (fleet.session-threads.v1,
 * session-wall-model.ts): one line quoted from the job's brief, never written
 * by a model. This module asks that same read, under the same cache key, so a
 * pane that has it open shares the request.
 *
 * A task does not change while a job runs, so the strip asks far less often
 * than the wall does; a session that has just started gets its line on the
 * next ask. A read that fails, a server that sends no `task`, and a session
 * the read left out all give no entry, and the row then shows what it showed
 * before: nothing is guessed from the job id or the last message.
 */
import { useMemo } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { ThreadTask } from '../fleet-sessions/session-thread-model.js';
import { sessionWallQuery, type SessionWallRead } from '../session-wall/session-wall-model.js';
import { taskName } from '../session-wall/WallTask.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

/** How often the strip re-asks while it is on screen. */
export const ROSTER_TASK_POLL_MS = 30_000;

/** By session id. Null: the read says it knows no line. No entry: the read does not say. */
export type RosterTasks = ReadonlyMap<string, ThreadTask | null>;

const NONE: RosterTasks = new Map();

export function rosterTasks(read: SessionWallRead | null | undefined): RosterTasks {
  if (!read) return NONE;
  const tasks = new Map<string, ThreadTask | null>();
  for (const entry of read.entries) if (entry.task !== undefined) tasks.set(entry.session.id, entry.task);
  return tasks;
}

/** "Task: Fix the flaky test" or "Brief opens: You are…": the line with the name that says how far to trust it. */
export function rosterTaskWords(task: ThreadTask): string {
  return `${taskName(task)}: ${task.line}`;
}

/** The tasks of the sessions the Conversations read holds. Keeps the last good read when a later one fails. */
export function useRosterTasks(visible: boolean): RosterTasks {
  const read = useQuery(sessionWallQuery, { enabled: visible, freshMs: ROSTER_TASK_POLL_MS });
  const refetch = useRefetch(sessionWallQuery);
  usePollWhileVisible(refetch, ROSTER_TASK_POLL_MS, { enabled: visible });
  return useMemo(() => rosterTasks(read.data), [read.data]);
}
