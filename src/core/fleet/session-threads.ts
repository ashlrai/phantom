/**
 * Every agent session as a short conversation, in one read
 * (`fleet.session-threads.v1`): behind `phm sessions threads` and GET
 * /api/verse/fleet/control/session-threads.
 *
 * Pure, and no source of its own. Each entry is the same thread
 * `phm sessions thread <id>` builds (session-thread.ts), cut down to its
 * summary and newest messages (what Mason wrote to it, where the Leader
 * routed it, what was asked of its job and the last lines a running session
 * wrote included), plus the pause, resume, stop or move that stands for its
 * job (`control`), the message of Mason's its job serves (`serves`) and what its
 * job has done as numbers (`work`), so a screen
 * that shows every session at once makes one request instead of one per
 * session. Sessions come in the order of the session tree: the leader, then
 * each worker followed by its helpers. The reader lives in
 * session-threads-read.ts.
 */
import type { AgentMessages } from './agent-messages.js';
import { ownerDisplayName } from '../owner-display.js';
import type { JobControlLedgerRow } from './job-control-types.js';
import { flatTree, type LiveSessionsV1 } from './live-sessions.js';
import type { LeaderRepliesV1 } from './mason-outbox.js';
import type { OrderTraceV1 } from './order-trace.js';
import type { FleetJobActivityV1 } from './runs-job-activity.js';
import type { SessionThreadReply } from './session-reply.js';
import { briefPastContext, taskWords, type SessionThreadTask } from './session-task.js';
import {
  buildSessionThread, sessionWork, type SessionThreadControl, type SessionThreadMessage, type SessionThreadOutputRead, type SessionThreadOwnerRead, type SessionThreadSession, type SessionThreadSource,
  type SessionThreadState, type SessionThreadV1, type SessionThreadWork,
} from './session-thread.js';

export const SESSION_THREADS_SCHEMA = 'fleet.session-threads.v1';
/** The most sessions one read holds, the newest messages each one carries, and the longest message text. */
export const THREADS_MAX = 40, THREADS_MESSAGES_SHOWN = 3, THREADS_TEXT_CHARS = 400;
/** The newest lines of a session's own output a short thread carries. */
export const THREADS_OUTPUT_LINES = 3;
/** `counts.states` keys, in the order they print. */
export const THREAD_STATES: readonly SessionThreadState[] = ['running', 'quiet', 'idle', 'done', 'failed', 'unknown'];

/**
 * Key order is the JSON contract. A thread message, with `truncated` true when `text` was cut to THREADS_TEXT_CHARS.
 * An `output` message keeps its newest THREADS_OUTPUT_LINES lines, cut from the front, since the end of a log is the news.
 */
export interface SessionThreadsMessage extends SessionThreadMessage { truncated: boolean }
/** The message of Mason's a session's job serves: a job serves a message when its prompt cites it (the order trace). */
export interface SessionThreadsServes {
  /** The same for every session serving the same message, so a screen of every session can put them together. */
  key: string;
  /** The message's time as the inbox wrote it: Eastern wall time to the minute. */
  at: string;
  source: string;
  /** Mason's words, cut to THREADS_TEXT_CHARS (`truncated`); null when the message is not among the inbox entries this read holds. */
  text: string | null;
  truncated: boolean;
  /** Every job the trace ties to the message, whether or not this read shows its session. */
  jobs: number;
}
/**
 * What a session's job has done, as the values behind the summary's own sentences ("3 commands seen, 2 files changed",
 * "Latest step: …"), so a screen can draw them without reading prose. Nothing here is a new measurement.
 */
