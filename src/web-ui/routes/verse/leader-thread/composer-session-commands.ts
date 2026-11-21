/**
 * routes/verse/leader-thread/composer-session-commands.ts: the Leader reply
 * box's session commands. `/who` lists the agents working right now, `/thread
 * <session>` opens one as a conversation, `/summary <session>` prints what it
 * is doing without leaving the chat, and `/log <job-id>` opens its live log.
 *
 * They read what the Sessions and Conversations panes read (the live-sessions
 * list and one session's thread) and write nothing, so they need no token and
 * post no inbox note. Nothing is invented: a list that does not answer reads
 * "unknown" with the reason, and `/thread` on a name the list does not hold
 * opens nothing. Like the other commands, they never throw.
 */
import { flatTree, sessionAge, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { SessionNode } from '../../../../core/fleet/session-tree.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { sessionThreadQuery, STATE_WORD, threadFailure, type SessionThread } from '../fleet-sessions/session-thread-model.js';
import { liveSessionsQuery } from '../fleet-sessions/sessions-model.js';
import { sessionArg, type ComposerCommandName } from './composer-commands.js';
import { openConversationFromLeader, type ReadingPlace } from './leader-reading.js';
import { rosterHeadline, rosterRows } from './leader-roster-model.js';

export type SessionCommandName = Extract<ComposerCommandName, 'who' | 'thread' | 'summary' | 'log'>;

const SESSION_COMMANDS: readonly string[] = ['who', 'thread', 'summary', 'log'] satisfies SessionCommandName[];

export function isSessionCommand(name: ComposerCommandName): name is SessionCommandName {
  return SESSION_COMMANDS.includes(name);
}

export interface SessionCommandDeps {
  /** The live-sessions list; null when the answer is not one. */
  sessions: () => Promise<LiveSessionsV1 | null>;
  /** One session as a conversation; null when the answer is not one. */
  thread: (id: string) => Promise<SessionThread | null>;
  /** Opens the session as a conversation; may say where, so the answer can (`leader`: in the Leader pane itself). */
  openConversation: (id: string) => ReadingPlace | void;
  openLog: (job: string) => void;
}

export const liveSessionDeps: SessionCommandDeps = {
  sessions: () => liveSessionsQuery.fetch(),
  thread: id => sessionThreadQuery(id).fetch(),
  openConversation: openConversationFromLeader,
  openLog: job => { requestWorkerLogJob(job); openDockPane('worker-log'); },
};

/** Sessions named in a `/who` line; the rest are counted. */
export const WHO_LIMIT = 8;
/** Summary lines printed by `/summary`; the rest are counted. */
export const SUMMARY_LINES = 6;

const laneWords = (lane: string): string => (lane === 'unknown' ? 'lane unknown' : lane);

/** "3 working now · 1 quiet: RQ-QUIET (claude, quiet 14m) · RQ-A (claude, spoke 2m ago) …", quiet ones first, as the strip orders them. */
export function whoLine(list: LiveSessionsV1): string {
  const rows = rosterRows(list);
  const headline = rosterHeadline(rows, list);
  if (rows.length === 0) return `${headline}.`;
  const shown = rows.slice(0, WHO_LIMIT).map(row => `${row.id} (${laneWords(row.lane)}, ${row.when})`);
  const more = rows.length - shown.length;
  return `${headline}: ${shown.join(' · ')}${more > 0 ? ` · and ${more} more in Conversations` : ''}. /thread <session> opens one.`;
}

/** The session a typed name means: its own id first, then the job it runs. */
export function namedSession(list: LiveSessionsV1, id: string): SessionNode | null {
  const nodes = flatTree(list.tree.roots).map(({ node }) => node);
  return nodes.find(node => node.id === id) ?? nodes.find(node => node.jobId === id) ?? null;
}

/** "RQ-A: running, claude, fixture-model, last spoke 2m ago. <its summary>" from the thread the Conversations pane opens. */
export function summaryLine(id: string, thread: SessionThread): string {
  const { session, summary } = thread;
  const spoke = session.lastMessageAgeSeconds === null ? 'last spoke unknown' : `last spoke ${sessionAge(session.lastMessageAgeSeconds)} ago`;
  const head = [STATE_WORD[session.state], laneWords(session.lane), ...(session.model === 'unknown' ? [] : [session.model]), spoke].join(', ');
  const more = summary.length - SUMMARY_LINES;
  const body = summary.length === 0 ? 'No summary is recorded for it.'
    : `${summary.slice(0, SUMMARY_LINES).join(' ')}${more > 0 ? ` (${more} more ${more === 1 ? 'line' : 'lines'}: /thread ${id})` : ''}`;
  return `${id}: ${head}. ${body}`;
}

async function who(deps: SessionCommandDeps): Promise<string> {
  try {
    const list = await deps.sessions();
    return list ? whoLine(list) : 'Working sessions are unknown: this server did not return a session list.';
  } catch (error) {
    return `Working sessions are unknown. ${readFailureReason(error)}`;
  }
}

async function thread(id: string, deps: SessionCommandDeps): Promise<string> {
  let list: LiveSessionsV1 | null = null;
  try { list = await deps.sessions(); } catch { /* opened unchecked below */ }
  if (list === null) {
    // The conversation makes its own read and says so when it cannot find the session.
    const place = deps.openConversation(id);
    return `Opened ${id} ${place === 'leader' ? 'here' : 'in Conversations'}. The session list did not answer, so the name is unchecked.`;
  }
  const node = namedSession(list, id);
  if (node === null) return `No session named ${id} is in the session list, so nothing was opened. /who lists the ones working now.`;
  const place = deps.openConversation(node.id);
  return `Opened the conversation with ${node.jobId ?? node.id} (${STATE_WORD[node.state]}, ${laneWords(node.lane)}).${place === 'leader' ? ' Esc in it comes back here.' : ''}`;
}

async function summary(id: string, deps: SessionCommandDeps): Promise<string> {
  try {
    const read = await deps.thread(id);
    return read ? summaryLine(id, read) : `What ${id} is doing is unknown: this server did not return its conversation.`;
  } catch (error) {
    // A 404 carries the route's own sentence (no such session, or a server without the route).
    if (error instanceof ApiError && error.status === 404) return threadFailure(error).text;
    return `What ${id} is doing is unknown. ${error instanceof ApiError && error.status === 503 ? 'The session list could not be read just now.' : readFailureReason(error)}`;
  }
}

/** Runs one session command and returns the line the conversation shows. The argument was checked by commandArgError. */
export async function runSessionCommand(command: { name: SessionCommandName; arg: string }, deps: SessionCommandDeps): Promise<string> {
  if (command.name === 'who') return who(deps);
  const id = sessionArg(command.arg)!;
  if (command.name === 'thread') return thread(id, deps);
  if (command.name === 'summary') return summary(id, deps);
  deps.openLog(id);
  return `Opened the live log for ${id}.`;
}
