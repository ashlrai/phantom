/**
 * One agent session as a conversation (`fleet.session-thread.v1`): a short
 * summary, then what was said to it and what it said and did, behind
 * `phm sessions thread <id>` and GET /api/verse/fleet/control/session-thread.
 *
 * Pure: it only joins reads the fleet already has. The session's row comes from
 * `fleet.live-sessions.v1`, its brief, recorded steps, commands, changed files
 * and notes from `fleet.job.activity.v1`, the messages about it from the agent
 * bus (`agent-messages.v1`), what Mason wrote from the Leader inbox
 * (`MASON-INBOX.md`), the leader's replies from `leader.replies.v1`, which
 * jobs serve which of Mason's messages from the order trace (`readOrderTrace`),
 * what the session itself wrote from the end of its job log (`scanJobLog`),
 * and the pause, resume, stop and move requests made of its job from the
 * control file (`readJobControlLedger`).
 * The summary is assembled from those records, never written by a model, and a
 * fact no record holds reads "unknown". The reader lives in
 * session-thread-read.ts.
 */
import type { AgentMessage, AgentMessages } from './agent-messages.js';
import { ownerDisplayName } from '../owner-display.js';
import { jobControlRecordLabel, type JobControlAction, type JobControlLedgerRow } from './job-control-types.js';
import { flatTree, sessionAge, spoke, type LiveSessionRow, type LiveSessionsV1 } from './live-sessions.js';
import type { InboxEntry } from './mason-inbox.js';
import { replyTime, type LeaderRepliesV1 } from './mason-outbox.js';
import type { OrderTraceJob, OrderTraceV1 } from './order-trace.js';
import { prSentence, sessionPr, type SessionThreadPr } from './session-pr.js';
import type { FleetJobActivityV1 } from './runs-job-activity.js';
import type { JobLogScan } from './runs-job-detail.js';
import { sessionReply, type SessionThreadReply } from './session-reply.js';
import { sessionTask, taskWords, type SessionThreadTask } from './session-task.js';
import type { SessionKind, SessionNode, SessionState } from './session-tree.js';

export { sessionReply, type SessionThreadReply } from './session-reply.js';
export { sessionTask, type SessionThreadTask } from './session-task.js';

export const SESSION_THREAD_SCHEMA = 'fleet.session-thread.v1';
/** Session ids: `leader`, a job id such as `RQ-FIX-1`, or a subagent id such as `sa-0123abcd`. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The newest bus messages, commands, changed files and leader replies a thread shows. */
export const THREAD_BUS_SHOWN = 50, THREAD_COMMANDS_SHOWN = 8, THREAD_FILES_SHOWN = 6, THREAD_REPLIES_SHOWN = 5;
/** The newest messages from Mason a thread shows, and how many inbox entries the reader looks through for them. */
export const THREAD_OWNER_SHOWN = 10, THREAD_OWNER_WINDOW = 200;
/** The newest of Mason's messages a worker's thread names as the ones it serves, and the jobs one routing line lists. */
export const THREAD_ORDERS_SHOWN = 3, THREAD_ROUTED_SHOWN = 8;
/** The newest lines of its own log a thread shows, and the longest one of them. */
export const THREAD_OUTPUT_LINES = 12, THREAD_OUTPUT_LINE_CHARS = 240;
/** The newest pause, resume, stop and move requests a thread shows. */
export const THREAD_CONTROLS_SHOWN = 5;

/** How much of each record a thread shows: `recent` is the newest few (the limits above), `full` is as much as the thread's reads hold. */
export type SessionThreadDepth = 'recent' | 'full';
export const SESSION_THREAD_DEPTHS: readonly SessionThreadDepth[] = ['recent', 'full'];
export interface SessionThreadLimits { bus: number; commands: number; files: number; replies: number; owner: number; orders: number; outputLines: number; controls: number }
/** `full` is bounded too: by what each read returns (the inbox window, the end of the log) and by a size a client can draw. */
export const THREAD_LIMITS: Readonly<Record<SessionThreadDepth, SessionThreadLimits>> = {
  recent: { bus: THREAD_BUS_SHOWN, commands: THREAD_COMMANDS_SHOWN, files: THREAD_FILES_SHOWN, replies: THREAD_REPLIES_SHOWN, owner: THREAD_OWNER_SHOWN,
    orders: THREAD_ORDERS_SHOWN, outputLines: THREAD_OUTPUT_LINES, controls: THREAD_CONTROLS_SHOWN },
  full: { bus: 400, commands: 60, files: 60, replies: 40, owner: THREAD_OWNER_WINDOW, orders: 25, outputLines: 120, controls: 40 },
};