/** The single thread's `work` (session-thread.ts), carried on each entry here under the name it first had. */
export type SessionThreadsWork = SessionThreadWork;
export interface SessionThreadsEntry {
  session: SessionThreadSession;
  /** The same sentences `phm sessions thread <id>` prints. */
  summary: string[];
  /** What the session's job was asked to do, the answer its single thread gives (session-task.ts). Null when no brief line is known. */
  task: SessionThreadTask | null;
  /** The newest THREADS_MESSAGES_SHOWN messages of the thread, oldest of them first. A `brief` message starts past its fleet view, and its label says so. */
  messages: SessionThreadsMessage[];
  /** How many messages the whole thread holds. */
  messageCount: number;
  sources: SessionThreadV1['sources'];
  gaps: string[];
  /**
   * The pause, resume, stop or move that stands for this session's job, the answer its single thread gives, so a screen of every
   * session can mark a paused one without a second read. Null when none stands, for a session with no job, and when the control
   * file was not read: `sources.controls` tells those apart.
   */
  control: SessionThreadControl | null;
  /** Where words written to this session go, the answer its single thread gives, so a screen of every session can offer a reply without a second read. */
  reply: SessionThreadReply;
  /**
   * The newest message of Mason's this session's job serves. Null for the leader, a helper and a worker
   * without a job, when no prompt of the job cites a message, and when the trace was not read: `sources.orders` tells those apart.
   */
  serves: SessionThreadsServes | null;
  /**
   * What the session's job has done; the entry's last key. Null for a session with no job, a job whose activity was not asked
   * for, and a failed activity read: `sources.activity` tells those apart.
   */
  work: SessionThreadsWork | null;
}
export interface SessionThreadsV1 {
  schema: typeof SESSION_THREADS_SCHEMA;
  generatedAt: string;
  filter: { lane: string | null; repo: string | null; live: boolean };
  /**
   * `sessions` counts every session in the list; `shown` the ones in `threads`; `states` only those shown. `unshown` counts the
   * ones the read left out because it holds THREADS_MAX, by what the list says of each: every one is 0 when nothing was left out.
   */
  counts: { sessions: number; shown: number; states: Record<SessionThreadState, number>; unshown: SessionsLeftOut };
  threads: SessionThreadsEntry[];
  /** `unavailable` sessions means the list could not be read: `threads` is empty and that is not "no sessions". */
  sources: { sessions: 'available' | 'unavailable'; bus: SessionThreadSource; owner: SessionThreadSource; replies: SessionThreadSource; orders: SessionThreadSource; controls: SessionThreadSource };
  /** Plain words for what the whole read could not show. Each thread lists its own. */
  gaps: string[];
}

/** What the reader hands the builder. */
export interface SessionThreadsParts {
  ownerName?: string;
  /** False when the session list itself could not be read. */
  sessionsRead: boolean;
  /** Null when the read failed. */
  bus: AgentMessages | null;
  /** Recorded activity by job id. A job with no key was not asked for; null means its read failed. */
  activity: ReadonlyMap<string, FleetJobActivityV1 | null>;
  /** The leader's replies. Undefined when not asked for; null when the read failed. */
  replies?: LeaderRepliesV1 | null;
  /** The Leader inbox, newest first, shared by the leader's and every worker's thread. Undefined when not asked for; null when the read failed. */
  owner?: SessionThreadOwnerRead | null;
  /** The order trace, shared by the leader's thread and every worker's that has a job. Undefined when not asked for; null when the read failed. */
  orders?: OrderTraceV1 | null;
  /** The end of each running job's log, by job id. A job with no key was not asked for; null means its read failed. */
  output?: ReadonlyMap<string, SessionThreadOutputRead | null>;
  /** The job control file, oldest first, shared by every session with a job. Undefined when not asked for; null when the read failed. */
  controls?: readonly JobControlLedgerRow[] | null;
}

/** Sessions a bounded read left out, by the list's own state: `ended` is done or failed, `unknown` is every other state that is not running. */
export interface SessionsLeftOut { running: number; ended: number; unknown: number }
type ListedNode = ReturnType<typeof flatTree>[number]['node'];
/** Lower is kept first: the leader, running sessions, ones whose state is not known to have ended, failed ones, finished ones. */
const keepRank = (node: ListedNode) => (node.kind === 'leader' ? 0 : node.state === 'running' ? 1 : node.state === 'failed' ? 3 : node.state === 'done' ? 4 : 2);
const spokeAt = (node: ListedNode) => { const at = node.lastMessageAt === null ? Number.NaN : Date.parse(node.lastMessageAt); return Number.isFinite(at) ? at : -Infinity; };

