/**
 * One agent session as a conversation (`fleet.session-thread.v1`): a short
 * summary, then what was said to it and what it said and did, behind
 * `phm sessions thread <id>` and GET /api/verse/fleet/control/session-thread.
 *
 * Pure: it only joins reads the fleet already has. The session's row comes from
 * `fleet.live-sessions.v1`, its brief, recorded steps, commands, changed files
 * and notes from `fleet.job.activity.v1`, the messages about it from the agent
 * bus (`agent-messages.v1`), and the leader's replies from `leader.replies.v1`.
 * The summary is assembled from those records, never written by a model, and a
 * fact no record holds reads "unknown". The reader lives in
 * session-thread-read.ts.
 */
import type { AgentMessage, AgentMessages } from './agent-messages.js';
import { flatTree, sessionAge, spoke, type LiveSessionRow, type LiveSessionsV1 } from './live-sessions.js';
import type { LeaderRepliesV1 } from './mason-outbox.js';
import type { FleetJobActivityV1 } from './runs-job-activity.js';
import type { SessionKind, SessionNode, SessionState } from './session-tree.js';

export const SESSION_THREAD_SCHEMA = 'fleet.session-thread.v1';
/** Session ids: `leader`, a job id such as `RQ-FIX-1`, or a subagent id such as `sa-0123abcd`. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The newest bus messages, commands, changed files and leader replies a thread shows. */
export const THREAD_BUS_SHOWN = 50, THREAD_COMMANDS_SHOWN = 8, THREAD_FILES_SHOWN = 6, THREAD_REPLIES_SHOWN = 5;

/** `quiet` is a running session with no output for the list's quiet window. */
export type SessionThreadState = 'quiet' | SessionState;
export type SessionThreadSource = 'available' | 'none' | 'unavailable';

/** Key order is the JSON contract. */
export interface SessionThreadMessage {
  /** Stable inside one thread: `brief`, `step:<n>`, `commands`, `files`, `notes`, `bus:<id>`, `reply:<n>`, `latest`. */
  key: string;
  kind: 'brief' | 'step' | 'commands' | 'files' | 'notes' | 'bus' | 'reply' | 'latest';
  /** `session` is this session speaking, `other` is someone speaking to it, `record` is a recorded step. */
  side: 'session' | 'other' | 'record';
  label: string;
  /** ISO time, or the leader reply's own heading time; null when the record carries none. */
  at: string | null;
  text: string;
  format: 'plain' | 'mono' | 'markdown';
}
export interface SessionThreadSession {
  id: string;
  kind: SessionKind;
  agent: string; lane: string; model: string; repo: string;
  jobId: string | null;
  /** The session it reports to; null for the leader. */
  parentId: string | null;
  state: SessionThreadState;
  startedAt: string | null;
  ageSeconds: number | null;
  lastMessageAt: string | null;
  lastMessageAgeSeconds: number | null;
  prUrl: string | null;
  /** The computer it runs on, or "unknown". */
  computer: string;
  helpers: { below: number; running: number; failed: number };
}
export interface SessionThreadV1 {
  schema: typeof SESSION_THREAD_SCHEMA;
  generatedAt: string;
  id: string;
  /** Null when the session list holds no session with this id (or could not be read: see `sources.sessions`). */
  session: SessionThreadSession | null;
  /** Short sentences assembled from the records. Empty when `session` is null. */
  summary: string[];
  /** The conversation in reading order: brief, recorded steps, commands, changed files, notes, bus messages, leader replies, the latest line. */
  messages: SessionThreadMessage[];
  /** `none` means the read answered and holds nothing for this session; `unavailable` means it could not be read. */
  sources: { sessions: 'available' | 'unavailable'; activity: SessionThreadSource; bus: SessionThreadSource; replies: SessionThreadSource };
  /** Plain words for every part the thread could not show. */
  gaps: string[];
}

/** What the reader hands the builder. `undefined` means "not asked for" (the session has no job, or is not the leader). */
export interface SessionThreadParts {
  /** False when the session list itself could not be read. */
  sessionsRead: boolean;
  /** Null when the read failed. */
  activity?: FleetJobActivityV1 | null;
  /** Null when the read failed. */
  bus: AgentMessages | null;
  /** Null when the read failed. */
  replies?: LeaderRepliesV1 | null;
}

const named = (word: string, value: string) => (value === 'unknown' ? `${word} unknown` : value);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const when = (at: string | null | undefined): string | null => (at && Number.isFinite(Date.parse(at)) ? at : null);

function sessionOf(node: SessionNode, row: LiveSessionRow | undefined): SessionThreadSession {
  return {
    id: node.id, kind: node.kind as SessionKind, agent: node.agent, lane: node.lane, model: node.model, repo: node.repo, jobId: node.jobId,
    parentId: node.kind === 'leader' ? null : node.parentId, state: node.state === 'running' && row?.quiet === true ? 'quiet' : node.state,
    startedAt: node.startedAt, ageSeconds: row?.ageSeconds ?? null, lastMessageAt: node.lastMessageAt, lastMessageAgeSeconds: node.lastMessageAgeSeconds,
    prUrl: row?.prUrl ?? null, computer: row?.computer ?? 'unknown', helpers: { ...node.counts },
  };
}