/** `quiet` is a running session with no output for the list's quiet window. */
export type SessionThreadState = 'quiet' | SessionState;
export type SessionThreadSource = 'available' | 'none' | 'unavailable';

/** Key order is the JSON contract. */
export interface SessionThreadMessage {
  /** Stable inside one thread: `order:<id>`, `routing:<id>`, `brief`, `step:<n>`, `commands`, `files`, `notes`, `bus:<id>`, `owner:<id>`, `reply:<n>`, `control:<requestId>`, `output`, `latest`. */
  key: string;
  /**
   * `owner` is a message Mason wrote in the Leader inbox: any of them for the leader, the ones aimed `@<job>` for a worker.
   * `order` is the message of Mason's a worker serves, and `routing` lists the jobs serving one message with each job's lane and state.
   * `output` is what the session wrote: the newest lines of its job log, one per line, already redacted.
   * `control` is a pause, resume, stop or move asked of the session's job, with what became of it.
   */
  kind: 'order' | 'routing' | 'brief' | 'step' | 'commands' | 'files' | 'notes' | 'bus' | 'owner' | 'reply' | 'control' | 'output' | 'latest';
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
/** The request that stands for a session's job: the newest one the dispatcher did not turn down. */
export interface SessionThreadControl { action: JobControlAction; lane: string | null; status: 'requested' | 'applied'; at: string }
/** What a session's job has done, as values: the ones the summary's "commands seen, files changed" and "Latest step" sentences state in words. */
export interface SessionThreadWork {
  /** What the ledger records became of the job's pull request (session-pr.ts). Null when no outcome is recorded for it: unknown, not "open". */
  pr: SessionThreadPr | null;
  /** Commands seen in the job's log; null when the log's commands could not be read. */
  commands: number | null;
  /** The job's changed files; `partial` when the change read was degraded. Null when no change read answered. */
  files: { count: number; added: number; removed: number; partial: boolean } | null;
  /** The newest recorded step, `at` as the ledger wrote it (null when it carried no time that parses). Null when no step is recorded. */
  step: { event: string; summary: string; at: string | null } | null;
}
export interface SessionThreadV1 {
  schema: typeof SESSION_THREAD_SCHEMA;
  generatedAt: string;
  id: string;
  /** Null when the session list holds no session with this id (or could not be read: see `sources.sessions`). */
  session: SessionThreadSession | null;
  /** Short sentences assembled from the records. Empty when `session` is null. */
  summary: string[];
  /**
   * What the session's job was asked to do, as one line quoted from its brief (session-task.ts). Null for a session with no job,
   * a job whose activity was not read, and a brief that holds no line past its fleet view: unknown, never a guess.
   */
  task: SessionThreadTask | null;
  /**
   * The conversation in reading order: for a worker the message of Mason's it serves and that message's routing, then brief,
   * recorded steps, commands, changed files, notes, bus messages, Mason's messages, leader replies, control requests, the newest lines of its log, the
   * latest line (left out when the log lines already end with it). For the leader,
   * Mason's messages and the replies are interleaved by time when every one is dated, and a routing line follows each routed message.
   */
  messages: SessionThreadMessage[];
  /** `none` means the read answered and holds nothing for this session; `unavailable` means it could not be read. */
  sources: { sessions: 'available' | 'unavailable'; activity: SessionThreadSource; bus: SessionThreadSource; owner: SessionThreadSource; replies: SessionThreadSource; orders: SessionThreadSource; output: SessionThreadSource; controls: SessionThreadSource };
  /** Plain words for every part the thread could not show. */
  gaps: string[];
  /**
   * What the session's job has done (`sessionWork`), the same answer its entry in `fleet.session-threads.v1` gives. Null for a
   * session with no job, a job whose activity was not asked for, and a failed activity read: `sources.activity` tells those apart.
   */
  work: SessionThreadWork | null;
  /** How to write to this session (session-reply.ts), so every client aims a message the same way. */
  reply: SessionThreadReply;
  /** Null when no request stands (none was made, every one was refused, or the control file was not read). */
  control: SessionThreadControl | null;
  /** How much of each record this read shows (`THREAD_LIMITS`). */
  depth: SessionThreadDepth;
  /** True for a `recent` read that left out something a `full` read of the same records would show. Always false for `full`, whose own omissions are in `gaps`. */
  deeper: boolean;
}

/** What the reader hands the builder. `undefined` means "not asked for" (the session has no job, or is not the leader). */
export interface SessionThreadParts {
  ownerName?: string;
  /** False when the session list itself could not be read. */
  sessionsRead: boolean;
  /** Null when the read failed. */
  activity?: FleetJobActivityV1 | null;
  /** Null when the read failed. */
  bus: AgentMessages | null;
  /** The Leader inbox, newest first (`readInboxEntries`). Null when the read failed; `degraded` reads the same way. */
  owner?: SessionThreadOwnerRead | null;
  /** Null when the read failed. */
  replies?: LeaderRepliesV1 | null;
  /** The order trace: which jobs cite which of Mason's messages. Null when the read failed. */
  orders?: OrderTraceV1 | null;
  /** The end of the session's job log (`scanJobLog`). Null when the read failed; `degraded` reads the same way. */
  output?: SessionThreadOutputRead | null;
  /** The job control file, oldest first (`readJobControlLedger`). Null when the read failed. */
  controls?: readonly JobControlLedgerRow[] | null;
}
/** A bounded read of the end of a job log: scrubbed lines, oldest first. */
export type SessionThreadOutputRead = Pick<JobLogScan, 'source' | 'truncated'> & { lines: readonly string[] };
export interface SessionThreadOwnerRead { sourceState: 'healthy' | 'missing' | 'degraded'; entries: readonly InboxEntry[] }

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

/** The same records, and the same rules, as the summary's "commands seen, files changed" and "Latest step" sentences below. */
export function sessionWork(activity: FleetJobActivityV1 | null | undefined): SessionThreadWork | null {
  if (!activity) return null;
  const files = activity.entries.find(entry => entry.kind === 'files');
  const last = activity.entries.filter(entry => entry.kind === 'event').at(-1);
  return {
    pr: sessionPr(activity),
    commands: activity.sources.commands === 'healthy' ? activity.counts.commands : null,
    files: !files || files.state === 'missing' ? null
      : { count: files.totals.files, added: files.totals.added, removed: files.totals.removed, partial: files.state === 'degraded' },
    step: last ? { event: last.event, summary: last.summary, at: last.at && Number.isFinite(Date.parse(last.at)) ? last.at : null } : null,
  };
}

function summaryOf(session: SessionThreadSession, node: SessionNode, row: LiveSessionRow | undefined, activity: FleetJobActivityV1 | null | undefined, aimed: readonly InboxEntry[], routed: readonly string[], ownerLabel: string): string[] {
  const kind = session.kind === 'subagent' ? 'Helper' : session.kind === 'leader' ? 'Leader' : 'Worker';
  const lines = [`${kind} on ${named('lane', session.lane)}, ${named('model', session.model)}, in ${named('repo', session.repo)}.`, ...routed];
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
    const pr = sessionPr(activity);
    if (pr) lines.push(prSentence(pr));
  }
  // The inbox is the Leader's: an aimed message is on record there, and nothing records the worker reading it.
  if (session.kind === 'worker' && aimed.length > 0) {
    const newest = ownerAt(aimed.at(-1)!);
    lines.push(`${ownerLabel} aimed ${plural(aimed.length, 'message')} at it through the Leader inbox${newest ? `, the newest at ${newest}` : ''}.`);
  }
  return lines;
}