/**
 * The `max` sessions a bounded read keeps, in the order the list gave them, and a count of the ones it leaves out.
 * A list within `max` is kept whole. A longer one gives up its finished sessions first (the one that spoke longest
 * ago before a newer one), then its failed ones, so a running session is left out only when more than `max` are running.
 */
export function pickSessions<T extends ListedNode>(nodes: readonly T[], max: number): { kept: T[]; left: SessionsLeftOut } {
  const left: SessionsLeftOut = { running: 0, ended: 0, unknown: 0 };
  if (nodes.length <= max) return { kept: [...nodes], left };
  const ranked = nodes.map((node, index) => ({ node, index, rank: keepRank(node), spoke: spokeAt(node) }))
    .sort((a, b) => a.rank - b.rank || (a.rank >= 3 ? b.spoke - a.spoke : 0) || a.index - b.index);
  for (const { node } of ranked.slice(max)) left[node.state === 'running' ? 'running' : node.state === 'done' || node.state === 'failed' ? 'ended' : 'unknown'] += 1;
  return { kept: ranked.slice(0, max).sort((a, b) => a.index - b.index).map(entry => entry.node), left };
}

/** "3 running, 2 ended": what a bounded read left out, for the sentence that says so. Empty when nothing was. */
export function leftOutWords(left: SessionsLeftOut): string {
  return [left.running > 0 && `${left.running} running`, left.ended > 0 && `${left.ended} ended`, left.unknown > 0 && `${left.unknown} with state unknown`].filter(Boolean).join(', ');
}

/**
 * The sessions a threads read shows, in tree order, how many the list holds in all, and what was left out. `running` is the
 * tree's own state. Over THREADS_MAX, running sessions are kept before ended ones (`pickSessions`).
 */
export function threadSessions(list: LiveSessionsV1): { shown: { id: string; jobId: string | null; kind: string; running: boolean }[]; total: number; left: SessionsLeftOut } {
  const nodes = flatTree(list.tree.roots).map(entry => entry.node).filter(node => node.kind !== 'unknown-parent');
  const { kept, left } = pickSessions(nodes, THREADS_MAX);
  return { shown: kept.map(node => ({ id: node.id, jobId: node.jobId, kind: node.kind, running: node.state === 'running' })), total: nodes.length, left };
}

function clipped(message: SessionThreadMessage): SessionThreadsMessage {
  if (message.kind === 'output') {
    const lines = message.text.split('\n'), newest = lines.slice(-THREADS_OUTPUT_LINES).join('\n'), long = newest.length > THREADS_TEXT_CHARS;
    const fewer = lines.length > THREADS_OUTPUT_LINES;
    // The label counts the lines carried here, not the ones the single thread shows.
    return { ...message, label: fewer ? `${message.label.slice(0, message.label.lastIndexOf(','))}, last ${THREADS_OUTPUT_LINES} lines of its log` : message.label,
      text: long ? `…${newest.slice(1 - THREADS_TEXT_CHARS).trimStart()}` : newest, truncated: long || fewer };
  }
  if (message.kind === 'brief') {
    // The fleet view in front of a brief is the same roster on every card; the room goes to what was asked.
    const past = briefPastContext(message.text)?.trim();
    if (past !== undefined && past !== '' && past.length < message.text.trim().length) {
      const long = past.length > THREADS_TEXT_CHARS;
      return { ...message, label: `${message.label}, after its fleet view`, text: long ? `${past.slice(0, THREADS_TEXT_CHARS - 1).trimEnd()}…` : past, truncated: true };
    }
  }
  const cut = message.text.length > THREADS_TEXT_CHARS;
  return { ...message, text: cut ? `${message.text.slice(0, THREADS_TEXT_CHARS - 1).trimEnd()}…` : message.text, truncated: cut };
}