function summaryOf(session: SessionThreadSession, node: SessionNode, row: LiveSessionRow | undefined, activity: FleetJobActivityV1 | null | undefined): string[] {
  const kind = session.kind === 'subagent' ? 'Helper' : session.kind === 'leader' ? 'Leader' : 'Worker';
  const lines = [`${kind} on ${named('lane', session.lane)}, ${named('model', session.model)}, in ${named('repo', session.repo)}.`];
  const said = spoke(node), { state } = session;
  if (state === 'quiet') lines.push(`Quiet: no output for ${sessionAge(row?.lastOutputAgeSeconds ?? session.lastMessageAgeSeconds)}.`);
  else if (state === 'running') lines.push(`Running for ${sessionAge(session.ageSeconds)}; ${said}.`);
  else if (state === 'unknown') lines.push(`State unknown; ${said}.`);
  else lines.push(`${state[0]!.toUpperCase()}${state.slice(1)}; ${said}.`);
  if (session.helpers.below > 0) lines.push(`${session.helpers.running} of ${plural(session.helpers.below, 'helper')} running${session.helpers.failed ? `, ${session.helpers.failed} failed` : ''}.`);
  if (session.prUrl) lines.push(`Pull request: ${session.prUrl}`);
  if (activity) {
    const files = activity.entries.find(entry => entry.kind === 'files');
    const changed = !files || files.state === 'missing' ? 'changed files unknown'
      : `${plural(files.totals.files, 'file')} changed (+${files.totals.added} −${files.totals.removed})${files.state === 'degraded' ? ', partial' : ''}`;
    lines.push(`${activity.sources.commands === 'healthy' ? `${plural(activity.counts.commands, 'command')} seen` : 'Commands unknown'}, ${changed}.`);
    const last = activity.entries.filter(entry => entry.kind === 'event').at(-1);
    if (last) lines.push(`Latest step: ${[last.event, last.summary].filter(Boolean).join(' ')}${when(last.at) ? ` at ${last.at}` : ''}.`);
  }
  return lines;
}