/** An inbox entry's time as ISO. The inbox keeps Eastern wall time to the minute; anything else reads as no time. */
function ownerAt(entry: Pick<InboxEntry, 'at'>): string | null {
  const at = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(entry.at) ? replyTime(entry.at) : Number.NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/**
 * Mason's Leader inbox messages for one session, oldest first: every one for the leader, the ones aimed
 * `@<job>` for a worker (the mention the desktop reply boxes write), none for a helper. `entries` is newest first.
 */
export function sessionOwnerMessages(session: Pick<SessionThreadSession, 'kind' | 'jobId'>, entries: readonly InboxEntry[]): InboxEntry[] {
  if (session.kind === 'leader') return [...entries].reverse();
  if (session.kind !== 'worker' || session.jobId === null) return [];
  const aimed = new RegExp(`(?:^|\\s)@${session.jobId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`);
  return entries.filter(entry => aimed.test(entry.text)).reverse();
}

type TracedOrder = OrderTraceV1['orders'][number];
const ORDER_STATES = ['merged', 'published', 'launched', 'queued'] as const;
/** The trace builds each order from one inbox entry and copies these three fields from it. */
const orderOf = (orders: readonly TracedOrder[], entry: InboxEntry) =>
  orders.find(order => order.at === entry.at && order.source === entry.source && order.requestId === entry.requestId);
/** The inbox heading's own wall time, which is Eastern. */
const orderTime = (order: TracedOrder) => (/ ET$/.test(order.at) ? order.at : `${order.at} ET`);

/** One job of an order: where the Leader's routing sent it and how far it got. The trace's own state words. */
function routedLine(job: OrderTraceJob, self: string | null): string {
  const state = job.endedEmptyAt ? `${job.state}, then ended with nothing to publish` : job.state;
  return `${job.id}${job.id === self ? ' (this session)' : ''}, ${job.lane === null ? 'lane unknown' : `on ${job.lane}`}: ${state}${job.url ? ` ${job.url}` : ''}`;
}

function routingMessage(key: string, order: TracedOrder, self: string | null): SessionThreadMessage {
  const { jobs } = order;
  return {
    key: `routing:${key}`, kind: 'routing', side: 'record', label: `Routed to ${plural(jobs.length, 'job')}`, at: null, format: 'plain',
    text: [...jobs.slice(0, THREAD_ROUTED_SHOWN).map(job => routedLine(job, self)),
      ...(jobs.length > THREAD_ROUTED_SHOWN ? [`and ${jobs.length - THREAD_ROUTED_SHOWN} more`] : [])].join('\n'),
  };
}

/** The lines of a job log worth showing: blank ones dropped, the newest `shown` (THREAD_OUTPUT_LINES unless told) kept, each cut to THREAD_OUTPUT_LINE_CHARS. */
export function sessionOutputLines(lines: readonly string[], shown: number = THREAD_OUTPUT_LINES): { lines: string[]; earlier: number } {
  const written = lines.map(line => line.trimEnd()).filter(line => line.trim() !== '');
  return { earlier: Math.max(0, written.length - shown),
    lines: written.slice(-shown).map(line => (line.length > THREAD_OUTPUT_LINE_CHARS ? `${line.slice(0, THREAD_OUTPUT_LINE_CHARS - 1)}…` : line)) };
}

/** The bus messages about one session, oldest first: the ones naming its job, or sent by or to it. */
export function sessionBusMessages(session: Pick<SessionThreadSession, 'id' | 'jobId'>, messages: readonly AgentMessage[]): AgentMessage[] {
  const id = session.id.toLowerCase();
  return messages.filter(m => (session.jobId !== null && m.job === session.jobId) || m.from.name.toLowerCase() === id || m.to.name.toLowerCase() === id)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** `cut` is whether more commands or changed files are on record than `limits` lets through. */
function activityMessages(activity: FleetJobActivityV1, limits: SessionThreadLimits): { messages: SessionThreadMessage[]; cut: boolean } {
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
    label: commands.length > limits.commands ? `Ran ${plural(commands.length, 'command')}, last ${limits.commands} shown` : `Ran ${plural(commands.length, 'command')}`,
    text: commands.slice(-limits.commands).map(command => command.text).join('\n'),
  });
  const files = entries.find(entry => entry.kind === 'files');
  // The activity read lists a bounded number of files itself; only what it lists can be shown.
  const listed = files?.kind === 'files' ? files.files.slice(0, limits.files) : [];
  if (files?.kind === 'files' && files.state !== 'missing' && files.totals.files > 0) out.push({
    key: 'files', kind: 'files', side: 'session', at: null, format: 'mono',
    label: `Changed ${plural(files.totals.files, 'file')}, +${files.totals.added} −${files.totals.removed}${files.state === 'degraded' ? ', partial' : ''}`,
    text: [...listed.map(file => file.path),
      ...(files.totals.files > listed.length ? [`and ${files.totals.files - listed.length} more`] : [])].join('\n'),
  });
  if (notes) out.push({ key: 'notes', kind: 'notes', side: 'session', label: `Notes${notes.truncated ? ' (truncated)' : ''}`, at: null, text: notes.text, format: 'markdown' });
  return { messages: out, cut: commands.length > limits.commands || (files?.kind === 'files' && files.files.length > limits.files) };
}