/** The thread's last `order` message is the newest message its job serves; the trace, newest first, names that message's time and jobs. */
function servedBy(messages: readonly SessionThreadMessage[], jobId: string | null, trace: OrderTraceV1 | null | undefined): SessionThreadsServes | null {
  const cited = messages.filter(message => message.kind === 'order').at(-1);
  const order = jobId === null ? undefined : trace?.orders.find(candidate => candidate.jobs.some(job => job.id === jobId));
  if (!cited || !order) return null;
  // A `record` order is the thread saying it does not hold the words, so there are none to carry.
  const said = cited.side === 'other' ? clipped(cited) : null;
  return { key: cited.key.slice('order:'.length), at: order.at, source: order.source, text: said?.text ?? null, truncated: said?.truncated ?? false, jobs: order.jobs.length };
}

/** `sessionWork` (session-thread.ts) under the name it first had: an entry and its single thread give the same answer. */
export const workOf = sessionWork;

/** Every session in `list` as a short thread. An unreadable list gives no threads and says so; it never reads as an empty fleet. */
export function buildSessionThreads(list: LiveSessionsV1, parts: SessionThreadsParts, now: number): SessionThreadsV1 {
  const states = Object.fromEntries(THREAD_STATES.map(state => [state, 0])) as Record<SessionThreadState, number>;
  const base = { schema: SESSION_THREADS_SCHEMA, generatedAt: new Date(now).toISOString(),
    filter: { lane: list.filter.lane, repo: list.filter.repo, live: list.live } } as const;
  if (!parts.sessionsRead) {
    return { ...base, counts: { sessions: 0, shown: 0, states, unshown: { running: 0, ended: 0, unknown: 0 } }, threads: [], sources: { sessions: 'unavailable', bus: 'none', owner: 'none', replies: 'none', orders: 'none', controls: 'none' },
      gaps: ['Sessions unknown: the session list could not be read.'] };
  }
  const { shown, total, left } = threadSessions(list);
  const threads: SessionThreadsEntry[] = [];
  for (const { id, jobId, kind } of shown) {
    // A helper is never named in the Leader inbox, so it gets no inbox, as in the single thread's reader.
    const thread = buildSessionThread(list, id, { sessionsRead: true, bus: parts.bus, ownerName: parts.ownerName,
      ...(jobId !== null && parts.activity.has(jobId) ? { activity: parts.activity.get(jobId) } : {}),
      ...(jobId !== null && parts.output?.has(jobId) ? { output: parts.output.get(jobId) } : {}),
      ...(jobId !== null && parts.controls !== undefined ? { controls: parts.controls } : {}),
      ...(kind !== 'subagent' && parts.owner !== undefined ? { owner: parts.owner } : {}),
      ...(kind === 'leader' && parts.replies !== undefined ? { replies: parts.replies } : {}),
      // Routing goes to the same sessions the single thread's reader gives it to: the leader and a worker with a job.
      ...((kind === 'leader' || (kind === 'worker' && jobId !== null)) && parts.orders !== undefined ? { orders: parts.orders } : {}) }, now);
    if (!thread.session) continue;
    states[thread.session.state] += 1;
    threads.push({ session: thread.session, summary: thread.summary, task: thread.task, messages: thread.messages.slice(-THREADS_MESSAGES_SHOWN).map(clipped),
      messageCount: thread.messages.length, sources: thread.sources, gaps: thread.gaps, control: thread.control, reply: thread.reply,
      serves: kind === 'worker' ? servedBy(thread.messages, jobId, parts.orders) : null,
      work: jobId !== null ? workOf(parts.activity.get(jobId)) : null });
  }
  const gaps = [...list.gaps];
  if (total > shown.length) gaps.push(`${total - shown.length} more session${total - shown.length === 1 ? '' : 's'} not shown (${leftOutWords(left)}): the read holds ${THREADS_MAX}, running sessions first. Narrow it with a lane or repo, or ask for running ones only.`);
  const busDown = parts.bus === null || parts.bus.source === 'unavailable';
  if (busDown) gaps.push('Bus messages unknown: the agent bus could not be read.');
  const ownerDown = parts.owner === null || parts.owner?.sourceState === 'degraded';
  if (ownerDown) gaps.push(`Messages from ${ownerDisplayName(parts.ownerName)} unknown: the Leader inbox could not be read.`);
  const repliesDown = parts.replies === null || parts.replies?.sourceState === 'unknown';
  const ordersDown = parts.orders === null || parts.orders?.sources.inbox === 'degraded';
  if (ordersDown) gaps.push('Routing unknown: the order trace could not be read.');
  const controlsDown = parts.controls === null;
  if (controlsDown) gaps.push('Controls unknown: the job control record could not be read.');
  const source = (name: 'bus' | 'owner' | 'replies' | 'orders' | 'controls', down: boolean): SessionThreadSource =>
    (down ? 'unavailable' : threads.some(entry => entry.sources[name] === 'available') ? 'available' : 'none');
  return { ...base, counts: { sessions: total, shown: threads.length, states, unshown: left }, threads,
    sources: { sessions: 'available', bus: source('bus', busDown), owner: source('owner', ownerDown), replies: source('replies', repliesDown), orders: source('orders', ordersDown),
      controls: source('controls', controlsDown) }, gaps };
}