/** The bus messages about one session, oldest first: the ones naming its job, or sent by or to it. */
export function sessionBusMessages(session: Pick<SessionThreadSession, 'id' | 'jobId'>, messages: readonly AgentMessage[]): AgentMessage[] {
  const id = session.id.toLowerCase();
  return messages.filter(m => (session.jobId !== null && m.job === session.jobId) || m.from.name.toLowerCase() === id || m.to.name.toLowerCase() === id)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function activityMessages(activity: FleetJobActivityV1): SessionThreadMessage[] {
  const { entries } = activity, out: SessionThreadMessage[] = [];
  const report = (name: 'brief' | 'notes') => {
    const entry = entries.find(e => e.kind === 'report' && e.name === name);
    return entry?.kind === 'report' && entry.state === 'ok' && entry.text !== '' ? entry : undefined;
  };
  const brief = report('brief'), notes = report('notes');
  if (brief) out.push({ key: 'brief', kind: 'brief', side: 'other', label: `Brief${brief.truncated ? ' (truncated)' : ''}`, at: null, text: brief.text, format: 'markdown' });
  let step = 0;
  for (const entry of entries) {
    if (entry.kind === 'event') out.push({ key: `step:${step++}`, kind: 'step', side: 'record', label: entry.event, at: when(entry.at), text: entry.summary, format: 'plain' });
  }
  const commands = entries.filter(entry => entry.kind === 'command');
  if (commands.length > 0) out.push({
    key: 'commands', kind: 'commands', side: 'session', at: null, format: 'mono',
    label: commands.length > THREAD_COMMANDS_SHOWN ? `Ran ${plural(commands.length, 'command')}, last ${THREAD_COMMANDS_SHOWN} shown` : `Ran ${plural(commands.length, 'command')}`,
    text: commands.slice(-THREAD_COMMANDS_SHOWN).map(command => command.text).join('\n'),
  });
  const files = entries.find(entry => entry.kind === 'files');
  if (files?.kind === 'files' && files.state !== 'missing' && files.totals.files > 0) out.push({
    key: 'files', kind: 'files', side: 'session', at: null, format: 'mono',
    label: `Changed ${plural(files.totals.files, 'file')}, +${files.totals.added} −${files.totals.removed}${files.state === 'degraded' ? ', partial' : ''}`,
    text: [...files.files.slice(0, THREAD_FILES_SHOWN).map(file => file.path),
      ...(files.totals.files > THREAD_FILES_SHOWN ? [`and ${files.totals.files - THREAD_FILES_SHOWN} more`] : [])].join('\n'),
  });
  if (notes) out.push({ key: 'notes', kind: 'notes', side: 'session', label: `Notes${notes.truncated ? ' (truncated)' : ''}`, at: null, text: notes.text, format: 'markdown' });
  return out;
}

/** The thread for session `id` in `list`. A session the list does not hold gives `session: null`, never an invented one. */
export function buildSessionThread(list: LiveSessionsV1, id: string, parts: SessionThreadParts, now: number): SessionThreadV1 {
  const node = flatTree(list.tree.roots).map(entry => entry.node).find(entry => entry.id === id && entry.kind !== 'unknown-parent');
  const base = { schema: SESSION_THREAD_SCHEMA, generatedAt: new Date(now).toISOString(), id } as const;
  if (!node) {
    return { ...base, session: null, summary: [], messages: [],
      sources: { sessions: parts.sessionsRead ? 'available' : 'unavailable', activity: 'none', bus: 'none', replies: 'none' },
      gaps: [parts.sessionsRead ? `No session ${id} in the list. Finished sessions stay for an hour.` : 'Sessions unknown: the session list could not be read.'] };
  }
  const row = node.jobId === null ? undefined : list.sessions.find(entry => entry.job === node.jobId);
  const session = sessionOf(node, row), leader = session.kind === 'leader';
  const gaps: string[] = [], messages: SessionThreadMessage[] = [];

  let activity: SessionThreadSource = 'none';
  if (parts.activity === null) { activity = 'unavailable'; gaps.push('Activity unknown: this session\'s recorded activity could not be read.'); }
  else if (parts.activity) {
    const recorded = activityMessages(parts.activity);
    messages.push(...recorded);
    activity = recorded.length > 0 ? 'available' : 'none';
    if (parts.activity.truncated) gaps.push('Older activity is outside the recorded window.');
  }

  let bus: SessionThreadSource = 'none';
  if (parts.bus === null || parts.bus.source === 'unavailable') { bus = 'unavailable'; gaps.push('Bus messages unknown: the agent bus could not be read.'); }
  else {
    const about = sessionBusMessages(session, parts.bus.messages);
    if (about.length > THREAD_BUS_SHOWN) gaps.push(`${plural(about.length - THREAD_BUS_SHOWN, 'earlier bus message')} not shown.`);
    for (const m of about.slice(-THREAD_BUS_SHOWN)) messages.push({
      key: `bus:${m.id}`, kind: 'bus', side: m.from.name.toLowerCase() === id.toLowerCase() ? 'session' : 'other',
      label: `${m.from.name} to ${m.to.name}, ${m.kind}`, at: when(m.ts), text: m.summary, format: 'plain',
    });
    if (about.length > 0) bus = 'available';
  }

  let replies: SessionThreadSource = 'none';
  if (leader) {
    if (parts.replies === null || parts.replies?.sourceState === 'unknown') { replies = 'unavailable'; gaps.push('Leader replies unknown: the plan log could not be read.'); }
    else if (parts.replies) {
      // Newest first in the read; a conversation reads oldest first.
      [...parts.replies.replies.slice(0, THREAD_REPLIES_SHOWN)].reverse().forEach((reply, index) => messages.push({
        key: `reply:${index}`, kind: 'reply', side: 'session', label: 'Leader to Mason', at: reply.at === 'unknown' || reply.at === '' ? null : reply.at, text: reply.text, format: 'plain',
      }));
      if (parts.replies.replies.length > 0) replies = 'available';
    }
  }

  if (node.lastMessage !== null) messages.push({ key: 'latest', kind: 'latest', side: 'session', label: 'Latest', at: when(node.lastMessageAt), text: node.lastMessage, format: 'plain' });
  if (session.jobId === null && !leader) gaps.push('This session has no job record: its steps, commands and changed files are not recorded.');
  return { ...base, session, summary: summaryOf(session, node, row, parts.activity), messages, sources: { sessions: 'available', activity, bus, replies }, gaps };
}

const SIDE_MARK: Readonly<Record<SessionThreadMessage['side'], string>> = { session: '<', other: '>', record: '-' };

/** `phm sessions thread <id>` for people: the summary, then one block per message. `>` is said to the session, `<` is the session, `-` is a recorded step. */
export function renderSessionThreadText(thread: SessionThreadV1): string {
  if (!thread.session) return thread.gaps.join('\n');
  const { session } = thread;
  const lines = [`${session.id} | ${session.kind} | ${session.state === 'unknown' ? 'state unknown' : session.state}`, ...thread.summary.map(line => `  ${line}`), ''];
  if (thread.messages.length === 0) lines.push('Nothing is recorded for this session yet.');
  for (const message of thread.messages) {
    lines.push(`${SIDE_MARK[message.side]} ${message.label}${message.at ? ` [${message.at}]` : ''}`);
    for (const line of message.text.split('\n')) lines.push(`    ${line}`);
  }
  if (thread.gaps.length > 0) lines.push('');
  for (const gap of thread.gaps) lines.push(`note: ${gap}`);
  lines.push(`${session.jobId === null ? '' : `Full log: phm sessions tail ${session.jobId}. `}Every session: phm sessions. Updated ${thread.generatedAt}.`);
  return lines.join('\n');
}