/**
 * The thread for session `id` in `list`. A session the list does not hold gives `session: null`, never an invented one.
 * `depth` chooses the limits; the parts are the same either way, so `full` shows more of what was read, never another source.
 */
export function buildSessionThread(list: LiveSessionsV1, id: string, parts: SessionThreadParts, now: number, depth: SessionThreadDepth = 'recent'): SessionThreadV1 {
  const node = flatTree(list.tree.roots).map(entry => entry.node).find(entry => entry.id === id && entry.kind !== 'unknown-parent');
  const base = { schema: SESSION_THREAD_SCHEMA, generatedAt: new Date(now).toISOString(), id } as const;
  if (!node) {
    return { ...base, session: null, summary: [], task: null, messages: [],
      sources: { sessions: parts.sessionsRead ? 'available' : 'unavailable', activity: 'none', bus: 'none', owner: 'none', replies: 'none', orders: 'none', output: 'none', controls: 'none' },
      gaps: [parts.sessionsRead ? `No session ${id} in the list. Finished sessions stay for an hour.` : 'Sessions unknown: the session list could not be read.'], work: null, reply: sessionReply(null), control: null, depth, deeper: false };
  }
  const row = node.jobId === null ? undefined : list.sessions.find(entry => entry.job === node.jobId);
  const session = sessionOf(node, row), leader = session.kind === 'leader';
  const ownerName = ownerDisplayName(parts.ownerName);
  const ownerLabel = ownerName === 'the owner' ? 'The owner' : ownerName;
  const gaps: string[] = [], messages: SessionThreadMessage[] = [];
  const limits = THREAD_LIMITS[depth];
  // Set wherever a limit leaves something out, so a `recent` read can say a deeper one holds more.
  let cut = false;

  let activity: SessionThreadSource = 'none';
  if (parts.activity === null) { activity = 'unavailable'; gaps.push('Activity unknown: this session\'s recorded activity could not be read.'); }
  else if (parts.activity) {
    const recorded = activityMessages(parts.activity, limits);
    messages.push(...recorded.messages);
    activity = recorded.messages.length > 0 ? 'available' : 'none';
    if (recorded.cut) cut = true;
    if (parts.activity.truncated) gaps.push('Older activity is outside the recorded window.');
  }

  let bus: SessionThreadSource = 'none';
  if (parts.bus === null || parts.bus.source === 'unavailable') { bus = 'unavailable'; gaps.push('Bus messages unknown: the agent bus could not be read.'); }
  else {
    const about = sessionBusMessages(session, parts.bus.messages);
    if (about.length > limits.bus) { cut = true; gaps.push(`${plural(about.length - limits.bus, 'earlier bus message')} not shown.`); }
    for (const m of about.slice(-limits.bus)) messages.push({
      key: `bus:${m.id}`, kind: 'bus', side: m.from.name.toLowerCase() === id.toLowerCase() ? 'session' : 'other',
      label: `${m.from.name} to ${m.to.name}, ${m.kind}`, at: when(m.ts), text: m.summary, format: 'plain',
    });
    if (about.length > 0) bus = 'available';
  }

  // Mason's side of the conversation. A missing inbox file is an inbox nobody has written to yet.
  let owner: SessionThreadSource = 'none', aimed: InboxEntry[] = [];
  const said: SessionThreadMessage[] = [];
  if (parts.owner === null || parts.owner?.sourceState === 'degraded') { owner = 'unavailable'; gaps.push(`Messages from ${ownerName} unknown: the Leader inbox could not be read.`); }
  else if (parts.owner) {
    aimed = sessionOwnerMessages(session, parts.owner.entries);
    if (aimed.length > limits.owner) {
      cut = true;
      gaps.push(leader ? `Earlier messages from ${ownerName} are not shown here; the Leader chat holds them.` : `${plural(aimed.length - limits.owner, 'earlier message')} from ${ownerName} not shown.`);
    }
    aimed.slice(-limits.owner).forEach((entry, index) => said.push({
      key: `owner:${entry.id ?? `${entry.at}#${index}`}`, kind: 'owner', side: 'other', at: ownerAt(entry), text: entry.text, format: 'plain',
      label: `${leader ? `${ownerLabel} to Leader` : `${ownerLabel} to the Leader, aimed at ${session.jobId}`}${entry.channel ? `, from ${entry.channel}` : ''}`,
    }));
    if (aimed.length > 0) owner = 'available';
  }

  let replies: SessionThreadSource = 'none';
  const answered: SessionThreadMessage[] = [];
  if (leader) {
    if (parts.replies === null || parts.replies?.sourceState === 'unknown') { replies = 'unavailable'; gaps.push('Leader replies unknown: the plan log could not be read.'); }
    else if (parts.replies) {
      // Newest first in the read; a conversation reads oldest first.
      if (parts.replies.replies.length > limits.replies) cut = true;
      [...parts.replies.replies.slice(0, limits.replies)].reverse().forEach((reply, index) => answered.push({
        key: `reply:${index}`, kind: 'reply', side: 'session', label: `Leader to ${ownerName}`, at: reply.at === 'unknown' || reply.at === '' ? null : reply.at, text: reply.text, format: 'plain',
      }));
      if (parts.replies.replies.length > 0) replies = 'available';
    }
  }
  // Where the work went. The trace ties a job to a message only when the job's prompt cites that message's time.
  let orders: SessionThreadSource = 'none';
  const routedAfter = new Map<SessionThreadMessage, SessionThreadMessage>(), origin: SessionThreadMessage[] = [], routed: string[] = [];
  const trace = parts.orders;
  if (trace === null || trace?.sources.inbox === 'degraded') { orders = 'unavailable'; gaps.push('Routing unknown: the order trace could not be read.'); }
  else if (trace) {
    if (trace.sources.prompts === 'degraded') gaps.push('Routing may be incomplete: not every job prompt could be read.');
    if (leader) {
      const jobs = new Map<string, OrderTraceJob>();
      aimed.slice(-limits.owner).forEach((entry, index) => {
        const order = orderOf(trace.orders, entry);
        if (!order || order.jobs.length === 0) return;
        routedAfter.set(said[index]!, routingMessage(said[index]!.key.slice('owner:'.length), order, null));
        for (const job of order.jobs) jobs.set(job.id, job);
      });
      if (routedAfter.size > 0) {
        const states = ORDER_STATES.map(state => [state, [...jobs.values()].filter(job => job.state === state).length] as const).filter(([, count]) => count > 0);
        routed.push(`Routed ${routedAfter.size} of the ${plural(said.length, 'message')} shown from ${ownerName} to ${plural(jobs.size, 'job')}: ${states.map(([state, count]) => `${count} ${state}`).join(', ')}.`);
      }
    } else if (session.jobId !== null) {
      // Newest first in the trace, like the inbox it is built from.
      const serves = trace.orders.filter(order => order.jobs.some(job => job.id === session.jobId)).reverse();
      if (serves.length > limits.orders) { cut = true; gaps.push(`${plural(serves.length - limits.orders, 'earlier message')} from ${ownerName} that this session serves not shown.`); }
      for (const order of serves.slice(-limits.orders)) {
        const entry = parts.owner?.entries.find(candidate => orderOf([order], candidate) !== undefined);
        const key = entry?.id ?? `${order.at}#${order.source}`, from = entry?.channel ?? order.source;
        origin.push(entry
          ? { key: `order:${key}`, kind: 'order', side: 'other', label: `${ownerLabel} to the Leader, served by ${session.jobId}${from ? `, from ${from}` : ''}`, at: ownerAt(entry), text: entry.text, format: 'plain' }
          : { key: `order:${key}`, kind: 'order', side: 'record', label: `Serves ${ownerName}'s message of ${orderTime(order)}${from ? `, from ${from}` : ''}`, at: ownerAt(order),
            text: 'Its text is not among the inbox messages this thread read.', format: 'plain' });
        if (order.jobs.length > 1) origin.push(routingMessage(key, order, session.jobId));
      }
      const newest = serves.at(-1);
      if (newest) {
        const others = newest.jobs.length - 1;
        routed.push(serves.length > 1 ? `Serves ${serves.length} of ${ownerName}'s messages, the newest of ${orderTime(newest)}.`
          : `Serves ${ownerName}'s message of ${orderTime(newest)}${others > 0 ? `, with ${plural(others, 'other job')}` : ''}.`);
      }
    }
    if (routedAfter.size > 0 || origin.length > 0) orders = 'available';
  }
  messages.unshift(...origin);

  // Question then answer, when every line carries a time; otherwise each side keeps its own order, Mason first.
  const spoken = [...said, ...answered], times = spoken.map(m => (m.at === null ? Number.NaN : replyTime(m.at)));
  const ordered = said.length > 0 && answered.length > 0 && times.every(Number.isFinite)
    ? spoken.map((m, index) => ({ m, index })).sort((a, b) => times[a.index]! - times[b.index]! || a.index - b.index).map(entry => entry.m)
    : spoken;
  for (const m of ordered) { messages.push(m); const routing = routedAfter.get(m); if (routing) messages.push(routing); }

  // What was asked of the job itself. A request is on record once it is written; only the dispatcher's line says it was applied.
  let controls: SessionThreadSource = 'none', control: SessionThreadControl | null = null;
  const steered: string[] = [];
  if (parts.controls === null) { controls = 'unavailable'; gaps.push('Controls unknown: the job control record could not be read.'); }
  else if (parts.controls && session.jobId !== null) {
    const asked = parts.controls.filter(row => row.job === session.jobId);
    if (asked.length > limits.controls) { cut = true; gaps.push(`${plural(asked.length - limits.controls, 'earlier control request')} not shown.`); }
    for (const row of asked.slice(-limits.controls)) messages.push({
      key: `control:${row.requestId}`, kind: 'control', side: 'record', label: jobControlRecordLabel(row), at: when(row.at), format: 'plain',
      text: `${row.by ? `Asked from ${row.by}. ` : ''}${row.status === 'applied' ? 'Done.' : row.status === 'refused' ? row.reason ?? 'Refused.' : PENDING_CONTROL}`,
    });
    const stands = asked.filter(row => row.status === 'requested' || row.status === 'applied').at(-1);
    if (stands) {
      control = { action: stands.action, lane: stands.lane, status: stands.status === 'applied' ? 'applied' : 'requested', at: stands.at };
      steered.push(control.status === 'applied' ? `${jobControlRecordLabel(stands)} by request${when(stands.at) ? ` at ${stands.at}` : ''}.`
        : `${jobControlRecordLabel(stands)}${when(stands.at) ? ` at ${stands.at}` : ''}. ${PENDING_CONTROL}`);
    }
    if (asked.length > 0) controls = 'available';
  }

  // What the session itself wrote: the end of its log. The log has no clock per line, so the message carries no time.
  let output: SessionThreadSource = 'none', wrote: string[] = [];
  if (parts.output === null || parts.output?.source === 'degraded') { output = 'unavailable'; gaps.push('Output unknown: this session\'s log could not be read.'); }
  else if (parts.output && parts.output.source !== 'missing') {
    const { lines, earlier } = sessionOutputLines(parts.output.lines, limits.outputLines);
    wrote = lines;
    if (earlier > 0) cut = true;
    if (lines.length > 0) {
      output = 'available';
      messages.push({ key: 'output', kind: 'output', side: 'session', at: null, text: lines.join('\n'), format: 'mono',
        label: `Output${parts.output.source === 'archived' ? ', from its archived log' : ''}, ${earlier > 0 || parts.output.truncated ? `last ${plural(lines.length, 'line')} of its log` : plural(lines.length, 'line')}` });
    } else if (parts.output.source === 'archived' && parts.output.truncated) { output = 'unavailable'; gaps.push('Output not shown: the archived log is too large to read here.'); }
  }

  // The latest line is the last line of the log; when the output above already ends with it, it is not said twice.
  const repeated = node.lastMessage !== null && wrote.length > 0 && wrote.at(-1)!.startsWith(node.lastMessage.replace(/…$/, ''));
  if (node.lastMessage !== null && !repeated) messages.push({ key: 'latest', kind: 'latest', side: 'session', label: 'Latest', at: when(node.lastMessageAt), text: node.lastMessage, format: 'plain' });
  if (session.jobId === null && !leader) gaps.push('This session has no job record: its steps, commands and changed files are not recorded.');
  return { ...base, session, summary: [...summaryOf(session, node, row, parts.activity, aimed, routed, ownerLabel), ...steered],
    task: session.jobId !== null ? sessionTask(parts.activity, session.jobId) : null, messages,
    sources: { sessions: 'available', activity, bus, owner, replies, orders, output, controls }, gaps,
    work: session.jobId !== null ? sessionWork(parts.activity) : null, reply: sessionReply(session), control, depth, deeper: depth === 'recent' && cut };
}