const SIDE_MARK: Readonly<Record<SessionThreadMessage['side'], string>> = { session: '<', other: '>', record: '-' };
const oneLine = (text: string, max: number) => { const flat = text.replace(/\s+/g, ' ').trim(); return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat; };

/**
 * `phm sessions threads` for people: a count line, then one block per session with its summary and newest messages,
 * each on one line. `>` is said to the session, `<` is the session, `-` is a recorded step.
 */
export function renderSessionThreadsText(read: SessionThreadsV1): string {
  if (read.sources.sessions === 'unavailable') return read.gaps.join('\n');
  const scope = [read.filter.lane && `lane ${read.filter.lane}`, read.filter.repo && `repo ${read.filter.repo}`, read.filter.live && 'running only'].filter(Boolean).join(', ');
  const by = THREAD_STATES.filter(state => read.counts.states[state] > 0).map(state => `${read.counts.states[state]} ${state === 'unknown' ? 'state unknown' : state}`).join(', ');
  const lines = [read.counts.sessions === 0 ? `No sessions${scope ? ` (${scope})` : ''}.`
    : `${read.counts.sessions} session${read.counts.sessions === 1 ? '' : 's'}${scope ? ` (${scope})` : ''}${by ? `: ${by}` : ''}.`];
  for (const entry of read.threads) {
    const { session } = entry;
    lines.push('', `${session.id} | ${session.kind} | ${session.state === 'unknown' ? 'state unknown' : session.state}`,
      ...(entry.task ? [`  ${taskWords(entry.task)}`] : []), `  ${entry.summary.join(' ')}`);
    if (entry.messageCount > entry.messages.length) lines.push(`  (${entry.messageCount - entry.messages.length} earlier)`);
    for (const message of entry.messages) lines.push(`  ${SIDE_MARK[message.side]} ${message.label}${message.at ? ` [${message.at}]` : ''}: ${oneLine(message.text, 160)}`);
    if (entry.messageCount === 0) lines.push('  Nothing is recorded for this session yet.');
  }
  if (read.gaps.length > 0) lines.push('');
  for (const gap of read.gaps) lines.push(`note: ${gap}`);
  lines.push('', `Open one: phm sessions thread <id>. Updated ${read.generatedAt}.`);
  return lines.join('\n');
}