const PENDING_CONTROL = 'The dispatcher has not applied it yet.';
const SIDE_MARK: Readonly<Record<SessionThreadMessage['side'], string>> = { session: '<', other: '>', record: '-' };

/** `phm sessions thread <id>` for people: the summary, then one block per message. `>` is said to the session, `<` is the session, `-` is a recorded step. */
export function renderSessionThreadText(thread: SessionThreadV1): string {
  if (!thread.session) return thread.gaps.join('\n');
  const { session } = thread;
  const lines = [`${session.id} | ${session.kind} | ${session.state === 'unknown' ? 'state unknown' : session.state}`,
    ...(thread.task ? [`  ${taskWords(thread.task)}`] : []), ...thread.summary.map(line => `  ${line}`), ''];
  if (thread.messages.length === 0) lines.push('Nothing is recorded for this session yet.');
  for (const message of thread.messages) {
    lines.push(`${SIDE_MARK[message.side]} ${message.label}${message.at ? ` [${message.at}]` : ''}`);
    for (const line of message.text.split('\n')) lines.push(`    ${line}`);
  }
  if (thread.gaps.length > 0 || thread.deeper) lines.push('');
  for (const gap of thread.gaps) lines.push(`note: ${gap}`);
  if (thread.deeper) lines.push(`note: Earlier entries are on record. Show them: phm sessions thread ${session.id} --all`);
  lines.push(`To write to it: ${thread.reply.hint}`);
  lines.push(`${session.jobId === null ? '' : `Full log: phm sessions tail ${session.jobId}. `}Every session: phm sessions. Updated ${thread.generatedAt}.`);
  return lines.join('\n');
}
